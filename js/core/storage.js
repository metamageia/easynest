// storage.js — persistence of user settings between sessions.
//
// Per the PRD: sheet size, units, margin, gap, and rotation persist in
// localStorage. Imported files and computed layouts are NOT persisted.

const KEY = 'easynest.settings.v1';

export const DEFAULT_SETTINGS = {
  units: 'in',
  sheetW: 13,      // in active units
  sheetH: 19,
  margin: 0.25,
  gap: 0.125,
  rotations: 4,    // rotation granularity for the optimizer (1 = no rotation)
  presetId: '13x19',
  cores: 'auto',   // parallel passes: 'auto' (= detected cores) or a positive integer
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (e) {
    console.warn('Could not load settings:', e);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    const subset = {
      units: settings.units,
      sheetW: settings.sheetW,
      sheetH: settings.sheetH,
      margin: settings.margin,
      gap: settings.gap,
      rotations: settings.rotations,
      presetId: settings.presetId,
      cores: settings.cores,
    };
    localStorage.setItem(KEY, JSON.stringify(subset));
  } catch (e) {
    console.warn('Could not save settings:', e);
  }
}
