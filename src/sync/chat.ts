import { create } from 'zustand';

/** What happened to a message sent through the bridge. */
export type BridgeSend = { ok: true } | { ok: false; message: string };

interface ChatBridge {
  /** Says something in the room the person is in, as them (the Office sets this while it is open). `null`: no office to say it in. */
  send: ((text: string) => Promise<BridgeSend>) | null;
  setSend(send: ChatBridge['send']): void;
}

/**
 * A way for a page outside the Office (the hosted demo's guide) to ask something in the room without importing the Office. Like
 * `useNav`, the Office fills it in and the other side only calls it.
 */
export const useChatBridge = create<ChatBridge>((set) => ({
  send: null,
  setSend: (send) => set({ send }),
}));
