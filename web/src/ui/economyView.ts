// What the Economy window is showing: which tab, and which tank the Supply
// options tab is on. Kept outside the component so another panel can open the
// window on a tank with one call (openSupplyOptions).

import { create } from 'zustand';
import { useWindows } from './windows';

export const ECONOMY_WINDOW_ID = 'economy';
/** Where the window first appears: under the top bar, to the right. */
export const ECONOMY_WINDOW_AT = { x: 630, y: 68 };

export type EconomyTab = 'prices' | 'procurement' | 'production' | 'impact' | 'supply';

export interface EconomyViewState {
  tab: EconomyTab;
  /** the buying tank the Supply options tab shows: a site index and a material key */
  supplyTank: { site: number; material: string } | null;
  setTab: (tab: EconomyTab) => void;
  chooseSupplyTank: (site: number, material: string) => void;
}

export const useEconomyView = create<EconomyViewState>()((set) => ({
  tab: 'prices',
  supplyTank: null,
  setTab: (tab) => set({ tab }),
  chooseSupplyTank: (site, material) => set({ supplyTank: { site, material } }),
}));

/**
 * Open the Economy window on the Supply options tab, on one tank: the tank
 * of `materialKey` at the site with index `siteIndex`. Opens the window if
 * it is closed and brings it to the front.
 */
export function openSupplyOptions(siteIndex: number, materialKey: string): void {
  useEconomyView.setState({ tab: 'supply', supplyTank: { site: siteIndex, material: materialKey } });
  const windows = useWindows.getState();
  if (windows.windows[ECONOMY_WINDOW_ID]?.open !== true) windows.toggle(ECONOMY_WINDOW_ID, ECONOMY_WINDOW_AT);
  else windows.focus(ECONOMY_WINDOW_ID);
}
