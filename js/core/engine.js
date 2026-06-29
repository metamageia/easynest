// engine.js — the headless core the UI talks to. The UI never touches the
// vendored libraries or the worker directly; it goes through this engine.

import { importFiles, resizePart } from './importers.js';
import { loadSettings, saveSettings } from './storage.js';
import { NestRunner, sheetToPoints, findUnplaceable } from './nest.js';
import { exportLayout, downloadPdf } from './export.js';

export class Engine {
  constructor() {
    this.parts = [];
    this.settings = loadSettings();
    this.layout = null;            // last result from the optimizer
    this.status = 'idle';          // 'idle' | 'nesting' | 'done' | 'stopped'
    this.runner = new NestRunner();
    this.seed = 1;
    // UI hooks (set by main.js)
    this.onChange = () => {};       // parts/settings changed
    this.onStatus = () => {};       // nesting status changed
    this.onProgress = () => {};     // new (partial or final) layout / utilization
    this.onLog = () => {};          // a worker event-log line
  }

  // --- parts -------------------------------------------------------------
  async addFiles(fileList) {
    const { parts, errors } = await importFiles(fileList);
    this.parts.push(...parts);
    this.invalidateLayout();
    this.onChange();
    return { added: parts.length, errors };
  }

  removePart(id) {
    this.parts = this.parts.filter((p) => p.id !== id);
    this.invalidateLayout();
    this.onChange();
  }

  setQuantity(id, qty) {
    const part = this.parts.find((p) => p.id === id);
    if (!part) return;
    part.quantity = Math.max(0, Math.floor(qty) || 0);
    this.invalidateLayout();
    this.onChange();
  }

  // override: { mode:'dpi', dpi } | { mode:'explicit', widthPt, heightPt }
  resizePart(id, override) {
    const part = this.parts.find((p) => p.id === id);
    if (!part || !part.sizing) return;
    resizePart(part, override);
    this.invalidateLayout();
    this.onChange();
  }

  // --- settings ----------------------------------------------------------
  updateSettings(patch) {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    this.invalidateLayout();
    this.onChange();
  }

  // --- nesting -----------------------------------------------------------
  start() {
    const sheetPt = sheetToPoints(this.settings);
    const active = this.parts.filter((p) => p.quantity > 0);
    if (active.length === 0) {
      this.onStatus({ status: this.status, error: 'Add parts and set a quantity before nesting.' });
      return;
    }
    const unplaceable = findUnplaceable(active, sheetPt);

    this.status = 'nesting';
    this.onStatus({ status: this.status, unplaceable });

    this.runner.start(
      { parts: active, sheetPt, settings: this.settings, seed: this.seed },
      {
        onPlacement: (result) => {
          this.layout = { ...result, sheetPt };
          this.onProgress(this.layout);
        },
        onLog: (entry) => this.onLog(entry),
        onDone: (info) => {
          // A single pass finished. Stay 'done' (not 'idle') so the result
          // stands until parts/settings change.
          if (this.status === 'nesting') {
            this.status = 'done';
            this.onStatus({ status: this.status, ...info });
          }
        },
        onError: (err) => {
          this.status = 'idle';
          this.onStatus({ status: this.status, error: err.message || String(err) });
        },
      }
    );
  }

  stop() {
    this.runner.stop();
    if (this.status === 'nesting') {
      this.status = 'stopped';
      this.onStatus({ status: this.status });
    }
  }

  invalidateLayout() {
    // Parts/settings changed: any existing layout is stale.
    if (this.status === 'nesting') this.stop();
    this.layout = null;
    this.status = 'idle';
  }

  // --- export ------------------------------------------------------------
  canExport() {
    return !!(this.layout && this.layout.sheets && this.layout.sheets.length > 0);
  }

  async export() {
    if (!this.canExport()) throw new Error('No layout to export yet.');
    const { bytes, warnings } = await exportLayout(this.layout, this.layout.sheetPt);
    downloadPdf(bytes);
    return { warnings };
  }
}
