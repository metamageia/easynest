// importers.js — turn dropped/selected files into normalized Parts.
//
// A Part is the universal nestable unit:
//   {
//     id, name, kind: 'pdf'|'svg'|'raster',
//     width, height,        // intrinsic physical size in points (1:1 for vector)
//     quantity,
//     outline,              // approximate nesting polygon in points (throwaway)
//     thumbnail,            // dataURL for the parts list
//     warnings: string[],
//     sizing,               // raster/unitless-svg sizing: {mode,dpi} (null for vector)
//     payload,              // ORIGINAL artwork, kept untouched for export
//   }
//
// Fidelity rule: the payload is never altered. PDF parts keep their original
// bytes + page index; SVG keeps its source text; raster keeps its source bytes.

import { traceOutline, rectOutline } from './outline.js';
import { PT_PER_IN, PT_PER_MM } from './units.js';

const DEFAULT_DPI = 300;
const TRACE_PX = 500;     // longest-side resolution used for outline tracing
const THUMB_PX = 160;     // thumbnail longest side

let _idCounter = 0;
function nextId() {
  _idCounter++;
  return `part_${Date.now().toString(36)}_${_idCounter}`;
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Downscale a source canvas to a thumbnail dataURL.
function toThumbnail(srcCanvas) {
  const scale = THUMB_PX / Math.max(srcCanvas.width, srcCanvas.height);
  if (scale >= 1) return srcCanvas.toDataURL('image/png');
  const t = makeCanvas(srcCanvas.width * scale, srcCanvas.height * scale);
  const ctx = t.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/png');
}

// Derive an outline (in points) from a rendered canvas, with a rectangle
// fallback if tracing fails.
function outlineFromCanvas(canvas, widthPt, heightPt) {
  try {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const traced = traceOutline(img, {
      scaleX: widthPt / canvas.width,
      scaleY: heightPt / canvas.height,
    });
    if (traced && traced.length >= 3) return traced;
  } catch (e) {
    console.warn('Outline trace failed, using bounding box:', e);
  }
  return rectOutline(widthPt, heightPt);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function importPdf(file) {
  const buffer = await readAsArrayBuffer(file);
  const originalBytes = new Uint8Array(buffer);
  // pdf.js may detach the buffer it parses, so hand it a private copy and keep
  // the pristine original for export.
  const parseCopy = originalBytes.slice();

  const pdfjsLib = window.pdfjsLib;
  const loadingTask = pdfjsLib.getDocument({ data: parseCopy });
  const pdf = await loadingTask.promise;

  const parts = [];
  const baseName = file.name.replace(/\.pdf$/i, '');

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 }); // viewport units == points
    const widthPt = vp1.width;
    const heightPt = vp1.height;

    const traceScale = TRACE_PX / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale: traceScale });
    const canvas = makeCanvas(vp.width, vp.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const outline = outlineFromCanvas(canvas, widthPt, heightPt);
    const thumbnail = toThumbnail(canvas);

    parts.push({
      id: nextId(),
      name: pdf.numPages > 1 ? `${baseName} — p${i}` : baseName,
      kind: 'pdf',
      width: widthPt,
      height: heightPt,
      quantity: 1,
      outline,
      thumbnail,
      warnings: [],
      sizing: null,
      payload: {
        pdfBytes: originalBytes,
        pageIndex: i - 1, // 0-based for pdf-lib
      },
    });
    page.cleanup();
  }
  await pdf.cleanup();
  return parts;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

// Parse an absolute SVG length (e.g. "12mm", "1in", "100pt") into points.
// Returns null for px / unitless values, which are sized by assumed DPI.
function svgLengthToPoints(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^([\d.+-eE]+)\s*([a-z%]*)$/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!isFinite(value)) return null;
  switch (m[2]) {
    case 'in': return value * PT_PER_IN;
    case 'mm': return value * PT_PER_MM;
    case 'cm': return value * (PT_PER_MM * 10);
    case 'pt': return value;
    case 'pc': return value * 12;
    case '': case 'px': return null; // sized by DPI
    default: return null;
  }
}

async function importSvg(file) {
  const text = await readAsText(file);
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;

  const warnings = [];
  let widthPt = svgLengthToPoints(svg.getAttribute('width'));
  let heightPt = svgLengthToPoints(svg.getAttribute('height'));
  let sizing = null;

  if (widthPt == null || heightPt == null) {
    // No absolute dimensions: fall back to the viewBox sized at assumed DPI.
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    let unitW, unitH;
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      unitW = vb[2]; unitH = vb[3];
    } else {
      unitW = parseFloat(svg.getAttribute('width')) || 300;
      unitH = parseFloat(svg.getAttribute('height')) || 300;
    }
    sizing = { mode: 'dpi', dpi: DEFAULT_DPI, unitW, unitH };
    widthPt = (unitW / DEFAULT_DPI) * PT_PER_IN;
    heightPt = (unitH / DEFAULT_DPI) * PT_PER_IN;
    warnings.push(`No absolute size in SVG; assumed ${DEFAULT_DPI} DPI.`);
  }

  // Render the SVG to a canvas for thumbnail + outline tracing.
  const canvas = await rasterizeSvg(text, widthPt, heightPt);
  const outline = canvas
    ? outlineFromCanvas(canvas, widthPt, heightPt)
    : rectOutline(widthPt, heightPt);
  const thumbnail = canvas ? toThumbnail(canvas) : '';

  return [{
    id: nextId(),
    name: file.name.replace(/\.svg$/i, ''),
    kind: 'svg',
    width: widthPt,
    height: heightPt,
    quantity: 1,
    outline,
    thumbnail,
    warnings,
    sizing,
    payload: { svgText: text },
  }];
}

// Rasterize an SVG string into a canvas via an <img> + blob URL.
function rasterizeSvg(text, widthPt, heightPt) {
  return new Promise((resolve) => {
    const aspect = heightPt / widthPt;
    const cw = TRACE_PX, ch = Math.max(1, Math.round(TRACE_PX * aspect));
    const blob = new Blob([text], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = makeCanvas(cw, ch);
      const ctx = canvas.getContext('2d');
      try {
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        resolve(canvas);
      } catch (e) {
        URL.revokeObjectURL(url);
        resolve(null);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Raster (PNG / JPG)
// ---------------------------------------------------------------------------

async function importRaster(file) {
  const buffer = await readAsArrayBuffer(file);
  const bytes = new Uint8Array(buffer);
  const mime = file.type || (/\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg');

  const { canvas, pixelW, pixelH } = await loadRaster(bytes, mime);
  const dpi = DEFAULT_DPI;
  const widthPt = (pixelW / dpi) * PT_PER_IN;
  const heightPt = (pixelH / dpi) * PT_PER_IN;

  const outline = outlineFromCanvas(canvas, widthPt, heightPt);
  const thumbnail = toThumbnail(canvas);

  return [{
    id: nextId(),
    name: file.name.replace(/\.(png|jpe?g)$/i, ''),
    kind: 'raster',
    width: widthPt,
    height: heightPt,
    quantity: 1,
    outline,
    thumbnail,
    warnings: [],
    sizing: { mode: 'dpi', dpi, pixelW, pixelH },
    payload: { rasterBytes: bytes, mime, pixelW, pixelH },
  }];
}

function loadRaster(bytes, mime) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const pixelW = img.naturalWidth, pixelH = img.naturalHeight;
      const scale = Math.min(1, TRACE_PX / Math.max(pixelW, pixelH));
      const canvas = makeCanvas(pixelW * scale, pixelH * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve({ canvas, pixelW, pixelH });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Re-size a raster (or unitless SVG) part after a DPI / dimension override.
// Recomputes physical size and rescales the existing outline in place.
// ---------------------------------------------------------------------------

export function resizePart(part, override) {
  // override: { mode:'dpi', dpi } | { mode:'explicit', widthPt, heightPt }
  const oldW = part.width, oldH = part.height;
  if (override.mode === 'dpi') {
    const px = part.sizing.pixelW || part.sizing.unitW;
    const py = part.sizing.pixelH || part.sizing.unitH;
    part.width = (px / override.dpi) * PT_PER_IN;
    part.height = (py / override.dpi) * PT_PER_IN;
    part.sizing = { ...part.sizing, mode: 'dpi', dpi: override.dpi };
  } else if (override.mode === 'explicit') {
    part.width = override.widthPt;
    part.height = override.heightPt;
    part.sizing = { ...part.sizing, mode: 'explicit' };
  }
  // Rescale the outline to match the new physical size.
  const sx = part.width / oldW, sy = part.height / oldH;
  part.outline = part.outline.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  return part;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function classify(file) {
  const name = (file.name || '').toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (file.type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
  if (/image\/(png|jpe?g)/.test(file.type) || /\.(png|jpe?g)$/.test(name)) return 'raster';
  return null;
}

// Import a single file into one or more parts. Throws on unsupported / failed.
export async function importFile(file) {
  const kind = classify(file);
  if (!kind) throw new Error(`Unsupported file type: ${file.name}`);
  if (kind === 'pdf') return importPdf(file);
  if (kind === 'svg') return importSvg(file);
  return importRaster(file);
}

// Import many files; returns { parts, errors }.
export async function importFiles(fileList) {
  const files = Array.from(fileList);
  const parts = [];
  const errors = [];
  for (const file of files) {
    try {
      const result = await importFile(file);
      parts.push(...result);
    } catch (e) {
      console.error('Import failed:', file.name, e);
      errors.push({ name: file.name, message: e.message || String(e) });
    }
  }
  return { parts, errors };
}
