import { create } from 'zustand';
import { fetchDemoStatus, type DemoStatus } from '../web.ts';

const SEEN_KEY = 'wts-judge-path-seen';

/** Whether the guide was dismissed on an earlier visit. A browser that keeps nothing shows it every time, which is fine. */
function seenBefore(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

interface DemoState {
  /** What the server says about the demo (the runs left); `null` until it answers. */
  status: DemoStatus | null;
  /** The "Judge's 3-minute path" card is showing. */
  guideOpen: boolean;
  refresh(): Promise<void>;
  openGuide(): void;
  closeGuide(): void;
}

export const useDemo = create<DemoState>((set) => ({
  status: null,
  guideOpen: !seenBefore(),
  async refresh() {
    const status = await fetchDemoStatus();
    // A failed read keeps what was known: the strip should not flicker back to "no count" because of one dropped request.
    if (status) set({ status });
  },
  openGuide: () => set({ guideOpen: true }),
  closeGuide: () => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Not kept: the guide comes back next visit.
    }
    set({ guideOpen: false });
  },
}));

/** "Demo workspace: synthetic data, resets nightly, 12 AI runs left": what the strip says. */
export function stripText(status: DemoStatus | null): string {
  const base = 'Demo workspace: synthetic data, resets nightly';
  if (!status) return base;
  return `${base}, ${status.runsLeft} AI ${status.runsLeft === 1 ? 'run' : 'runs'} left`;
}
