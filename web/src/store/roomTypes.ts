// The shapes a multiplayer room speaks (~/pg-work/MULTIPLAYER-CONTRACT.md).

export type RoomPhase = 'lobby' | 'running' | 'paused' | 'ended';

export interface RoomPlayer {
  id: string;
  name: string;
  /** index of the site this player took, or null before choosing */
  site: number | null;
  connected: boolean;
}

export interface RoomSite {
  index: number;
  key: string;
  name: string;
  preset: string;
  /** a plant or a source a player may take (not a customer, a port or the gas grid) */
  playable: boolean;
  /** the id of the player who took it, or null */
  owner: string | null;
}

/** GET /api/room/{code} */
export interface RoomInfo {
  code: string;
  phase: RoomPhase;
  tick: number;
  /** simulated hours per real second while running */
  speed: number;
  /** the world file the room runs; absent on older servers (the standard world) */
  world?: string;
  /** whether fields and mines can be picked (the host's lobby switch); absent on older servers */
  allowSources?: boolean;
  players: RoomPlayer[];
  sites: RoomSite[];
}

/** One row of GET /api/room/{code}/scores */
export interface RoomScore {
  site: number;
  name: string;
  owner: string | null;
  ownerName: string | null;
  profitUsd: number;
  revenueUsd: number;
  feedUsd: number;
  freightUsd: number;
  energyUsd: number;
  markup: number;
  rateShare: number;
  soldT: number;
  rank: number;
  /** customer sales lost because of this player's actions; absent on older servers */
  damageUsd?: number;
}

export interface RoomScores {
  tick: number;
  scores: RoomScore[];
}

/** What the host may ask of a room (POST /api/room/{code}/host). */
export type HostAction =
  | { action: 'start' | 'pause' | 'resume' | 'end' }
  | { action: 'sources'; allow: boolean }
  | { action: 'speed'; speed: number }
  | { action: 'scenario'; command: Record<string, unknown> };

/** What a player may do to their own plant (POST /api/room/{code}/play). */
export type PlayerAction =
  | { action: 'price'; markup: number }
  | { action: 'rate'; share: number }
  | { action: 'unit'; unit_index: number; down: boolean }
  | { action: 'block'; partner: number; direction: 'sell' | 'buy'; blocked: boolean };

/** One plant a site trades with, and whether its owner has cut it off. */
export interface RoomPartner { site: number; name: string; materials: string[]; blocked: boolean }
export interface RoomPartners { buyers: RoomPartner[]; suppliers: RoomPartner[] }

/** The server's answer to a claim or a player action. */
export interface RoomReply { ok?: boolean; error?: string }

/** The owner's name per site index, from the room's sites and players; null where nobody has it. */
export function siteOwners(room: Pick<RoomInfo, 'sites' | 'players'> | null, nSites: number): (string | null)[] {
  const out: (string | null)[] = Array.from({ length: nSites }, () => null);
  if (room === null) return out;
  const names = new Map(room.players.map((p) => [p.id, p.name]));
  for (const s of room.sites) {
    if (s.owner !== null && s.index >= 0 && s.index < nSites) out[s.index] = names.get(s.owner) ?? null;
  }
  // a player whose claim the site list does not carry yet
  for (const p of room.players) {
    if (p.site !== null && p.site >= 0 && p.site < nSites && out[p.site] === null) out[p.site] = p.name;
  }
  return out;
}

/** One bright colour per player, by the order they joined. */
export const PLAYER_COLORS = ['#16a34a', '#2563eb', '#ea580c', '#9333ea', '#db2777', '#dc2626', '#0891b2', '#ca8a04', '#4f46e5', '#059669', '#c026d3', '#b45309', '#0d9488'];
export function playerColor(room: Pick<RoomInfo, 'players'> | null, playerId: string | null): string | null {
  if (room === null || playerId === null) return null;
  const i = room.players.findIndex((p) => p.id === playerId);
  return i < 0 ? null : PLAYER_COLORS[i % PLAYER_COLORS.length];
}
/** "Maya's Oil field": the owner first. */
export const ownedName = (owner: string | null | undefined, site: string) => (owner ? `${owner}\u2019s ${site}` : site);
/** Each site's owner colour, or null. */
export function siteOwnerColors(room: Pick<RoomInfo, 'sites' | 'players'> | null, nSites: number): (string | null)[] {
  const out: (string | null)[] = Array.from({ length: nSites }, () => null);
  if (room === null) return out;
  for (const s of room.sites) if (s.owner !== null && s.index >= 0 && s.index < nSites) out[s.index] = playerColor(room, s.owner);
  for (const p of room.players) if (p.site !== null && p.site >= 0 && p.site < nSites && out[p.site] === null) out[p.site] = playerColor(room, p.id);
  return out;
}

/** One run's totals in a room summary: the room itself, or the same run with nobody's changes. */
export interface SummaryTotals {
  /** sales customers went without: notServedUsd + pricedOutUsd where the server splits them */
  lostSalesUsd: number;
  /** wanted and not delivered */
  notServedUsd?: number;
  /** given up because the price was too high (market world) */
  pricedOutUsd?: number;
  deliveredT: number;
  plantsStoppedNow: number;
}
export interface SummarySite {
  site: number; name: string; owner: string | null; ownerName: string | null;
  status: number; baselineStatus: number;
  stoppedHours: number; baselineStoppedHours: number;
  outputT: number; baselineOutputT: number;
  lostSalesUsd: number; baselineLostSalesUsd: number;
  notServedUsd?: number; pricedOutUsd?: number;
  /** clearly worse than in the run with no changes */
  broken: boolean;
}
export interface SummaryPipeline { index: number; name: string; movedT: number; baselineMovedT: number; broken: boolean }
export interface SummaryPlayer { id: string; name: string; site: number | null; damageUsd: number; tookDown: number[]; moves: number }
export interface SummaryPrice { material: string; name: string; tonnes: number; baselineTonnes: number; avgUsdPerT: number; baselineAvgUsdPerT: number; changePct: number }
/** GET /api/room/{code}/summary: the room against the same run with no changes at all. */
export interface RoomSummary {
  tick: number;
  economy: { actual: SummaryTotals; baseline: SummaryTotals; damageUsd: number };
  sites: SummarySite[];
  pipelines: SummaryPipeline[];
  players: SummaryPlayer[];
  /** average price paid per material, this session against nothing changed; absent on older servers */
  prices?: SummaryPrice[];
}

/** The world where prices drive buying, demand and plant rates. */
export const MARKET_WORLD = 'erwin-market-v1';
