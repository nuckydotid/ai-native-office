import { create } from 'zustand';
import { PROTOCOL_VERSION, type AgentStatus, type HistoryCursor } from '../shared/workspace/protocol.ts';
import type { ChatMessage, PlayerState, SessionInfo, WorkspaceRole } from '../shared/workspace/types.ts';
import { CHAT_CAP, applyWelcomeTail, dropBefore, isFromOthers, markDeleted, mergeKnown, mergeMessages, trimOldest } from './core/chatlog.ts';
import type { ConnStatus } from './net/room.ts';

export interface RoomChatView {
  chat: ChatMessage[];
  historyHasMore: boolean;
  loaded: boolean;
}

interface OfficeState {
  status: ConnStatus;
  officeName: string;
  you: string | null;
  role: WorkspaceRole;
  /** Who is in the office. Positions here go stale on purpose; the picture reads the live ones. */
  people: PlayerState[];
  /** The room the person is standing in. */
  zone: string | null;
  /** The id of the room the person is in, e.g. 'lobby', 'design'. */
  roomId: string;
  /** Active and archived sessions in the office. */
  sessions: SessionInfo[];
  /** Cached chat lists and state keyed by room id. */
  views: Record<string, RoomChatView>;
  /** Protocol version the server reports speaking. */
  serverProtocol: number;
  viewingSessionId: string | null;
  notice: string | null;

  /** The Room conversation, oldest first: the latest messages plus whatever "Load earlier" has brought in. */
  chat: ChatMessage[];
  /** There are older messages in the team database than the first one in `chat`. */
  historyHasMore: boolean;
  loadingEarlier: boolean;
  /** True once the server has sent the conversation at least once. */
  loaded: boolean;
  /** Goes up when the list was thrown away and started again, so the screen jumps to the newest message. */
  restarts: number;
  /** Agents that are working on an answer (waiting for their turn, or thinking), oldest first. */
  pending: AgentStatus[];
  /** The agent runs this window started and is working on, as `<question id>:<handle>`: the ones it can stop. */
  myRuns: string[];
  /** The agent answer this person's agent just posted, which they may take back until `until`. */
  undo: { id: string; until: number; name: string } | null;
  /** Whether the Office page is on screen. */
  visible: boolean;
  /** Whether the person is reading the newest messages. While they are reading further up, the oldest are not trimmed away. */
  atBottom: boolean;
  /** Messages from others that arrived while the page was hidden. */
  hiddenUnread: number;

  begin(): void;
  /** The visit is over: nothing about it is kept (the sidebar's count of unread messages included). */
  end(): void;
  setStatus(status: ConnStatus): void;
  welcome(info: { you: string; officeName: string; role: WorkspaceRole; people: PlayerState[]; history: ChatMessage[]; historyHasMore: boolean; thinking: AgentStatus[]; room?: string; sessions?: SessionInfo[]; protocol?: number }): void;
  setPeople(people: PlayerState[]): void;
  setRole(role: WorkspaceRole): void;
  openRoom(roomId: string): void;
  viewSession(sessionId: string | null): void;
  updateSession(session: SessionInfo): void;
  removeSession(id: string, room: string): void;
  addChat(msg: ChatMessage): void;
  /** A card message changed (a proposal was accepted or dismissed): its new card, wherever the message is held. */
  updateCard(id: string, ui: ChatMessage['ui']): void;
  /** `from` is the oldest message the page was asked to continue from; a page for a list that has since lost it is dropped. */
  addPage(messages: ChatMessage[], hasMore: boolean, from?: HistoryCursor, room?: string, session?: string): void;
  /** Applies a check page to the messages already held (a removal that happened while the person was away); it adds nothing new. */
  mergeChecked(messages: ChatMessage[]): void;
  /** Forgets everything older than the cursor, and offers "Load earlier" again. */
  dropOlderThan(cursor: HistoryCursor): void;
  setAtBottom(atBottom: boolean): void;
  deleteChat(id: string): void;
  setLoadingEarlier(loading: boolean): void;
  setAgentStatus(status: AgentStatus): void;
  setMyRuns(keys: string[]): void;
  setUndo(undo: { id: string; until: number; name: string } | null): void;
  setVisible(visible: boolean): void;
  setZone(zone: string | null): void;
  setNotice(notice: string | null): void;
}

const initial = {
  status: { state: 'connecting' } as ConnStatus,
  officeName: '',
  you: null,
  role: 'guest' as WorkspaceRole,
  people: [] as PlayerState[],
  zone: null,
  roomId: 'lobby',
  sessions: [] as SessionInfo[],
  views: {} as Record<string, RoomChatView>,
  serverProtocol: PROTOCOL_VERSION,
  viewingSessionId: null as string | null,
  notice: null,
  chat: [] as ChatMessage[],
  historyHasMore: false,
  loadingEarlier: false,
  loaded: false,
  restarts: 0,
  pending: [] as AgentStatus[],
  myRuns: [] as string[],
  undo: null as { id: string; until: number; name: string } | null,
  hiddenUnread: 0,
  atBottom: true,
};

const working = (s: AgentStatus) => s.state === 'queued' || s.state === 'thinking';

/** The office screen's state, in one place (like the Git view's store). The picture itself reads the live world instead. */
export const useOffice = create<OfficeState>((set) => ({
  ...initial,
  visible: true,
  begin: () => set((s) => ({ ...initial, visible: s.visible })),
  end: () => set({ hiddenUnread: 0, visible: true, atBottom: true }),
  setStatus: (status) => set({ status }),
  welcome: ({ you, officeName, role, people, history, historyHasMore, thinking, room = 'lobby', sessions = [], protocol = PROTOCOL_VERSION }) =>
    set((s) => {
      const activeRoom = room || s.roomId || 'lobby';
      const next = applyWelcomeTail({ chat: s.chat, historyHasMore: s.historyHasMore }, history, historyHasMore);
      // Messages that came while the person was away and the page was hidden count as unread too (not the first welcome: that is the whole list).
      const known = new Set(s.chat.map((m) => m.id));
      const unseen = s.loaded && !s.visible && !next.replaced ? history.filter((m) => !known.has(m.id) && isFromOthers(m, you)).length : 0;
      const views = {
        ...s.views,
        [activeRoom]: {
          chat: next.chat,
          historyHasMore: next.historyHasMore,
          loaded: true,
        },
      };
      return {
        you, officeName, role, people, loaded: true, loadingEarlier: false,
        roomId: activeRoom, viewingSessionId: null, sessions, serverProtocol: protocol, views,
        chat: next.chat, historyHasMore: next.historyHasMore, restarts: s.restarts + (next.replaced ? 1 : 0),
        ...(unseen ? { hiddenUnread: s.hiddenUnread + unseen } : {}),
        // What is being worked on is whatever the server says it is now; the app's own memory of it may be out of date.
        pending: thinking.filter(working),
      };
    }),
  setPeople: (people) => set({ people }),
  setRole: (role) => set({ role }),
  openRoom: (roomId) =>
    set((s) => {
      if (roomId === s.roomId && !s.viewingSessionId) return {};
      const views = s.viewingSessionId
        ? s.views
        : {
            ...s.views,
            [s.roomId]: {
              chat: s.chat,
              historyHasMore: s.historyHasMore,
              loaded: s.loaded,
            },
          };
      const cached = views[roomId];
      return {
        roomId,
        viewingSessionId: null,
        views,
        chat: cached?.chat ?? [],
        historyHasMore: cached?.historyHasMore ?? false,
        loaded: cached?.loaded ?? false,
        loadingEarlier: false,
        restarts: s.restarts + 1,
      };
    }),
  viewSession: (sessionId) =>
    set((s) => {
      if (sessionId === s.viewingSessionId) return {};
      if (!sessionId) {
        const cached = s.views[s.roomId];
        return {
          viewingSessionId: null,
          chat: cached?.chat ?? [],
          historyHasMore: cached?.historyHasMore ?? false,
          loaded: cached?.loaded ?? false,
          loadingEarlier: false,
          restarts: s.restarts + 1,
        };
      }
      return {
        viewingSessionId: sessionId,
        chat: [],
        historyHasMore: true,
        loaded: false,
        loadingEarlier: false,
        restarts: s.restarts + 1,
      };
    }),
  updateSession: (session) =>
    set((s) => {
      const idx = s.sessions.findIndex((x) => x.id === session.id);
      const sessions = idx >= 0 ? s.sessions.map((x, i) => (i === idx ? session : x)) : [...s.sessions, session];
      let views = s.views;
      let chat = s.chat;
      let historyHasMore = s.historyHasMore;
      let restarts = s.restarts;
      if (idx < 0 && session.state === 'active') {
        views = {
          ...s.views,
          [session.room]: {
            chat: [],
            historyHasMore: false,
            loaded: true,
          },
        };
        if (s.roomId === session.room && !s.viewingSessionId) {
          chat = [];
          historyHasMore = false;
          restarts += 1;
        }
      }
      return { sessions, views, chat, historyHasMore, restarts };
    }),
  removeSession: (id, room) =>
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      const filterChat = (list: ChatMessage[]) => list.filter((m) => m.session !== id);
      const views = { ...s.views };
      if (views[room]) {
        views[room] = {
          ...views[room],
          chat: filterChat(views[room].chat),
        };
      }
      let chat = s.chat;
      let viewingSessionId = s.viewingSessionId;
      if (s.viewingSessionId === id) {
        viewingSessionId = null;
        const live = views[s.roomId];
        chat = live?.chat ?? [];
      } else if (s.roomId === room) {
        chat = filterChat(s.chat);
      }
      return { sessions, views, chat, viewingSessionId };
    }),
  addChat: (msg) =>
    set((s) => {
      const msgRoom = msg.room ?? s.roomId;
      const isCurrentLiveRoom = msgRoom === s.roomId && !s.viewingSessionId;

      if (!isCurrentLiveRoom) {
        const view = s.views[msgRoom];
        if (!view) return {};
        const merged = mergeMessages(view.chat, [msg]);
        if (merged === view.chat) return {};
        const { list, trimmed } = trimOldest(merged);
        return {
          views: {
            ...s.views,
            [msgRoom]: {
              ...view,
              chat: list,
              historyHasMore: view.historyHasMore || trimmed,
            },
          },
        };
      }

      const merged = mergeMessages(s.chat, [msg]);
      if (merged === s.chat) return {};
      const { list, trimmed } = s.atBottom || merged.length > CHAT_CAP + 500 ? trimOldest(merged) : { list: merged, trimmed: false };
      const fresh = !s.chat.some((m) => m.id === msg.id);
      const unread = !s.visible && fresh && isFromOthers(msg, s.you);
      const nextViews = {
        ...s.views,
        [s.roomId]: {
          chat: list,
          historyHasMore: s.historyHasMore || trimmed,
          loaded: s.loaded,
        },
      };
      return {
        chat: list,
        historyHasMore: s.historyHasMore || trimmed,
        views: nextViews,
        ...(unread ? { hiddenUnread: s.hiddenUnread + 1 } : {}),
      };
    }),
  updateCard: (id, ui) =>
    set((s) => {
      const apply = (list: ChatMessage[]) => list.map((m) => (m.id === id ? { ...m, ui } : m));
      const views = Object.fromEntries(Object.entries(s.views).map(([room, v]) => [room, { ...v, chat: apply(v.chat) }]));
      return { chat: apply(s.chat), views };
    }),
  addPage: (messages, hasMore, from, room, session) =>
    set((s) => {
      if (s.viewingSessionId) {
        if (session && session !== s.viewingSessionId) return { loadingEarlier: false };
        if (from && (s.chat[0]?.id !== from.id || s.chat[0].at !== from.at)) return { loadingEarlier: false };
        return {
          chat: mergeMessages(s.chat, messages),
          historyHasMore: hasMore,
          loaded: true,
          loadingEarlier: false,
        };
      }
      const targetRoom = room ?? s.roomId;
      if (targetRoom !== s.roomId) {
        const view = s.views[targetRoom];
        if (!view) return { loadingEarlier: false };
        if (from && (view.chat[0]?.id !== from.id || view.chat[0].at !== from.at)) return {};
        return {
          views: {
            ...s.views,
            [targetRoom]: {
              ...view,
              chat: mergeMessages(view.chat, messages),
              historyHasMore: hasMore,
              loaded: true,
            },
          },
        };
      }
      if (from && (s.chat[0]?.id !== from.id || s.chat[0].at !== from.at)) return { loadingEarlier: false };
      const nextChat = mergeMessages(s.chat, messages);
      return {
        chat: nextChat,
        historyHasMore: hasMore,
        loaded: true,
        loadingEarlier: false,
        views: {
          ...s.views,
          [s.roomId]: {
            chat: nextChat,
            historyHasMore: hasMore,
            loaded: true,
          },
        },
      };
    }),
  mergeChecked: (messages) =>
    set((s) => {
      const chat = mergeKnown(s.chat, messages);
      return {
        chat,
        views: {
          ...s.views,
          [s.roomId]: {
            ...(s.views[s.roomId] ?? { loaded: true, historyHasMore: s.historyHasMore }),
            chat,
          },
        },
      };
    }),
  dropOlderThan: (cursor) =>
    set((s) => {
      const chat = dropBefore(s.chat, cursor);
      return {
        chat,
        historyHasMore: true,
        views: {
          ...s.views,
          [s.roomId]: {
            ...(s.views[s.roomId] ?? { loaded: true }),
            chat,
            historyHasMore: true,
          },
        },
      };
    }),
  setAtBottom: (atBottom) =>
    set((s) => {
      if (atBottom === s.atBottom) return {};
      if (!atBottom) return { atBottom };
      const { list, trimmed } = trimOldest(s.chat);
      const historyHasMore = s.historyHasMore || trimmed;
      const views = {
        ...s.views,
        [s.roomId]: {
          ...(s.views[s.roomId] ?? { loaded: true }),
          chat: list,
          historyHasMore,
        },
      };
      return trimmed ? { atBottom, chat: list, historyHasMore, views } : { atBottom };
    }),
  deleteChat: (id) =>
    set((s) => {
      const chat = markDeleted(s.chat, id);
      const views = { ...s.views };
      for (const r of Object.keys(views)) {
        if (views[r].chat.some((m) => m.id === id)) {
          views[r] = { ...views[r], chat: markDeleted(views[r].chat, id) };
        }
      }
      return { chat, views };
    }),
  setLoadingEarlier: (loadingEarlier) => set({ loadingEarlier }),
  setAgentStatus: (status) =>
    set((s) => {
      const rest = s.pending.filter((p) => p.runId !== status.runId);
      if (!working(status)) return rest.length === s.pending.length ? {} : { pending: rest };
      const i = s.pending.findIndex((p) => p.runId === status.runId);
      if (i < 0) return { pending: [...s.pending, status] };
      const pending = [...s.pending];
      pending[i] = status;
      return { pending };
    }),
  setMyRuns: (myRuns) => set({ myRuns }),
  setUndo: (undo) => set({ undo }),
  setVisible: (visible) => set(visible ? { visible, hiddenUnread: 0 } : { visible }),
  setZone: (zone) => set({ zone }),
  setNotice: (notice) => set({ notice }),
}));
