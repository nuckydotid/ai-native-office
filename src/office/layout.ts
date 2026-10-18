import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const PANEL_MIN = 280;
export const PANEL_MAX = 560;
export const PANEL_DEFAULT = 360;
/** The picture never gets less than this much room. */
export const WORLD_MIN = 360;

export const clampPanel = (width: number, available: number): number =>
  Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, width, Math.max(PANEL_MIN, available - WORLD_MIN))));

interface OfficeLayout {
  panelW: number;
  setPanelW: (panelW: number) => void;
}

/** How wide the chat panel is, remembered between visits. */
export const useOfficeLayout = create<OfficeLayout>()(
  persist(
    (set) => ({
      panelW: PANEL_DEFAULT,
      setPanelW: (panelW) => set({ panelW }),
    }),
    { name: 'office-layout', version: 1 },
  ),
);
