// main.js — the UI shell. Talks only to the Engine; renders parts, settings,
// and the paged sheet preview; drives start/stop/export.

import { Engine } from './core/engine.js';
import {
  SHEET_PRESETS, presetInUnits, fromPoints, toPoints, UNIT_LABEL,
} from './core/units.js';
import { renderPartImage } from './core/importers.js';
import { loadCustomPresets, saveCustomPresets } from './core/storage.js';

const engine = new Engine();
let currentSheet = 0;
let customPresets = loadCustomPresets(); // user-saved sheet sizes
const thumbCache = new Map();   // part.id -> HTMLImageElement (low-res list thumb)
const previewCache = new Map(); // part.id -> HTMLImageElement (hi-res preview)
const previewPending = new Set(); // part.ids whose hi-res render is in flight
const aspectLocked = new Map(); // part.id -> bool (size-override aspect lock; default on)
const isAspectLocked = (id) => (aspectLocked.has(id) ? aspectLocked.get(id) : true);
const originalDims = new Map(); // part.id -> {width,height} in points, for size reset

// --- element refs ---------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'), fileInput: $('file-input'), pickBtn: $('pick-btn'),
  partsList: $('parts-list'), partsEmpty: $('parts-empty'),
  presetSelect: $('preset-select'), savePresetBtn: $('save-preset-btn'), deletePresetBtn: $('delete-preset-btn'),
  sheetW: $('sheet-w'), sheetH: $('sheet-h'),
  units: $('units-select'), margin: $('margin'), gap: $('gap'), rotations: $('rotations'),
  cores: $('cores-select'), detail: $('detail-select'),
  startBtn: $('start-btn'), stopBtn: $('stop-btn'), exportBtn: $('export-btn'),
  statusPill: $('status-pill'), messages: $('messages'),
  canvas: $('preview-canvas'), previewEmpty: $('preview-empty'),
  util: $('util'), sheetCount: $('sheet-count'), placedCount: $('placed-count'),
  prevSheet: $('prev-sheet'), nextSheet: $('next-sheet'), sheetLabel: $('sheet-label'),
  logToggle: $('log-toggle'), logBadge: $('log-badge'), logPanel: $('log-panel'),
  logList: $('log-list'), logEmpty: $('log-empty'), logClear: $('log-clear'), logClose: $('log-close'),
};

// --- messages -------------------------------------------------------------
function clearMessages() { els.messages.innerHTML = ''; }
function addMessage(text, kind = 'warn') {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  els.messages.appendChild(div);
}

// --- event log ------------------------------------------------------------
let logUnread = 0;
let logHasAlert = false;

function timeLabel(d) {
  return d.toLocaleTimeString([], { hour12: false });
}

function clearLog() {
  els.logList.innerHTML = '';
  els.logEmpty.style.display = 'block';
  logUnread = 0; logHasAlert = false;
  updateLogBadge();
}

function addLog(level, message) {
  els.logEmpty.style.display = 'none';
  const li = document.createElement('li');
  li.className = `log-entry ${level}`;
  const time = document.createElement('span');
  time.className = 'log-time'; time.textContent = timeLabel(new Date());
  const msg = document.createElement('span');
  msg.className = 'log-msg'; msg.textContent = message;
  li.append(time, msg);
  els.logList.appendChild(li);
  els.logList.scrollTop = els.logList.scrollHeight;

  if (els.logPanel.hidden) {
    logUnread++;
    if (level === 'warn' || level === 'error') logHasAlert = true;
    updateLogBadge();
  }
}

function updateLogBadge() {
  if (logUnread > 0) {
    els.logBadge.hidden = false;
    els.logBadge.textContent = logUnread > 99 ? '99+' : String(logUnread);
    els.logBadge.classList.toggle('alert', logHasAlert);
  } else {
    els.logBadge.hidden = true;
    els.logBadge.classList.remove('alert');
  }
}

function setLogOpen(open) {
  els.logPanel.hidden = !open;
  els.logToggle.setAttribute('aria-expanded', String(open));
  if (open) { logUnread = 0; logHasAlert = false; updateLogBadge(); }
}

function wireLog() {
  els.logToggle.addEventListener('click', () => setLogOpen(els.logPanel.hidden));
  els.logClose.addEventListener('click', () => setLogOpen(false));
  els.logClear.addEventListener('click', clearLog);
}

// --- parts list -----------------------------------------------------------
function renderParts() {
  els.partsList.innerHTML = '';
  els.partsEmpty.style.display = engine.parts.length ? 'none' : 'block';

  for (const part of engine.parts) {
    // Remember the imported size once, so it can be reset later.
    if (!originalDims.has(part.id)) originalDims.set(part.id, { width: part.width, height: part.height });

    const li = document.createElement('li');
    li.className = 'part';

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = part.thumbnail || '';
    thumb.alt = part.name;

    const body = document.createElement('div');
    body.className = 'body';

    // Head: name + kind tag + remove
    const head = document.createElement('div');
    head.className = 'part-head';
    const name = document.createElement('div');
    name.className = 'name'; name.title = part.name; name.textContent = part.name;
    const kind = document.createElement('span');
    kind.className = 'kind-tag'; kind.textContent = part.kind;
    const remove = document.createElement('button');
    remove.className = 'icon-btn remove'; remove.title = 'Remove part'; remove.textContent = '✕';
    remove.addEventListener('click', () => engine.removePart(part.id));
    head.append(name, kind, remove);
    body.appendChild(head);

    if (part.sizing && (part.kind === 'raster' || part.kind === 'svg')) {
      body.appendChild(buildDpiRow(part));
    }

    // Controls: size override + quantity, bottom-aligned in one row.
    const controls = document.createElement('div');
    controls.className = 'part-controls';
    controls.append(buildSizeField(part), buildQtyField(part));
    body.appendChild(controls);

    for (const w of (part.warnings || [])) {
      const wEl = document.createElement('div');
      wEl.className = 'warn'; wEl.textContent = w;
      body.appendChild(wEl);
    }

    li.append(thumb, body);
    els.partsList.appendChild(li);
  }
}

function buildDpiRow(part) {
  const dpiRow = document.createElement('div');
  dpiRow.className = 'dpi-row';
  const lbl = document.createElement('span');
  lbl.textContent = 'DPI';
  const dpiInput = document.createElement('input');
  dpiInput.type = 'number'; dpiInput.min = '1'; dpiInput.step = '1';
  dpiInput.value = Math.round(part.sizing.dpi || 300);
  dpiInput.title = 'Assumed resolution — change to resize this part';
  dpiInput.addEventListener('change', () => {
    const dpi = parseFloat(dpiInput.value);
    if (dpi > 0) engine.resizePart(part.id, { mode: 'dpi', dpi });
  });
  dpiRow.append(lbl, dpiInput);
  return dpiRow;
}

// A labelled control group: a small uppercase label over its control(s).
function fieldGroup(labelText, ...controls) {
  const group = document.createElement('div');
  group.className = 'field-group';
  const label = document.createElement('label');
  label.className = 'field-label'; label.textContent = labelText;
  group.append(label, ...controls);
  return group;
}

function buildQtyField(part) {
  const input = document.createElement('input');
  input.className = 'qty-input';
  input.type = 'number'; input.min = '0'; input.value = part.quantity;
  input.addEventListener('change', () => engine.setQuantity(part.id, parseInt(input.value, 10)));
  autosizeNumberInput(input);
  return fieldGroup('Qty', input);
}

// Grow a number input's width to fit its value (so e.g. quantity 1 and 1000 are
// both readable without a fixed-width box). padPx leaves room for padding +
// the spinner buttons.
function autosizeNumberInput(input, padPx = 36) {
  const apply = () => {
    const len = Math.max(1, String(input.value == null ? '' : input.value).length);
    input.style.width = `calc(${len}ch + ${padPx}px)`;
  };
  input.addEventListener('input', apply);
  apply();
}

// Editable physical-size override (width × height, active units) with an
// aspect-ratio lock and a reset-to-imported-size button. Works for every part
// kind, including vector PDFs.
function buildSizeField(part) {
  const units = engine.settings.units;
  const row = document.createElement('div');
  row.className = 'size-row';

  const wIn = document.createElement('input');
  wIn.type = 'number'; wIn.min = '0.01'; wIn.step = '0.01';
  wIn.value = round(fromPoints(part.width, units));
  wIn.title = 'Override width';

  const x = document.createElement('span');
  x.className = 'x'; x.textContent = '×';

  const hIn = document.createElement('input');
  hIn.type = 'number'; hIn.min = '0.01'; hIn.step = '0.01';
  hIn.value = round(fromPoints(part.height, units));
  hIn.title = 'Override height';

  const unit = document.createElement('span');
  unit.className = 'unit'; unit.textContent = UNIT_LABEL[units];

  const lock = document.createElement('button');
  lock.type = 'button';
  lock.className = 'icon-btn lock' + (isAspectLocked(part.id) ? ' active' : '');
  lock.textContent = '🔗';
  lock.title = 'Lock aspect ratio';
  lock.setAttribute('aria-pressed', String(isAspectLocked(part.id)));
  lock.addEventListener('click', () => {
    const next = !isAspectLocked(part.id);
    aspectLocked.set(part.id, next);
    lock.classList.toggle('active', next);
    lock.setAttribute('aria-pressed', String(next));
  });

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'icon-btn reset';
  reset.textContent = '↺';
  reset.title = 'Reset to imported size';
  const orig = originalDims.get(part.id);
  const atOriginal = orig &&
    Math.abs(part.width - orig.width) < 1e-3 && Math.abs(part.height - orig.height) < 1e-3;
  reset.disabled = !!atOriginal;
  reset.addEventListener('click', () => {
    const o = originalDims.get(part.id);
    if (o) engine.resizePart(part.id, { mode: 'explicit', widthPt: o.width, heightPt: o.height });
  });

  wIn.addEventListener('change', () => {
    const v = parseFloat(wIn.value);
    if (!(v > 0)) { wIn.value = round(fromPoints(part.width, units)); return; }
    const widthPt = toPoints(v, units);
    const heightPt = isAspectLocked(part.id) ? widthPt * (part.height / part.width) : part.height;
    engine.resizePart(part.id, { mode: 'explicit', widthPt, heightPt });
  });
  hIn.addEventListener('change', () => {
    const v = parseFloat(hIn.value);
    if (!(v > 0)) { hIn.value = round(fromPoints(part.height, units)); return; }
    const heightPt = toPoints(v, units);
    const widthPt = isAspectLocked(part.id) ? heightPt * (part.width / part.height) : part.width;
    engine.resizePart(part.id, { mode: 'explicit', widthPt, heightPt });
  });

  row.append(wIn, x, hIn, unit, lock, reset);
  return fieldGroup('Size', row);
}

// --- settings -------------------------------------------------------------
function presetOption(value, text) {
  const opt = document.createElement('option');
  opt.value = value; opt.textContent = text;
  return opt;
}

function populatePresets() {
  els.presetSelect.innerHTML = '';
  const std = document.createElement('optgroup');
  std.label = 'Standard sizes';
  for (const p of SHEET_PRESETS) std.appendChild(presetOption(p.id, p.name));
  els.presetSelect.appendChild(std);

  if (customPresets.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'My presets';
    for (const p of customPresets) grp.appendChild(presetOption(p.id, p.name));
    els.presetSelect.appendChild(grp);
  }
  els.presetSelect.appendChild(presetOption('custom', 'Custom'));
}

// Look up a preset by id in either the built-in or user-saved lists.
function findPreset(id) {
  return SHEET_PRESETS.find((p) => p.id === id) ||
         customPresets.find((p) => p.id === id) || null;
}

// Delete is only meaningful for a currently-selected user preset.
function updatePresetButtons() {
  els.deletePresetBtn.disabled = !customPresets.some((p) => p.id === els.presetSelect.value);
}

function populateCores() {
  const max = Engine.detectCores();
  els.cores.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto'; auto.textContent = `Auto (${max})`;
  els.cores.appendChild(auto);
  for (let n = 1; n <= max; n++) {
    const opt = document.createElement('option');
    opt.value = String(n); opt.textContent = n === 1 ? '1 (single)' : String(n);
    els.cores.appendChild(opt);
  }
}

function syncSettingsToUI() {
  const s = engine.settings;
  els.units.value = s.units;
  els.sheetW.value = round(s.sheetW);
  els.sheetH.value = round(s.sheetH);
  els.margin.value = round(s.margin);
  els.gap.value = round(s.gap);
  els.rotations.value = String(s.rotations);
  els.cores.value = (s.cores == null ? 'auto' : String(s.cores));
  els.detail.value = s.detail || 'balanced';
  els.presetSelect.value = s.presetId || 'custom';
  updatePresetButtons();
}
function round(v) { return Math.round(v * 1000) / 1000; }

function wireSettings() {
  els.presetSelect.addEventListener('change', () => {
    const id = els.presetSelect.value;
    if (id === 'custom') { engine.updateSettings({ presetId: 'custom' }); updatePresetButtons(); return; }
    const preset = findPreset(id);
    if (!preset) return;
    const d = presetInUnits(preset, engine.settings.units);
    engine.updateSettings({ presetId: id, sheetW: round(d.w), sheetH: round(d.h) });
    syncSettingsToUI();
  });

  els.savePresetBtn.addEventListener('click', () => {
    const w = round(engine.settings.sheetW);
    const h = round(engine.settings.sheetH);
    const units = engine.settings.units;
    const suggested = `${w} × ${h} ${UNIT_LABEL[units] || units}`;
    const name = (window.prompt('Name this preset:', suggested) || '').trim();
    if (!name) return;
    const preset = { id: 'user_' + Date.now().toString(36), name, w, h, units };
    customPresets.push(preset);
    saveCustomPresets(customPresets);
    populatePresets();
    engine.updateSettings({ presetId: preset.id });
    els.presetSelect.value = preset.id;
    updatePresetButtons();
  });

  els.deletePresetBtn.addEventListener('click', () => {
    const id = els.presetSelect.value;
    const idx = customPresets.findIndex((p) => p.id === id);
    if (idx < 0) return;
    customPresets.splice(idx, 1);
    saveCustomPresets(customPresets);
    populatePresets();
    // The selected preset is gone; keep the current size but mark it Custom.
    engine.updateSettings({ presetId: 'custom' });
    els.presetSelect.value = 'custom';
    updatePresetButtons();
  });

  els.units.addEventListener('change', () => {
    const oldU = engine.settings.units;
    const newU = els.units.value;
    if (oldU === newU) return;
    // Convert existing values so physical sizes are preserved.
    const conv = (v) => round(fromPoints(toPoints(v, oldU), newU));
    engine.updateSettings({
      units: newU,
      sheetW: conv(engine.settings.sheetW),
      sheetH: conv(engine.settings.sheetH),
      margin: conv(engine.settings.margin),
      gap: conv(engine.settings.gap),
    });
    syncSettingsToUI();
    renderParts(); // dimension labels change units
  });

  const numeric = [
    [els.sheetW, 'sheetW'], [els.sheetH, 'sheetH'],
    [els.margin, 'margin'], [els.gap, 'gap'],
  ];
  for (const [el, key] of numeric) {
    el.addEventListener('change', () => {
      const v = parseFloat(el.value);
      if (!isFinite(v) || v < 0) { syncSettingsToUI(); return; }
      const patch = { [key]: v };
      if (key === 'sheetW' || key === 'sheetH') patch.presetId = 'custom';
      engine.updateSettings(patch);
      if (patch.presetId) { els.presetSelect.value = 'custom'; updatePresetButtons(); }
    });
  }
  els.rotations.addEventListener('change', () => {
    engine.updateSettings({ rotations: parseInt(els.rotations.value, 10) || 4 });
  });
  els.cores.addEventListener('change', () => {
    const v = els.cores.value;
    engine.updateSettings({ cores: v === 'auto' ? 'auto' : (parseInt(v, 10) || 1) });
  });
  els.detail.addEventListener('change', () => {
    engine.updateSettings({ detail: els.detail.value });
  });
}

// --- file import ----------------------------------------------------------
async function handleFiles(fileList) {
  if (!fileList || !fileList.length) return;
  clearMessages();
  addMessage('Importing…', 'ok');
  const { added, errors } = await engine.addFiles(fileList);
  clearMessages();
  if (added) addMessage(`Added ${added} part${added === 1 ? '' : 's'}.`, 'ok');
  for (const e of errors) addMessage(`${e.name}: ${e.message}`, 'err');
}

function wireDropzone() {
  els.pickBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => { handleFiles(els.fileInput.files); els.fileInput.value = ''; });

  const dz = els.dropzone;
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  // Allow dropping anywhere on the document too.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    if (e.target.closest('.dropzone')) return; // handled above
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  });
}

// --- nesting actions ------------------------------------------------------
// Suggested export filename: the single part's name when there's just one,
// otherwise a generic name; sanitized of characters illegal in filenames.
function defaultExportName() {
  const parts = engine.parts || [];
  const named = parts.filter((p) => p.name);
  const base = named.length === 1 ? named[0].name : 'easynest-imposition';
  return `${base.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'easynest-imposition'}.pdf`;
}

function wireActions() {
  els.startBtn.addEventListener('click', () => { clearMessages(); clearLog(); currentSheet = 0; engine.start(); });
  els.stopBtn.addEventListener('click', () => engine.stop());
  els.exportBtn.addEventListener('click', async () => {
    els.exportBtn.disabled = true;
    try {
      const { warnings, cancelled } = await engine.export(defaultExportName());
      clearMessages();
      if (cancelled) {
        addMessage('Export cancelled.', 'warn');
      } else {
        addMessage('Exported PDF.', 'ok');
        for (const w of warnings) addMessage(w, 'warn');
      }
    } catch (e) {
      addMessage(`Export failed: ${e.message || e}`, 'err');
    } finally {
      els.exportBtn.disabled = !engine.canExport();
    }
  });
  els.prevSheet.addEventListener('click', () => { currentSheet = Math.max(0, currentSheet - 1); drawPreview(); });
  els.nextSheet.addEventListener('click', () => {
    const n = engine.layout ? engine.layout.sheets.length : 1;
    currentSheet = Math.min(n - 1, currentSheet + 1); drawPreview();
  });
}

// --- status ---------------------------------------------------------------
function setStatus(info) {
  const s = info.status;
  const labels = { nesting: 'Nesting…', done: 'Done', stopped: 'Stopped', idle: 'Idle' };
  els.statusPill.className = `pill ${s}`;
  els.statusPill.textContent = labels[s] || 'Idle';
  els.startBtn.disabled = s === 'nesting';
  els.stopBtn.disabled = s !== 'nesting';
  els.exportBtn.disabled = !engine.canExport();

  if (info.error) addMessage(info.error, 'err');
  if (info.unplaceable && info.unplaceable.length) {
    for (const p of info.unplaceable) {
      addMessage(`"${p.name}" is larger than the usable sheet area and cannot be placed.`, 'warn');
    }
  }
}

// --- preview --------------------------------------------------------------
function loadThumb(part) {
  if (thumbCache.has(part.id)) return thumbCache.get(part.id);
  const img = new Image();
  img.onload = () => drawPreview();
  img.src = part.thumbnail || '';
  thumbCache.set(part.id, img);
  return img;
}

// Prefer a crisp, export-quality render of the part for the sheet preview,
// rendered lazily and cached. While it's in flight, fall back to the low-res
// list thumbnail so the preview is never empty; redraw once it's ready.
function loadPreviewImage(part) {
  const ready = previewCache.get(part.id);
  if (ready) return ready;
  if (!previewPending.has(part.id)) {
    previewPending.add(part.id);
    renderPartImage(part).then((url) => {
      const img = new Image();
      img.onload = () => { previewCache.set(part.id, img); drawPreview(); };
      img.src = url || part.thumbnail || '';
    }).catch(() => {}).finally(() => previewPending.delete(part.id));
  }
  return loadThumb(part);
}

function updateStats(layout) {
  if (!layout) {
    els.util.textContent = '—'; els.sheetCount.textContent = '—'; els.placedCount.textContent = '—';
    els.sheetLabel.textContent = '— / —';
    return;
  }
  els.util.textContent = `${(layout.utilization * 100).toFixed(1)}%`;
  els.sheetCount.textContent = String(layout.sheetCount);
  const total = engine.parts.reduce((a, p) => a + (p.quantity || 0), 0);
  els.placedCount.textContent = `${layout.placed} / ${total}`;
  els.sheetLabel.textContent = `${Math.min(currentSheet + 1, layout.sheets.length)} / ${layout.sheets.length}`;
}

function drawPreview() {
  const layout = engine.layout;
  const canvas = els.canvas;
  const ctx = canvas.getContext('2d');

  if (!layout || !layout.sheets.length) {
    els.previewEmpty.style.display = 'flex';
    canvas.width = canvas.height = 0;
    updateStats(null);
    return;
  }
  els.previewEmpty.style.display = 'none';
  currentSheet = Math.min(currentSheet, layout.sheets.length - 1);

  const sp = layout.sheetPt; // points
  const stage = canvas.parentElement.getBoundingClientRect();
  const pad = 16;
  const scale = Math.min((stage.width - pad) / sp.w, (stage.height - pad) / sp.h);

  // Render at devicePixelRatio so outlines, the sheet edge, and part rasters are
  // crisp on HiDPI displays (the backing store is larger than the CSS box; all
  // drawing below stays in CSS pixels thanks to the matching ctx scale).
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(1, Math.floor(sp.w * scale));
  const cssH = Math.max(1, Math.floor(sp.h * scale));
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Sheet background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  // Margin (usable area) outline
  ctx.strokeStyle = 'rgba(79,157,255,.55)';
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(sp.margin * scale, sp.margin * scale, sp.usableW * scale, sp.usableH * scale);
  ctx.setLineDash([]);

  const placements = layout.sheets[currentSheet] || [];
  for (const pl of placements) {
    const part = pl.part;
    const img = loadPreviewImage(part);
    ctx.save();
    ctx.translate((sp.margin + pl.x) * scale, (sp.margin + pl.y) * scale);
    ctx.rotate(pl.rotation * Math.PI / 180);

    // Trace the true-shape outline (used both to clip the raster and to stroke
    // the boundary). The part raster covers the artwork's rectangular bounding
    // box; without clipping it to the real outline, vector parts that are nested
    // gap-apart still look like they overlap because their bounding-box
    // rectangles cover each other.
    const hasOutline = part.outline && part.outline.length > 2;
    if (hasOutline) {
      ctx.beginPath();
      ctx.moveTo(part.outline[0].x * scale, part.outline[0].y * scale);
      for (let i = 1; i < part.outline.length; i++) ctx.lineTo(part.outline[i].x * scale, part.outline[i].y * scale);
      ctx.closePath();
    }

    // Paint the thumbnail, clipped to the outline when we have one.
    ctx.save();
    if (hasOutline) ctx.clip();
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, 0, 0, part.width * scale, part.height * scale);
    } else {
      ctx.fillStyle = 'rgba(120,140,170,.4)';
      ctx.fillRect(0, 0, part.width * scale, part.height * scale);
    }
    ctx.restore(); // drop the clip region before stroking

    // True-shape outline overlay (current path survives the save/restore above).
    if (hasOutline) {
      ctx.strokeStyle = 'rgba(40,60,90,.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  updateStats(layout);
}

// --- engine hooks ---------------------------------------------------------
engine.onChange = () => {
  renderParts();
  els.exportBtn.disabled = !engine.canExport();
  drawPreview();
};
engine.onStatus = (info) => setStatus(info);
engine.onProgress = (layout) => {
  els.exportBtn.disabled = !engine.canExport();
  drawPreview();
};
engine.onLog = (entry) => addLog(entry.level, entry.message);

// --- init -----------------------------------------------------------------
function init() {
  if (!window.PDFLib || !window.pdfjsLib) {
    addMessage('Failed to load PDF libraries. Serve the app over http(s), not file://.', 'err');
  }
  populatePresets();
  populateCores();
  syncSettingsToUI();
  wireSettings();
  wireDropzone();
  wireActions();
  wireLog();
  renderParts();
  drawPreview();
  window.addEventListener('resize', drawPreview);
}
init();
