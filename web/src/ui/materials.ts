// Plain names for the engine's material keys, shared by every window that
// talks about a material: "propylene", not PROPYLENE; "polyethylene", not PE.
// Keys this table does not know are tidied rather than shown raw.

/** Names as they read mid-sentence. Abbreviations people actually say stay as they are. */
const NAMES: Record<string, string> = {
  CRUDE: 'crude oil',
  RAW_GAS: 'raw gas',
  SALT: 'salt',
  METHANE: 'methane',
  ETHANE: 'ethane',
  LPG: 'LPG',
  NAPHTHA: 'naphtha',
  HEAVY_NAPHTHA: 'heavy naphtha',
  GASOIL: 'gasoil',
  VGO: 'vacuum gasoil',
  GASOLINE: 'gasoline',
  JET: 'jet fuel',
  DIESEL: 'diesel',
  FUEL_OIL: 'fuel oil',
  SOLVENT: 'solvent',
  BENZENE: 'benzene',
  ETHYLENE: 'ethylene',
  PROPYLENE: 'propylene',
  CHLORINE: 'chlorine',
  CAUSTIC: 'caustic soda',
  VCM: 'vinyl chloride',
  STYRENE: 'styrene',
  PE: 'polyethylene',
  PP: 'polypropylene',
  PVC: 'PVC',
  PS: 'polystyrene',
  // utilities and losses
  FUEL_GAS: 'fuel gas',
  WATER: 'water',
  STEAM: 'steam',
  AIR: 'air',
  AIR_O2: 'air (oxygen)',
  HYDROGEN: 'hydrogen',
  LOSS: 'losses',
};

/** A material key as it reads inside a sentence: "polyethylene", "fuel oil", "LPG". */
export function materialName(key: string): string {
  const known = NAMES[key];
  if (known !== undefined) return known;
  // an internal stream (already lower case) or a key this table does not know
  return key === key.toUpperCase() && key.length > 4 ? key.toLowerCase().replace(/_/g, ' ') : key.replace(/_/g, ' ');
}

/** The same name starting a label: "Polyethylene", "Fuel oil", "LPG". */
export function materialTitle(key: string): string {
  const name = materialName(key);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
