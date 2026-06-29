// main.js — the UI shell. Talks only to the Engine; renders parts, settings,
// and the paged sheet preview; drives start/stop/export.

import { Engine } from './core/engine.js';
import {
  SHEET_PRESETS, presetInUnits, fromPoints, toPoints, formatLength, UNIT_LABEL,
} from './core/units.js';

const engine = new Engine();
let currentSheet = 0;
const thumbCache = new Map(); // part.id -> HTMLImageElement

// --- element refs ---------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'), fileInput: $('file-input'), pickBtn: $('pick-btn'),
  partsList: $('parts-list'), partsEmpty: $('parts-empty'),
  presetSelect: $('preset-select'), sheetW: $('sheet-w'), sheetH: $('sheet-h'),
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
function dims(part) {
  const u = UNIT_LABEL[engine.settings.units];
  return `${formatLength(part.width, engine.settings.units)} × ${formatLength(part.height, engine.settings.units)} ${u}`;
}

function renderParts() {
  els.partsList.innerHTML = '';
  els.partsEmpty.style.display = engine.parts.length ? 'none' : 'block';

  for (const part of engine.parts) {
    const li = document.createElement('li');
    li.className = 'part';

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = part.thumbnail || '';
    thumb.alt = part.name;

    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML =
      `<div class="name" title="${escapeHtml(part.name)}">${escapeHtml(part.name)}</div>` +
      `<div class="meta"><span class="kind-tag">${part.kind}</span> ${dims(part)}</div>`;
    if (part.sizing && (part.kind === 'raster' || part.kind === 'svg')) {
      const dpiRow = document.createElement('div');
      dpiRow.className = 'dpi-row';
      dpiRow.innerHTML = `<span>DPI</span>`;
      const dpiInput = document.createElement('input');
      dpiInput.type = 'number'; dpiInput.min = '1'; dpiInput.step = '1';
      dpiInput.value = Math.round(part.sizing.dpi || 300);
      dpiInput.title = 'Assumed resolution — change to resize this part';
      dpiInput.addEventListener('change', () => {
        const dpi = parseFloat(dpiInput.value);
        if (dpi > 0) engine.resizePart(part.id, { mode: 'dpi', dpi });
      });
      dpiRow.appendChild(dpiInput);
      info.appendChild(dpiRow);
    }
    for (const w of (part.warnings || [])) {
      const wEl = document.createElement('div');
      wEl.className = 'warn'; wEl.textContent = w;
      info.appendChild(wEl);
    }

    const controls = document.createElement('div');
    controls.className = 'controls';
    const qty = document.createElement('div');
    qty.className = 'qty';
    const minus = button('−', 'btn small');
    const qtyInput = document.createElement('input');
    qtyInput.type = 'number'; qtyInput.min = '0'; qtyInput.value = part.quantity;
    const plus = button('+', 'btn small');
    minus.addEventListener('click', () => engine.setQuantity(part.id, part.quantity - 1));
    plus.addEventListener('click', () => engine.setQuantity(part.id, part.quantity + 1));
    qtyInput.addEventListener('change', () => engine.setQuantity(part.id, parseInt(qtyInput.value, 10)));
    qty.append(minus, qtyInput, plus);

    const remove = document.createElement('button');
    remove.className = 'icon-btn'; remove.title = 'Remove part'; remove.textContent = '✕';
    remove.addEventListener('click', () => engine.removePart(part.id));

    controls.append(qty, remove);
    li.append(thumb, info, controls);
    els.partsList.appendChild(li);
  }
}

function button(label, cls) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = label;
  return b;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- settings -------------------------------------------------------------
function populatePresets() {
  els.presetSelect.innerHTML = '';
  for (const p of SHEET_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    els.presetSelect.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = 'custom'; custom.textContent = 'Custom';
  els.presetSelect.appendChild(custom);
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
}
function round(v) { return Math.round(v * 1000) / 1000; }

function wireSettings() {
  els.presetSelect.addEventListener('change', () => {
    const id = els.presetSelect.value;
    if (id === 'custom') { engine.updateSettings({ presetId: 'custom' }); return; }
    const preset = SHEET_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const d = presetInUnits(preset, engine.settings.units);
    engine.updateSettings({ presetId: id, sheetW: round(d.w), sheetH: round(d.h) });
    syncSettingsToUI();
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
      if (patch.presetId) els.presetSelect.value = 'custom';
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
function wireActions() {
  els.startBtn.addEventListener('click', () => { clearMessages(); clearLog(); currentSheet = 0; engine.start(); });
  els.stopBtn.addEventListener('click', () => engine.stop());
  els.exportBtn.addEventListener('click', async () => {
    els.exportBtn.disabled = true;
    addMessage('Building PDF…', 'ok');
    try {
      const { warnings } = await engine.export();
      clearMessages();
      addMessage('Exported PDF.', 'ok');
      for (const w of warnings) addMessage(w, 'warn');
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
  canvas.width = Math.max(1, Math.floor(sp.w * scale));
  canvas.height = Math.max(1, Math.floor(sp.h * scale));

  // Sheet background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Margin (usable area) outline
  ctx.strokeStyle = 'rgba(79,157,255,.55)';
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(sp.margin * scale, sp.margin * scale, sp.usableW * scale, sp.usableH * scale);
  ctx.setLineDash([]);

  const placements = layout.sheets[currentSheet] || [];
  for (const pl of placements) {
    const part = pl.part;
    const img = loadThumb(part);
    ctx.save();
    ctx.translate((sp.margin + pl.x) * scale, (sp.margin + pl.y) * scale);
    ctx.rotate(pl.rotation * Math.PI / 180);
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, 0, 0, part.width * scale, part.height * scale);
    } else {
      ctx.fillStyle = 'rgba(120,140,170,.4)';
      ctx.fillRect(0, 0, part.width * scale, part.height * scale);
    }
    // True-shape outline overlay
    if (part.outline && part.outline.length > 2) {
      ctx.beginPath();
      ctx.moveTo(part.outline[0].x * scale, part.outline[0].y * scale);
      for (let i = 1; i < part.outline.length; i++) ctx.lineTo(part.outline[i].x * scale, part.outline[i].y * scale);
      ctx.closePath();
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
