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
  rotations: 4,    // rotation granularity: 1 = none, N = fixed steps, 'auto' = race granularities up to 45°
  presetId: '13x19',
  cores: 'auto',   // parallel NFP compute: 'auto' (= detected cores) or a positive integer
  detail: 'balanced', // nesting outline detail: 'tight' | 'balanced' | 'fast'
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
      detail: settings.detail,
    };
    localStorage.setItem(KEY, JSON.stringify(subset));
  } catch (e) {
    console.warn('Could not save settings:', e);
  }
}

// User-defined sheet-size presets, persisted separately from the built-in list.
// Each entry: { id, name, w, h, units }  (w/h in its own `units`, like SHEET_PRESETS).
const PRESETS_KEY = 'easynest.presets.v1';

export function loadCustomPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('Could not load presets:', e);
    return [];
  }
}

export function saveCustomPresets(presets) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch (e) {
    console.warn('Could not save presets:', e);
  }
}
