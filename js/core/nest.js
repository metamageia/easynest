// nest.js — builds a nest job from parts + sheet config, drives the optimizer
// worker, and maps raw worker placements back to parts.
//
// COORDINATE CONTRACT (shared by preview and export so they always agree):
//   - All nesting math is in points, in a Y-DOWN frame whose origin is the
//     top-left corner of the USABLE area (the sheet inset by its margin).
//   - A part's local outline coordinates have their origin at the artwork's
//     top-left corner, +x right, +y down, spanning ~[0..w] × [0..h].
//   - A placement {x, y, rotation} means: rotate the part's local coordinates
//     by `rotation` degrees about the local origin (0,0), then translate by
//     (x, y). The same transform applies to the artwork on export.
//   - To get sheet coordinates, add the margin offset (margin, margin).

import { toPoints } from './units.js';

const CLIPPER_SCALE = 10000000;

// Build the optimizer job. Returns { tree, bin, config, meta } in a form that
// survives structured-clone postMessage (plain objects, no array expandos —
// the worker rebuilds polygon arrays + their id/source/width tags).
// meta[treeId] = { part } lets us map a placement back to its source part.
export function buildJob(parts, sheetPt, settings) {
  const tree = [];
  const meta = [];

  for (const part of parts) {
    const q = Math.max(0, Math.floor(part.quantity || 0));
    for (let n = 0; n < q; n++) {
      const id = tree.length;
      tree.push({
        points: part.outline.map((p) => ({ x: p.x, y: p.y })),
        id,
        source: part.id,
      });
      meta.push({ part });
    }
  }

  const bin = {
    points: [
      { x: 0, y: 0 },
      { x: sheetPt.usableW, y: 0 },
      { x: sheetPt.usableW, y: sheetPt.usableH },
      { x: 0, y: sheetPt.usableH },
    ],
    width: sheetPt.usableW,
    height: sheetPt.usableH,
  };

  const config = {
    clipperScale: CLIPPER_SCALE,
    curveTolerance: 0.3,
    spacing: sheetPt.gap,
    rotations: Math.max(1, settings.rotations || 4),
    populationSize: 10,
    mutationRate: 10,
    useHoles: false,
    exploreConcave: false,
  };

  return { tree, bin, config, meta };
}

// Convert a sheet config (in display units) to points + usable area.
export function sheetToPoints(settings) {
  const w = toPoints(settings.sheetW, settings.units);
  const h = toPoints(settings.sheetH, settings.units);
  const margin = toPoints(settings.margin, settings.units);
  const gap = toPoints(settings.gap, settings.units);
  return {
    w, h, margin, gap,
    usableW: Math.max(1, w - 2 * margin),
    usableH: Math.max(1, h - 2 * margin),
  };
}

// Identify parts that cannot fit the usable area even when rotated, so the UI
// can warn rather than silently drop them (PRD story 38).
export function findUnplaceable(parts, sheetPt) {
  const uW = sheetPt.usableW, uH = sheetPt.usableH;
  const bad = [];
  for (const part of parts) {
    if (part.quantity <= 0) continue;
    const w = part.width, h = part.height;
    const fitsUpright = w <= uW && h <= uH;
    const fitsRotated = h <= uW && w <= uH;
    if (!fitsUpright && !fitsRotated) bad.push(part);
  }
  return bad;
}

// Rotate a local point by degrees (Y-down frame) then translate — the canonical
// placement transform, used by preview and export.
export function transformPoint(pt, placement) {
  const a = placement.rotation * Math.PI / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return {
    x: pt.x * cos - pt.y * sin + placement.x,
    y: pt.x * sin + pt.y * cos + placement.y,
  };
}

export class NestRunner {
  constructor() {
    this.worker = null;
    this.running = false;
  }

  // callbacks: { onPlacement(result), onLog(entry), onDone(info), onError(err) }
  // result: { sheets:[[{part,x,y,rotation}]], utilization, sheetCount, placed, total, unplaced, final }
  start({ parts, sheetPt, settings, seed, cores }, callbacks) {
    this.stop();
    const { tree, bin, config, meta } = buildJob(parts, sheetPt, settings);
    if (tree.length === 0) {
      callbacks.onError && callbacks.onError(new Error('No parts to nest (check quantities).'));
      return false;
    }

    this.worker = new Worker(new URL('../worker/nest.worker.js', import.meta.url));
    this.running = true;

    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'placement') {
        const sheets = msg.placements.map((sheet) =>
          sheet.map((p) => ({
            part: meta[p.id].part,
            x: p.x,
            y: p.y,
            rotation: p.rotation,
          }))
        );
        callbacks.onPlacement && callbacks.onPlacement({
          sheets,
          utilization: msg.utilization,
          sheetCount: msg.sheets,
          placed: msg.placed,
          total: msg.total,
          unplaced: msg.unplaced,
          final: msg.final,
        });
      } else if (msg.type === 'log') {
        callbacks.onLog && callbacks.onLog({ level: msg.level, message: msg.message });
      } else if (msg.type === 'done') {
        this.running = false;
        callbacks.onDone && callbacks.onDone({ placed: msg.placed, unplaced: msg.unplaced });
      }
    };
    this.worker.onerror = (e) => {
      console.error('Nest worker error:', e);
      callbacks.onError && callbacks.onError(e);
    };

    this.worker.postMessage({ cmd: 'start', tree, bin, config, seed, cores: Math.max(1, cores | 0) || 1 });
    return true;
  }

  stop() {
    this.running = false;
    if (this.worker) {
      try { this.worker.postMessage({ cmd: 'stop' }); } catch (e) { /* ignore */ }
      this.worker.terminate();
      this.worker = null;
    }
  }
}
