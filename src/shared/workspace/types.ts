/**
 * Shared virtual-workspace world model.
 *
 * Imported by both the web app and the office server, so it
 * must stay free of DOM / Node specific APIs.
 */

export const TILE = 32;

export type Dir = 'down' | 'left' | 'right' | 'up';
export type PresenceStatus = 'available' | 'focus' | 'meeting' | 'away';
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';

export interface Vec {
  x: number;
  y: number;
}

/* ───────────────────────── Map ───────────────────────── */

/** Floor tile ids (0 = void, not walkable). */
export const Floor = {
  Void: 0,
  Wood: 1,
  DarkWood: 2,
  CarpetBlue: 3,
  CarpetPurple: 4,
  CarpetGreen: 5,
  TileLight: 6,
  Concrete: 7,
  Grass: 8,
  Path: 9,
  CarpetWarm: 10,
} as const;
export type FloorId = (typeof Floor)[keyof typeof Floor];
export const FLOOR_IDS = Object.values(Floor) as number[];

/** Wall tile ids (0 = none). All non-zero walls block movement. */
export const Wall = {
  None: 0,
  Plaster: 1,
  Glass: 2,
  Hedge: 3,
  Brick: 4,
} as const;
export type WallId = (typeof Wall)[keyof typeof Wall];
export const WALL_IDS = Object.values(Wall) as number[];

export type ZoneKind = 'open' | 'private' | 'lounge' | 'outdoor' | 'lobby';

export interface MapZone {
  id: string;
  name: string;
  kind: ZoneKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Accent colour (hex) used for floor labels and the minimap. */
  color: string;
  /** Private zones isolate proximity chat from everyone outside the zone. */
  private?: boolean;
}

export type PropKind =
  | 'desk'
  | 'chair'
  | 'plant'
  | 'plantBig'
  | 'tree'
  | 'sofa'
  | 'coffeeBar'
  | 'roundTable'
  | 'meetingTable'
  | 'whiteboard'
  | 'branchBoard'
  | 'bookshelf'
  | 'fountain'
  | 'lamp'
  | 'rugBlue'
  | 'rugWarm'
  | 'terminal'
  | 'cooler'
  | 'reception'
  | 'window'
  | 'poster';

export interface MapProp {
  id: string;
  kind: PropKind;
  /** Top-left tile of the footprint. */
  x: number;
  y: number;
  /** Visual variant (accent colour index etc.). */
  variant?: number;
  label?: string;
}

export interface WorkspaceMap {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Row-major floor ids, length = width * height. */
  floor: number[];
  /** Row-major wall ids, length = width * height. */
  wall: number[];
  zones: MapZone[];
  props: MapProp[];
  spawns: Vec[];
}

/* ───────────────────────── Entities ───────────────────────── */

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: number; // 0..HAIR_STYLES-1
  outfit: string;
  pants: string;
  accessory: number; // 0..ACCESSORIES-1
  /** Top style 0..OUTFIT_STYLES-1; absent (older clients) means 0. */
  outfitStyle?: number;
  /** Trousers style 0..PANTS_STYLES-1; absent means 0. */
  pantsStyle?: number;
}

export const HAIR_STYLE_NAMES = ['Short crop', 'Side swept', 'Long bob', 'Buzz', 'Bun', 'Curly', 'Long straight', 'Ponytail', 'Mohawk', 'Afro', 'Pigtails', 'Bald', 'Spiky', 'Pompadour'] as const;
export const ACCESSORY_NAMES = ['None', 'Glasses', 'Headphones', 'Cap', 'Sunglasses', 'Headband', 'Beanie', 'Mustache', 'Bow', 'Crown'] as const;
export const OUTFIT_STYLE_NAMES = ['Crew', 'Hoodie', 'Blazer', 'Striped', 'Tank', 'Overalls', 'Turtleneck', 'Polo'] as const;
export const PANTS_STYLE_NAMES = ['Long', 'Shorts', 'Skirt', 'Cropped', 'Cargo', 'Joggers'] as const;

export const HAIR_STYLES = HAIR_STYLE_NAMES.length;
export const ACCESSORIES = ACCESSORY_NAMES.length;
export const OUTFIT_STYLES = OUTFIT_STYLE_NAMES.length;
export const PANTS_STYLES = PANTS_STYLE_NAMES.length;

export interface GitActivity {
  repo: string;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  conflicts: number;
  state: 'idle' | 'dirty' | 'merging' | 'conflict';
}

export type EmoteKind =
  | 'wave'
  | 'heart'
  | 'clap'
  | 'coffee'
  | 'idea'
  | 'party'
  | 'think'
  | 'thumbsUp';

export const EMOTES: EmoteKind[] = [
  'wave',
  'heart',
  'clap',
  'coffee',
  'idea',
  'party',
  'think',
  'thumbsUp',
];

/** The page a person is on: where they stand in the office follows the sidebar. Plan and Review are the two fixed rooms. */
export type WorkspacePage = 'plan' | 'progress' | 'review';
export const WORKSPACE_PAGES: WorkspacePage[] = ['plan', 'progress', 'review'];

/** A person in the office. (Agents are not in the office: they are files in a project and only ever speak in the chat.) */
export interface PlayerState {
  id: string;
  name: string;
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  /** Desk id when seated. */
  sitting: string | null;
  status: PresenceStatus;
  statusText?: string;
  emote?: { kind: EmoteKind; at: number } | null;
  look: Appearance;
  /** Owned desk id, if any. */
  desk: string | null;
  activity?: GitActivity | null;
  /** Which page they are on. Everyone else sees them only on the page they are on. */
  page?: WorkspacePage;
}

/** Legacy: chat used to have nearby and direct scopes. There is one Room conversation now; old saved rows are all `room`. */
export type ChatScope = 'nearby' | 'room' | 'dm' | 'system';

export type ChatKind = 'human' | 'agent' | 'system';

export type SessionState = 'active' | 'archived';

export interface SessionInfo {
  id: string;
  room: string;
  state: SessionState;
  createdAt: number;
  archivedAt?: number;
  createdBy: string;
  legacy?: boolean;
  /** Set on the session that holds a worktree tab's chat: it is not one of the room's own sessions. */
  thread?: string;
}

/**
 * One line of the Room conversation, as saved in the team database.
 * `kind` and everything after `text` are stamped by the server; a client never chooses them.
 */
export interface ChatMessage {
  id: string;
  /** Legacy (old rows and the practice office); new messages have no scope. */
  scope?: ChatScope;
  /** A player id for people, `agent:<handle>` for agents, `system` for the office's own notes. */
  from: string;
  fromName: string;
  to?: string;
  text: string;
  at: number;
  zone?: string;
  /** The room (map zone id) the message belongs to. */
  room?: string;
  /** The session id the message belongs to. */
  session?: string;
  /** The worktree tab the message belongs to (its `session` is that tab's own). */
  thread?: string;
  /** A card shown with the text: a question with options, a plan to approve, a proposal, a result. Only agent messages carry one. */
  ui?: ChatCard;
  /** What an agent's answer rests on (docs, tickets, earlier messages). Only agent messages carry any. */
  citations?: Citation[];
  /** Absent on old rows: they are people. */
  kind?: ChatKind;
  /** The author's pixel look when it was sent (so history of people who are offline still draws a head). */
  look?: Appearance;
  /** Handles mentioned in the text (lower case, at most 3). */
  mentions?: string[];
  /** The message an agent reply or a failure note answers. */
  replyTo?: string;
  runId?: string;
  /** For agent messages: the person whose computer ran the agent. */
  via?: string;
  viaName?: string;
  /** A tombstone: the text was removed. */
  deleted?: boolean;
  /** Only on the sender's own copy: the id the client gave this send, so it can tell which one was saved. */
  cid?: string;
}

/* ───────────────────────── Map editing ───────────────────────── */

export type EditOp =
  | { op: 'floor'; cells: [number, number, number][] }
  | { op: 'wall'; cells: [number, number, number][] }
  | { op: 'prop.add'; prop: MapProp }
  | { op: 'prop.remove'; id: string }
  | { op: 'prop.move'; id: string; x: number; y: number }
  | { op: 'zone.set'; zone: MapZone }
  | { op: 'zone.remove'; id: string };

/* ───────────────────────── Worktree tabs ───────────────────────── */

/**
 * `creating`: Antigravity is making the worktree. `failed`: it could not (see `error`; try again or remove). `intake`: the project
 * manager is asking what the work is for. `planned`: a plan is waiting for the owner's Proceed. `running`: agents are working.
 * `review`: they stopped and the owner looks. `done`, `archived`: finished, kept for the record.
 */
export type ThreadState = 'creating' | 'failed' | 'intake' | 'planned' | 'running' | 'review' | 'done' | 'archived';

export type ThreadError =
  | 'disk_full'
  | 'branch_exists'
  | 'branch_checked_out'
  | 'path_exists'
  | 'not_git'
  | 'no_commits'
  | 'git_lock'
  | 'permission_denied'
  | 'agy_missing'
  | 'agy_signed_out'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

/**
 * A worktree tab: shared on the team server so everyone sees it, while the folder itself exists only on the owner's Mac (its path
 * is never sent). Only `owner` (the member whose zone it is) creates it, changes it and asks agents anything in it.
 */
export interface WorkThread {
  id: string;
  /** The room (map zone id, `z-<uid>`) the tab belongs to. */
  zone: string;
  owner: string;
  ownerName: string;
  name: string;
  branch: string;
  base: string;
  state: ThreadState;
  error?: { code: ThreadError; message: string };
  /** One line about what is happening now, safe for everyone to read (never raw tool output). */
  step?: string;
  /** The Board ticket this work is for, and the docs it draws on (ids). */
  ticket: string | null;
  docs: string[];
  purpose?: string;
  /** The chat session that holds this tab's messages. */
  session: string;
  createdAt: number;
  updatedAt: number;
}

/** What the owner may change on a thread. */
export interface ThreadPatch {
  state?: ThreadState;
  step?: string | null;
  error?: { code: ThreadError; message: string } | null;
  name?: string;
  ticket?: string | null;
  docs?: string[];
  purpose?: string;
}

/* ───────────────────────── Cards in a worktree tab's chat ───────────────────────── */

export interface AskOption {
  id: string;
  label: string;
  hint?: string;
}

/** What the project manager recommends for the work: the agents, in order, and what it would do. */
export interface PlanCard {
  summary: string;
  steps: string[];
  /** `effort`: how hard the manager thinks this part is (the owner may change it before Proceed). */
  agents: { handle: string; why: string; effort?: 'low' | 'medium' | 'high' }[];
  /** The Board ticket the work is for (an existing one by id, or one to create), if there is one. */
  ticket: { link: string } | { create: { title: string; body: string } } | null;
  risks: string[];
}

/** Where an agent's answer comes from: a doc, a ticket or an earlier message, with the words that support it. */
export interface Citation {
  kind: 'doc' | 'ticket' | 'chat';
  /** A doc's page id, a ticket's number (`"12"`) or a message id. */
  id: string;
  title: string;
  quote?: string;
}

/** One thing an agent proposes to create. Nothing exists until a person accepts it. */
export interface ProposalItem {
  /** Handle-shaped (`item-1`), unique in the card. */
  id: string;
  /** `artifact`: something the delivery pipeline keeps (a spec, a design, a change set…). Its words are in the artifact, not here. */
  type: 'ticket' | 'doc' | 'artifact';
  title: string;
  body: string;
  labels?: string[];
  points?: number;
  /** The ticket number it would repeat: shown so the person can leave it out. */
  duplicateOf?: number;
  /** For `artifact`: the artifact's id and its kind (the server sets both; an agent cannot name an id). */
  artifactId?: string;
  artifactKind?: string;
}

/**
 * A question with options (`choice`: one, `multi`: any, `text`: a free answer), a plan waiting for the owner's Proceed, a proposal
 * (tickets and pages for a person to accept), or how a run ended. `answered`, `decided`, `chosen` and `created` are set by the
 * server when a person answers, so everyone sees which option was taken.
 */
export type ChatCard =
  | { kind: 'ask'; id: string; mode: 'choice' | 'multi' | 'text'; prompt: string; options: AskOption[]; answered?: string[] }
  | { kind: 'plan'; plan: PlanCard; decided?: 'proceeded' | 'dismissed'; chosen?: string[] }
  | { kind: 'proposal'; id: string; title: string; items: ProposalItem[]; decided?: 'proceeded' | 'dismissed'; chosen?: string[]; created?: { item: string; ref: string }[] }
  | { kind: 'result'; summary: string; status: 'done' | 'blocked'; branch?: string; ticket?: string | null };
