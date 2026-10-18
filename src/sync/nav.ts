import { create } from 'zustand';

/** Where a link should take the person: a ticket on the Board, or a page in Docs. */
export type NavTarget = { page: 'board'; issue: string } | { page: 'docs'; id: string };

interface NavState {
  target: NavTarget | null;
  open(target: NavTarget): void;
  /** The page that was sent there has shown it. */
  clear(): void;
}

/** The shell reads `target` to switch pages; the page it switches to reads it to select the item. Neither imports the other. */
export const useNav = create<NavState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  clear: () => set({ target: null }),
}));
