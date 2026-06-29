// outline.js — derives an approximate nesting outline polygon from a rendered
// raster of a part.
//
// Pipeline (per PRD): render part to a canvas, threshold it (alpha channel for
// transparent parts; background-colour removal for opaque rasters), trace a
// contour, and simplify to a polygon.
//
// This outline is consumed ONLY by the optimizer to decide placement. It is
// intentionally approximate and never participates in export, so it must not be
// trusted for fidelity — only for "where roughly does this part's ink live."

// Build a binary solid/empty mask from ImageData.
//   1 = ink/solid, 0 = background.
function buildMask(data, w, h) {
  const px = data.data;
  const mask = new Uint8Array(w * h);

  // Decide mode: if the image has meaningful transparency, threshold on alpha.
  // Otherwise treat it as opaque and remove a sampled background colour.
  let transparentPixels = 0;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] < 250) transparentPixels++;
  }
  const useAlpha = transparentPixels > w * h * 0.01;

  if (useAlpha) {
    const aThresh = 16; // alpha above this counts as ink
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      mask[i] = px[p + 3] > aThresh ? 1 : 0;
    }
    return mask;
  }

  // Opaque: sample the four corners to estimate the background colour, then
  // mark pixels that differ from it as ink.
  const corners = [
    0,
    (w - 1) * 4,
    (h - 1) * w * 4,
    ((h - 1) * w + (w - 1)) * 4,
  ];
  let br = 0, bg = 0, bb = 0;
  for (const c of corners) { br += px[c]; bg += px[c + 1]; bb += px[c + 2]; }
  br /= 4; bg /= 4; bb /= 4;

  const tol = 36; // colour-distance tolerance from background
  const tol2 = tol * tol;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const dr = px[p] - br, dg = px[p + 1] - bg, db = px[p + 2] - bb;
    mask[i] = (dr * dr + dg * dg + db * db) > tol2 ? 1 : 0;
  }
  return mask;
}

// Morphological dilation by a square kernel of the given radius. Merges nearby
// ink (e.g. separate glyphs, a piece plus its registration ticks) into one
// connected blob so we trace a single enclosing outline.
function dilate(mask, w, h, radius) {
  if (radius <= 0) return mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
      const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) out[yy * w + xx] = 1;
      }
    }
  }
  return out;
}

// Keep only the largest 4-connected component. Returns { mask, start } where
// start is the top-most/left-most solid pixel of that component, or null.
function largestComponent(mask, w, h) {
  const labels = new Int32Array(w * h).fill(0);
  const stack = [];
  let current = 0;
  let best = { size: 0, label: 0, start: null };

  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || labels[s]) continue;
    current++;
    let size = 0;
    let startIdx = s;
    stack.length = 0;
    stack.push(s);
    labels[s] = current;
    while (stack.length) {
      const idx = stack.pop();
      size++;
      if (idx < startIdx) startIdx = idx;
      const x = idx % w, y = (idx / w) | 0;
      const neigh = [];
      if (x > 0) neigh.push(idx - 1);
      if (x < w - 1) neigh.push(idx + 1);
      if (y > 0) neigh.push(idx - w);
      if (y < h - 1) neigh.push(idx + w);
      for (const n of neigh) {
        if (mask[n] && !labels[n]) { labels[n] = current; stack.push(n); }
      }
    }
    if (size > best.size) best = { size, label: current, start: startIdx };
  }

  if (!best.label) return { mask: null, start: null };
  const out = new Uint8Array(w * h);
  for (let i = 0; i < labels.length; i++) out[i] = labels[i] === best.label ? 1 : 0;
  return { mask: out, start: { x: best.start % w, y: (best.start / w) | 0 } };
}

// Moore-neighbour boundary tracing: walks clockwise around the outer contour of
// the connected component that contains `start`. Returns ordered pixel points.
function mooreTrace(mask, w, h, start) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h) ? mask[y * w + x] : 0;
  // 8-neighbour offsets, clockwise starting from west.
  const N = [
    [-1, 0], [-1, -1], [0, -1], [1, -1],
    [1, 0], [1, 1], [0, 1], [-1, 1],
  ];

  const contour = [];
  let cx = start.x, cy = start.y;
  // Direction we entered the start pixel from (came from the left).
  let backtrack = 0; // index into N pointing to the previous (background) cell
  const startX = cx, startY = cy;
  let startDir = -1;
  let safety = w * h * 8;

  do {
    contour.push({ x: cx, y: cy });
    // Search clockwise from the cell after the backtrack direction.
    let found = false;
    for (let i = 0; i < 8; i++) {
      const dir = (backtrack + 1 + i) % 8;
      const nx = cx + N[dir][0], ny = cy + N[dir][1];
      if (at(nx, ny)) {
        // The new backtrack points from the new cell back to current.
        backtrack = (dir + 4) % 8;
        cx = nx; cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated pixel
    if (startDir === -1) startDir = backtrack;
    if (--safety <= 0) break;
  } while (!(cx === startX && cy === startY && backtrack === startDir));

  return contour;
}

// Ramer–Douglas–Peucker polygon simplification.
function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();
  const tol2 = tolerance * tolerance;

  function segDist2(p, a, b) {
    let x = a.x, y = a.y;
    let dx = b.x - x, dy = b.y - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b.x; y = b.y; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p.x - x; dy = p.y - y;
    return dx * dx + dy * dy;
  }

  function rdp(first, last, pts, out) {
    let maxD = tol2, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist2(pts[i], pts[first], pts[last]);
      if (d > maxD) { idx = i; maxD = d; }
    }
    if (idx !== -1) {
      rdp(first, idx, pts, out);
      out.push(pts[idx]);
      rdp(idx, last, pts, out);
    }
  }

  const out = [points[0]];
  rdp(0, points.length - 1, points, out);
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Trace a nesting outline from a rendered raster.
 * @param {ImageData} imageData  rendered part (background should be empty/transparent or a flat colour)
 * @param {object} opts
 * @param {number} opts.scaleX   multiply pixel x by this to get physical points
 * @param {number} opts.scaleY   multiply pixel y by this to get physical points
 * @returns {Array<{x:number,y:number}>|null}  polygon in physical points, or null if nothing found
 */
export function traceOutline(imageData, opts) {
  const w = imageData.width, h = imageData.height;
  let mask = buildMask(imageData, w, h);

  // Dilate proportionally to resolution to bridge thin gaps between ink.
  const dilateRadius = Math.max(1, Math.round(Math.min(w, h) * 0.01));
  mask = dilate(mask, w, h, dilateRadius);

  const { mask: blob, start } = largestComponent(mask, w, h);
  if (!blob || !start) return null;

  const traced = mooreTrace(blob, w, h, start);
  if (traced.length < 3) return null;

  const tol = Math.max(1.5, Math.min(w, h) * 0.004);
  const simplified = simplify(traced, tol);
  if (simplified.length < 3) return null;

  // Scale pixel coordinates into physical points.
  return simplified.map((p) => ({ x: p.x * opts.scaleX, y: p.y * opts.scaleY }));
}

// Fallback outline: a rectangle at the part's physical size. Used when tracing
// fails or for parts where a bounding box is acceptable.
export function rectOutline(wPt, hPt) {
  return [
    { x: 0, y: 0 },
    { x: wPt, y: 0 },
    { x: wPt, y: hPt },
    { x: 0, y: hPt },
  ];
}
