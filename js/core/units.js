// units.js — unit conversions and sheet-size presets.
//
// Internal canonical unit for all geometry, nesting, and export is the PDF
// point (1 pt = 1/72 inch). User-facing dimensions are inches or millimetres.

export const PT_PER_IN = 72;
export const PT_PER_MM = 72 / 25.4;

export function toPoints(value, units) {
  return units === 'mm' ? value * PT_PER_MM : value * PT_PER_IN;
}

export function fromPoints(pts, units) {
  return units === 'mm' ? pts / PT_PER_MM : pts / PT_PER_IN;
}

// Round a display value to a sensible precision for the given units.
export function formatLength(pts, units) {
  const v = fromPoints(pts, units);
  return units === 'mm' ? v.toFixed(1) : v.toFixed(2);
}

export const UNIT_LABEL = { in: 'in', mm: 'mm' };

// Sheet-size presets, stored in inches (their natural definition). Converted
// to the active units for display.
export const SHEET_PRESETS = [
  { id: 'letter', name: 'Letter (8.5 × 11)', w: 8.5, h: 11, units: 'in' },
  { id: 'tabloid', name: 'Tabloid (11 × 17)', w: 11, h: 17, units: 'in' },
  { id: '12x18', name: '12 × 18', w: 12, h: 18, units: 'in' },
  { id: '13x19', name: '13 × 19', w: 13, h: 19, units: 'in' },
  { id: '28x40', name: '28 × 40', w: 28, h: 40, units: 'in' },
  { id: 'a4', name: 'A4 (210 × 297 mm)', w: 210, h: 297, units: 'mm' },
  { id: 'a3', name: 'A3 (297 × 420 mm)', w: 297, h: 420, units: 'mm' },
];

// Returns preset dimensions converted into the requested display units.
export function presetInUnits(preset, units) {
  const wPt = toPoints(preset.w, preset.units);
  const hPt = toPoints(preset.h, preset.units);
  return { w: fromPoints(wPt, units), h: fromPoints(hPt, units) };
}
