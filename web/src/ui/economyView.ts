// What the Economy window is showing: which tab, which detail page over the
// Overview, and which tank the Supply options page is on. Kept outside the component so another panel can open the
// window on a tank with one call (openSupplyOptions).

import { create } from 'zustand';
import { useWindows } from './windows';

export const ECONOMY_WINDOW_ID = 'economy';
/** Where the window first appears: under the top bar, to the right. */
export const ECONOMY_WINDOW_AT = { x: 630, y: 68 };

export type EconomyTab = 'overview' | 'prices' | 'spending';
/** A fuller page opened from the Overview, with a link back to it. */
export type EconomyDetail = 'impact' | 'plants' | 'supply';

export interface EconomyViewState {
  tab: EconomyTab;
  /** the detail page on show over the Overview, if any */
  detail: EconomyDetail | null;
  /** the buying tank the Supply options page shows: a site index and a material key */
  supplyTank: { site: number; material: string } | null;
  /** go to a tab (closing any detail page) */
  setTab: (tab: EconomyTab) => void;
  /** open a detail page from the Overview, or close it with null */
  showDetail: (detail: EconomyDetail | null) => void;
  chooseSupplyTank: (site: number, material: string) => void;
}

export const useEconomyView = create<EconomyViewState>()((set) => ({
  tab: 'overview',
  detail: null,
  supplyTank: null,
  setTab: (tab) => set({ tab, detail: null }),
  showDetail: (detail) => set({ tab: 'overview', detail }),
  chooseSupplyTank: (site, material) => set({ supplyTank: { site, material } }),
}));

/**
 * Open the Economy window on the Supply options page, on one tank: the tank
 * of `materialKey` at the site with index `siteIndex`. Opens the window if
 * it is closed and brings it to the front.
 */
export function openSupplyOptions(siteIndex: number, materialKey: string): void {
  useEconomyView.setState({ tab: 'overview', detail: 'supply', supplyTank: { site: siteIndex, material: materialKey } });
  const windows = useWindows.getState();
  if (windows.windows[ECONOMY_WINDOW_ID]?.open !== true) windows.toggle(ECONOMY_WINDOW_ID, ECONOMY_WINDOW_AT);
  else windows.focus(ECONOMY_WINDOW_ID);
}
