// export.js — compose the press-ready PDF (one page per sheet) with pdf-lib.
//
// FIDELITY (the crown jewel):
//   - PDF parts are embedded as PDF pages (embedPdf), preserving content
//     streams + resources verbatim: vector geometry, named Separation/DeviceN
//     spot colors, overprint, and fonts. They are only repositioned/rotated by
//     an exact affine transform — never rasterized or recolored.
//   - SVG parts are converted to vector content operators (svgToPdf).
//   - Raster parts are embedded as native PNG/JPG at source resolution.
//
// The placement transform here is derived to exactly match the optimizer's
// result (see nest.js COORDINATE CONTRACT). Nesting space is Y-down with origin
// at the usable-area top-left; PDF is Y-up with origin at the sheet bottom-left.

import { svgToOperators, getViewBox } from './svgToPdf.js';

const PDFLib = window.PDFLib;

// Affine for placing artwork whose native frame is Y-up, origin bottom-left,
// upright, spanning w×h (PDF embedded page or raster image).
// Returns { x, y, rotateDeg } for drawPage/drawImage.
//
//   X0 = x + margin, Y0 = y + margin        (nesting placement + margin, Y-down)
//   φ  = rotation (radians)
//   anchor.x = X0 - h·sinφ
//   anchor.y = H - Y0 - h·cosφ
//   rotateDeg = -rotation                    (Y-down CW rot -> Y-up CCW negative)
function artworkAnchor(placement, partH, sheetHpt, marginPt) {
  const phi = placement.rotation * Math.PI / 180;
  const X0 = placement.x + marginPt;
  const Y0 = placement.y + marginPt;
  return {
    x: X0 - partH * Math.sin(phi),
    y: sheetHpt - Y0 - partH * Math.cos(phi),
    rotateDeg: -placement.rotation,
  };
}

// Base CTM mapping SVG user units (viewBox origin removed) to PDF page space.
function svgBaseCTM(placement, part, sheetHpt, marginPt, vb) {
  const phi = placement.rotation * Math.PI / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const s = part.width / vb.w; // points per SVG user unit (uniform)
  const X0 = placement.x + marginPt;
  const Y0 = placement.y + marginPt;
  let a = s * cos, b = -s * sin, c = -s * sin, d = -s * cos;
  let e = X0, f = sheetHpt - Y0;
  // fold viewBox origin: use (u - vb.x, v - vb.y)
  e = e - (a * vb.x + c * vb.y);
  f = f - (b * vb.x + d * vb.y);
  return [a, b, c, d, e, f];
}

// Build and serialize the export PDF. `layout.sheets` is the worker result
// mapped to parts: [[{part,x,y,rotation}...], ...].
export async function exportLayout(layout, sheetPt) {
  const { PDFDocument } = PDFLib;
  const outDoc = await PDFDocument.create();

  const sheetW = sheetPt.w, sheetH = sheetPt.h, margin = sheetPt.margin;
  const warnings = new Set();

  // Caches keyed by part.id so duplicates/multi-sheet reuse one embedded asset.
  const pdfPageCache = new Map();
  const imageCache = new Map();

  for (const sheet of layout.sheets) {
    const page = outDoc.addPage([sheetW, sheetH]);

    for (const placement of sheet) {
      const part = placement.part;
      try {
        if (part.kind === 'pdf') {
          let embedded = pdfPageCache.get(part.id);
          if (!embedded) {
            const arr = await outDoc.embedPdf(part.payload.pdfBytes, [part.payload.pageIndex]);
            embedded = arr[0];
            pdfPageCache.set(part.id, embedded);
          }
          const a = artworkAnchor(placement, part.height, sheetH, margin);
          page.drawPage(embedded, {
            x: a.x, y: a.y,
            width: part.width, height: part.height,
            rotate: PDFLib.degrees(a.rotateDeg),
          });
        } else if (part.kind === 'raster') {
          let img = imageCache.get(part.id);
          if (!img) {
            img = /png/i.test(part.payload.mime)
              ? await outDoc.embedPng(part.payload.rasterBytes)
              : await outDoc.embedJpg(part.payload.rasterBytes);
            imageCache.set(part.id, img);
          }
          const a = artworkAnchor(placement, part.height, sheetH, margin);
          page.drawImage(img, {
            x: a.x, y: a.y,
            width: part.width, height: part.height,
            rotate: PDFLib.degrees(a.rotateDeg),
          });
        } else if (part.kind === 'svg') {
          const vb = getViewBox(part.payload.svgText) || { x: 0, y: 0, w: part.width, h: part.height };
          const ctm = svgBaseCTM(placement, part, sheetH, margin, vb);
          const { ops, warnings: w } = svgToOperators(part.payload.svgText, ctm);
          page.pushOperators(...ops);
          w.forEach((msg) => warnings.add(`${part.name}: ${msg}`));
        }
      } catch (e) {
        console.error('Failed to place part on export:', part.name, e);
        warnings.add(`${part.name}: could not be embedded (${e.message || e}).`);
      }
    }
  }

  const bytes = await outDoc.save();
  return { bytes, warnings: Array.from(warnings) };
}

// Trigger a browser download of the exported bytes.
export function downloadPdf(bytes, filename = 'easynest-imposition.pdf') {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function withPdfExt(name) {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

// Saving is two-phase so the picker opens within the click's user activation —
// building the PDF can take long enough to lose it, which makes the File System
// Access picker throw. Call beginSave() first (inside the gesture), then build,
// then writeSavedPdf().
//
// Returns a target describing where to write:
//   { mode: 'fs', handle }   — user chose a location via the native save dialog
//   { mode: 'download', name } — fallback: named download to the browser folder
//   { mode: 'cancelled' }    — user dismissed the dialog
export async function beginSave(suggestedName = 'easynest-imposition.pdf') {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
      });
      return { mode: 'fs', handle };
    } catch (e) {
      if (e && e.name === 'AbortError') return { mode: 'cancelled' };
      // Picker unavailable/blocked (e.g. a sandboxed iframe) — fall through.
    }
  }
  // Fallback: at least let the user name the file (default autofilled). Choosing
  // a folder isn't possible without the File System Access API, so it lands in
  // the browser's download location.
  const name = window.prompt('Save PDF as:', suggestedName);
  if (name === null) return { mode: 'cancelled' };
  return { mode: 'download', name: withPdfExt(name.trim() || suggestedName) };
}

export async function writeSavedPdf(target, bytes) {
  if (target.mode === 'fs') {
    const writable = await target.handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  } else if (target.mode === 'download') {
    downloadPdf(bytes, target.name);
  }
}
