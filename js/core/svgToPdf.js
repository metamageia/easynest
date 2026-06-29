// svgToPdf.js — convert an SVG into pdf-lib content operators (vector, not
// rasterized) so SVG parts stay resolution-independent in the export.
//
// SVG is an RGB format; there are no spot colors to preserve here (that is a
// PDF-in → PDF-out concern). Known limitations (documented in the PRD): text,
// images, gradients, patterns, filters, and clip paths are NOT converted — the
// workaround is to pre-export such SVGs to PDF. Supported: groups + nested
// transforms, path/rect/circle/ellipse/line/polyline/polygon, solid
// fill/stroke with opacity.

const PDFLib = window.PDFLib;

// --- tiny affine matrix helpers (a b c d e f), point' = M·point ----------
const mIdentity = () => [1, 0, 0, 1, 0, 0];
function mMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function parseTransform(str) {
  let m = mIdentity();
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str))) {
    const name = t[1];
    const a = t[2].split(/[\s,]+/).map(Number).filter((n) => !isNaN(n));
    let n = mIdentity();
    if (name === 'matrix' && a.length === 6) n = a;
    else if (name === 'translate') n = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
    else if (name === 'scale') n = [a[0] || 1, 0, 0, a.length > 1 ? a[1] : a[0], 0, 0];
    else if (name === 'rotate') {
      const r = (a[0] || 0) * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
      if (a.length >= 3) {
        n = mMul([1, 0, 0, 1, a[1], a[2]], mMul([cos, sin, -sin, cos, 0, 0], [1, 0, 0, 1, -a[1], -a[2]]));
      } else n = [cos, sin, -sin, cos, 0, 0];
    } else if (name === 'skewX') n = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0];
    else if (name === 'skewY') n = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
    m = mMul(m, n);
  }
  return m;
}

// --- color parsing -------------------------------------------------------
const NAMED = {
  black: [0, 0, 0], white: [1, 1, 1], red: [1, 0, 0], green: [0, 0.5, 0],
  blue: [0, 0, 1], yellow: [1, 1, 0], cyan: [0, 1, 1], magenta: [1, 0, 1],
  gray: [0.5, 0.5, 0.5], grey: [0.5, 0.5, 0.5], silver: [0.75, 0.75, 0.75],
  orange: [1, 0.65, 0], none: null,
};
function parseColor(str) {
  if (!str) return undefined;
  str = str.trim().toLowerCase();
  if (str === 'none' || str === 'transparent') return null;
  if (str in NAMED) return NAMED[str];
  let m = str.match(/^#([0-9a-f]{3})$/);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16) / 255);
  m = str.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].substr(i, 2), 16) / 255);
  m = str.match(/^rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => s.trim());
    return p.slice(0, 3).map((v) => v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / 255);
  }
  return undefined; // unknown -> inherit
}

// Read a presentation property from attribute or inline style.
function styleProp(el, name) {
  const style = el.getAttribute('style');
  if (style) {
    const m = style.match(new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)', 'i'));
    if (m) return m[1].trim();
  }
  return el.getAttribute(name);
}

// --- path data -> emit operators in local coordinates --------------------
function emitArcAsBeziers(ops, x0, y0, rx, ry, xAxisRot, largeArc, sweep, x, y) {
  // Endpoint-to-center arc conversion, then approximate with cubic beziers.
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) { ops.push(PDFLib.lineTo(x, y)); return; }
  const phi = xAxisRot * Math.PI / 180, cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
  let r2 = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (r2 > 1) { const s = Math.sqrt(r2); rx *= s; ry *= s; }
  const sign = largeArc !== sweep ? 1 : -1;
  let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  num = Math.max(0, num);
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(num / (den || 1));
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  let theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const segs = Math.ceil(Math.abs(dTheta) / (Math.PI / 2));
  const delta = dTheta / segs;
  const t = 8 / 3 * Math.sin(delta / 4) * Math.sin(delta / 4) / Math.sin(delta / 2);
  let th = theta1;
  for (let i = 0; i < segs; i++) {
    const cos1 = Math.cos(th), sin1 = Math.sin(th);
    const th2 = th + delta, cos2 = Math.cos(th2), sin2 = Math.sin(th2);
    const p1x = cx + rx * (cosP * cos1 - sinP * sin1 * ry / rx);
    // Use proper rotated-ellipse points:
    const ept = (ct, st) => ({
      x: cx + (rx * ct * cosP - ry * st * sinP),
      y: cy + (rx * ct * sinP + ry * st * cosP),
    });
    const der = (ct, st) => ({
      x: -rx * st * cosP - ry * ct * sinP,
      y: -rx * st * sinP + ry * ct * cosP,
    });
    const e1 = ept(cos1, sin1), e2 = ept(cos2, sin2);
    const d1 = der(cos1, sin1), d2 = der(cos2, sin2);
    ops.push(PDFLib.appendBezierCurve(
      e1.x + t * d1.x, e1.y + t * d1.y,
      e2.x - t * d2.x, e2.y - t * d2.y,
      e2.x, e2.y));
    th = th2;
  }
}

function emitPathData(ops, d) {
  const tokens = d.match(/[a-zA-Z]|-?\.?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/g) || [];
  let i = 0;
  const next = () => parseFloat(tokens[i++]);
  let cmd = '', cx = 0, cy = 0, sx = 0, sy = 0;
  let prevCtrlX = null, prevCtrlY = null;
  let started = false;
  const isCmd = (t) => /[a-zA-Z]/.test(t);

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    const rel = cmd >= 'a';
    const C = cmd.toUpperCase();
    const rx = (v) => rel ? cx + v : v;
    const ry = (v) => rel ? cy + v : v;
    let x1, y1, x2, y2, ex, ey;
    switch (C) {
      case 'M':
        ex = rx(next()); ey = ry(next());
        ops.push(PDFLib.moveTo(ex, ey)); cx = ex; cy = ey; sx = ex; sy = ey;
        started = true; cmd = (cmd === 'm') ? 'l' : 'L'; prevCtrlX = prevCtrlY = null;
        break;
      case 'L':
        ex = rx(next()); ey = ry(next());
        ops.push(PDFLib.lineTo(ex, ey)); cx = ex; cy = ey; prevCtrlX = prevCtrlY = null;
        break;
      case 'H':
        ex = rel ? cx + next() : next();
        ops.push(PDFLib.lineTo(ex, cy)); cx = ex; prevCtrlX = prevCtrlY = null;
        break;
      case 'V':
        ey = rel ? cy + next() : next();
        ops.push(PDFLib.lineTo(cx, ey)); cy = ey; prevCtrlX = prevCtrlY = null;
        break;
      case 'C':
        x1 = rx(next()); y1 = ry(next()); x2 = rx(next()); y2 = ry(next()); ex = rx(next()); ey = ry(next());
        ops.push(PDFLib.appendBezierCurve(x1, y1, x2, y2, ex, ey));
        prevCtrlX = x2; prevCtrlY = y2; cx = ex; cy = ey;
        break;
      case 'S':
        x1 = (prevCtrlX != null) ? 2 * cx - prevCtrlX : cx;
        y1 = (prevCtrlY != null) ? 2 * cy - prevCtrlY : cy;
        x2 = rx(next()); y2 = ry(next()); ex = rx(next()); ey = ry(next());
        ops.push(PDFLib.appendBezierCurve(x1, y1, x2, y2, ex, ey));
        prevCtrlX = x2; prevCtrlY = y2; cx = ex; cy = ey;
        break;
      case 'Q': {
        const qx = rx(next()), qy = ry(next()); ex = rx(next()); ey = ry(next());
        // quadratic -> cubic
        const c1x = cx + 2 / 3 * (qx - cx), c1y = cy + 2 / 3 * (qy - cy);
        const c2x = ex + 2 / 3 * (qx - ex), c2y = ey + 2 / 3 * (qy - ey);
        ops.push(PDFLib.appendBezierCurve(c1x, c1y, c2x, c2y, ex, ey));
        prevCtrlX = qx; prevCtrlY = qy; cx = ex; cy = ey;
        break;
      }
      case 'T': {
        const qx = (prevCtrlX != null) ? 2 * cx - prevCtrlX : cx;
        const qy = (prevCtrlY != null) ? 2 * cy - prevCtrlY : cy;
        ex = rx(next()); ey = ry(next());
        const c1x = cx + 2 / 3 * (qx - cx), c1y = cy + 2 / 3 * (qy - cy);
        const c2x = ex + 2 / 3 * (qx - ex), c2y = ey + 2 / 3 * (qy - ey);
        ops.push(PDFLib.appendBezierCurve(c1x, c1y, c2x, c2y, ex, ey));
        prevCtrlX = qx; prevCtrlY = qy; cx = ex; cy = ey;
        break;
      }
      case 'A': {
        const arx = next(), ary = next(), rot = next(), large = next(), sweep = next();
        ex = rx(next()); ey = ry(next());
        emitArcAsBeziers(ops, cx, cy, arx, ary, rot, large, sweep, ex, ey);
        cx = ex; cy = ey; prevCtrlX = prevCtrlY = null;
        break;
      }
      case 'Z':
        ops.push(PDFLib.closePath()); cx = sx; cy = sy; prevCtrlX = prevCtrlY = null;
        break;
      default:
        i++; // skip unknown token to avoid infinite loop
    }
    if (!started) break;
  }
}

// Build local path operators for a single shape element. Returns true if any
// geometry was emitted.
function emitShape(ops, el) {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'path': {
      const d = el.getAttribute('d');
      if (!d) return false;
      emitPathData(ops, d);
      return true;
    }
    case 'rect': {
      const x = +el.getAttribute('x') || 0, y = +el.getAttribute('y') || 0;
      const w = +el.getAttribute('width') || 0, h = +el.getAttribute('height') || 0;
      if (w <= 0 || h <= 0) return false;
      ops.push(PDFLib.moveTo(x, y), PDFLib.lineTo(x + w, y), PDFLib.lineTo(x + w, y + h), PDFLib.lineTo(x, y + h), PDFLib.closePath());
      return true;
    }
    case 'circle': {
      const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0, r = +el.getAttribute('r') || 0;
      if (r <= 0) return false;
      emitEllipse(ops, cx, cy, r, r);
      return true;
    }
    case 'ellipse': {
      const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0;
      const rx = +el.getAttribute('rx') || 0, ry = +el.getAttribute('ry') || 0;
      if (rx <= 0 || ry <= 0) return false;
      emitEllipse(ops, cx, cy, rx, ry);
      return true;
    }
    case 'line': {
      const x1 = +el.getAttribute('x1') || 0, y1 = +el.getAttribute('y1') || 0;
      const x2 = +el.getAttribute('x2') || 0, y2 = +el.getAttribute('y2') || 0;
      ops.push(PDFLib.moveTo(x1, y1), PDFLib.lineTo(x2, y2));
      return true;
    }
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') || '').split(/[\s,]+/).map(Number).filter((n) => !isNaN(n));
      if (pts.length < 4) return false;
      ops.push(PDFLib.moveTo(pts[0], pts[1]));
      for (let k = 2; k + 1 < pts.length; k += 2) ops.push(PDFLib.lineTo(pts[k], pts[k + 1]));
      if (tag === 'polygon') ops.push(PDFLib.closePath());
      return true;
    }
    default:
      return false;
  }
}

function emitEllipse(ops, cx, cy, rx, ry) {
  const k = 0.5522847498;
  ops.push(PDFLib.moveTo(cx + rx, cy));
  ops.push(PDFLib.appendBezierCurve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry));
  ops.push(PDFLib.appendBezierCurve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy));
  ops.push(PDFLib.appendBezierCurve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry));
  ops.push(PDFLib.appendBezierCurve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy));
  ops.push(PDFLib.closePath());
}

// Walk the SVG tree emitting operators. `inherited` carries fill/stroke down.
function walk(ops, el, inherited, warnings) {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'defs' || tag === 'symbol' || tag === 'clippath' || tag === 'mask') continue;
    if (tag === 'text' || tag === 'image' || tag === 'use' || tag === 'foreignobject') {
      warnings.add(`<${tag}> not vector-converted`);
      continue;
    }

    const tf = parseTransform(child.getAttribute('transform'));
    const hasTf = tf.some((v, k) => v !== mIdentity()[k]);
    if (hasTf) ops.push(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(...tf));

    // resolve style with inheritance
    const fillRaw = parseColor(styleProp(child, 'fill'));
    const strokeRaw = parseColor(styleProp(child, 'stroke'));
    const fill = fillRaw === undefined ? inherited.fill : fillRaw;
    const stroke = strokeRaw === undefined ? inherited.stroke : strokeRaw;
    const swRaw = styleProp(child, 'stroke-width');
    const strokeWidth = swRaw != null ? parseFloat(swRaw) : inherited.strokeWidth;

    if (tag === 'g' || tag === 'svg') {
      walk(ops, child, { fill, stroke, strokeWidth }, warnings);
    } else {
      const shapeOps = [];
      const drew = emitShape(shapeOps, child);
      if (drew) {
        const doFill = fill !== null && fill !== undefined;
        const doStroke = stroke != null && stroke !== undefined && (strokeWidth == null || strokeWidth > 0);
        if (doFill) ops.push(PDFLib.setFillingColor(PDFLib.rgb(fill[0], fill[1], fill[2])));
        if (doStroke) {
          ops.push(PDFLib.setStrokingColor(PDFLib.rgb(stroke[0], stroke[1], stroke[2])));
          ops.push(PDFLib.setLineWidth(strokeWidth == null ? 1 : strokeWidth));
        }
        ops.push(...shapeOps);
        if (doFill && doStroke) ops.push(PDFLib.fillAndStroke());
        else if (doStroke) ops.push(PDFLib.stroke());
        else ops.push(PDFLib.fill());
      }
    }

    if (hasTf) ops.push(PDFLib.popGraphicsState());
  }
}

/**
 * Convert an SVG string into pdf-lib operators rendered under `baseCTM`
 * (which maps SVG user units, with the viewBox origin already removed, to PDF
 * page space). Returns { ops, warnings }.
 */
export function svgToOperators(svgText, baseCTM) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  const warnings = new Set();

  const ops = [PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(...baseCTM)];
  // default SVG fill is black, no stroke
  walk(ops, svg, { fill: [0, 0, 0], stroke: undefined, strokeWidth: 1 }, warnings);
  ops.push(PDFLib.popGraphicsState());

  return { ops, warnings: Array.from(warnings) };
}

// Parse a viewBox -> {x,y,w,h} or null.
export function getViewBox(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  // fall back to width/height numbers
  const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
  if (w > 0 && h > 0) return { x: 0, y: 0, w, h };
  return null;
}
