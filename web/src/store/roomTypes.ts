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
