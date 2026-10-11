// Draw order of the map layers. The hex board goes first, then route and
// pipeline lines with no depth test (so a line can never vanish under a tile
// or behind a coast wall), then everything else — sites, tanks, vehicles —
// which therefore always draws on top of the lines.

export const BOARD_RENDER_ORDER = -2;
export const LINE_RENDER_ORDER = -1;
