// nest.worker.js — the nesting optimizer, forked from SVGnest's pure-JS core.
//
// This is a single self-contained web worker. Unlike upstream SVGnest (which
// fans NFP computation out to nested `Parallel` workers and is coupled to the
// SVG DOM), this fork:
//   - works on plain polygon outlines (no DOM, no SVG parsing),
//   - computes No-Fit-Polygons and placements synchronously inside one worker,
//   - runs the genetic optimizer continuously, posting progressively better
//     layouts back to the main thread until told to stop,
//   - supports a seeded RNG so a given job + seed is reproducible.
//
// Geometry (NFP, areas, bounds) comes from vendored GeometryUtil; polygon
// boolean/offset ops come from vendored ClipperLib.

importScripts('../vendor/svgnest/clipper.js');
importScripts('../vendor/svgnest/geometryutil.js');

// clipper.js warns via alert(); stub it in the worker scope.
function alert(message) { /* no-op */ }

// --- seedable RNG (mulberry32) -------------------------------------------
let _rand = Math.random;
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- geometry helpers (ported from SVGnest) ------------------------------

function rotatePolygon(polygon, degrees) {
  const rotated = [];
  const angle = degrees * Math.PI / 180;
  for (let i = 0; i < polygon.length; i++) {
    const x = polygon[i].x, y = polygon[i].y;
    rotated.push({
      x: x * Math.cos(angle) - y * Math.sin(angle),
      y: x * Math.sin(angle) + y * Math.cos(angle),
    });
  }
  if (polygon.children && polygon.children.length > 0) {
    rotated.children = [];
    for (let j = 0; j < polygon.children.length; j++) {
      rotated.children.push(rotatePolygon(polygon.children[j], degrees));
    }
  }
  return rotated;
}

function toClipperCoordinates(polygon) {
  const clone = [];
  for (let i = 0; i < polygon.length; i++) clone.push({ X: polygon[i].x, Y: polygon[i].y });
  return clone;
}

function toNestCoordinates(polygon, scale) {
  const clone = [];
  for (let i = 0; i < polygon.length; i++) clone.push({ x: polygon[i].X / scale, y: polygon[i].Y / scale });
  return clone;
}

// Offset a polygon by `delta` points (positive = expand) using ClipperLib.
// Used to enforce the edge-to-edge gap: parts are expanded by gap/2 and the bin
// inset by gap/2, so two placed outlines end up `gap` apart. The offset polygon
// keeps the SAME coordinate origin as the source, so export placement math is
// unaffected.
function polygonOffset(polygon, delta, config) {
  if (!delta || GeometryUtil.almostEqual(delta, 0)) return polygon.slice();
  const clip = toClipperCoordinates(polygon);
  ClipperLib.JS.ScaleUpPath(clip, config.clipperScale);
  const co = new ClipperLib.ClipperOffset(2, config.curveTolerance * config.clipperScale);
  co.AddPath(clip, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * config.clipperScale);
  if (!out.length) return polygon.slice();
  // Keep the largest resulting ring.
  let biggest = out[0], biggestArea = Math.abs(ClipperLib.Clipper.Area(out[0]));
  for (let i = 1; i < out.length; i++) {
    const a = Math.abs(ClipperLib.Clipper.Area(out[i]));
    if (a > biggestArea) { biggest = out[i]; biggestArea = a; }
  }
  return toNestCoordinates(biggest, config.clipperScale);
}

// Reduce a polygon's vertex count by removing points closer than `tolPt` to
// their neighbours (ClipperLib.CleanPolygon). Fewer vertices => much cheaper
// NFP/Minkowski work. Used only for the throwaway nesting outline, so a little
// looseness is acceptable. Returns the original on any degenerate result.
//
// CleanPolygon can pull vertices INWARD (it cuts corners), which would undersize
// a true-shape outline and let neighbours visually overlap. To guarantee the
// simplified outline always *contains* the original, we grow it back outward by
// the tolerance afterward — simplification may loosen the nest but can never
// make placed parts collide.
function simplifyPolygon(polygon, tolPt, config) {
  if (!tolPt || tolPt <= 0 || polygon.length < 4) return polygon;
  const cp = toClipperCoordinates(polygon);
  ClipperLib.JS.ScaleUpPath(cp, config.clipperScale);
  const cleaned = ClipperLib.Clipper.CleanPolygon(cp, tolPt * config.clipperScale);
  if (!cleaned || cleaned.length < 3) return polygon;
  let simplified = toNestCoordinates(cleaned, config.clipperScale);
  const grown = polygonOffset(simplified, tolPt, config);
  if (grown && grown.length >= 3) simplified = grown;
  return simplified;
}

function minkowskiDifference(A, B, config) {
  const scale = config.clipperScale;
  const Ac = toClipperCoordinates(A);
  ClipperLib.JS.ScaleUpPath(Ac, scale);
  const Bc = toClipperCoordinates(B);
  ClipperLib.JS.ScaleUpPath(Bc, scale);
  for (let i = 0; i < Bc.length; i++) { Bc[i].X *= -1; Bc[i].Y *= -1; }
  const solution = ClipperLib.Clipper.MinkowskiSum(Ac, Bc, true);
  let clipperNfp, largestArea = null;
  for (let i = 0; i < solution.length; i++) {
    const n = toNestCoordinates(solution[i], scale);
    const sarea = GeometryUtil.polygonArea(n);
    if (largestArea === null || largestArea > sarea) { clipperNfp = n; largestArea = sarea; }
  }
  for (let i = 0; i < clipperNfp.length; i++) {
    clipperNfp[i].x += B[0].x;
    clipperNfp[i].y += B[0].y;
  }
  return [clipperNfp];
}

// Compute one NFP (inner or outer) for a pair of polygons.
function computeNfp(pair, config) {
  const searchEdges = config.exploreConcave;
  const useHoles = config.useHoles;
  const A = rotatePolygon(pair.A, pair.key.Arotation);
  const B = rotatePolygon(pair.B, pair.key.Brotation);
  let nfp;

  if (pair.key.inside) {
    if (GeometryUtil.isRectangle(A, 0.001)) {
      nfp = GeometryUtil.noFitPolygonRectangle(A, B);
    } else {
      nfp = GeometryUtil.noFitPolygon(A, B, true, searchEdges);
    }
    if (nfp && nfp.length > 0) {
      for (let i = 0; i < nfp.length; i++) {
        if (GeometryUtil.polygonArea(nfp[i]) > 0) nfp[i].reverse();
      }
    }
  } else {
    if (searchEdges) {
      nfp = GeometryUtil.noFitPolygon(A, B, false, searchEdges);
    } else {
      nfp = minkowskiDifference(A, B, config);
    }
    if (!nfp || nfp.length === 0) return null;
    for (let i = 0; i < nfp.length; i++) {
      if (!searchEdges || i === 0) {
        if (Math.abs(GeometryUtil.polygonArea(nfp[i])) < Math.abs(GeometryUtil.polygonArea(A))) {
          nfp.splice(i, 1);
          return null;
        }
      }
    }
    if (nfp.length === 0) return null;
    for (let i = 0; i < nfp.length; i++) {
      if (GeometryUtil.polygonArea(nfp[i]) > 0) nfp[i].reverse();
      if (i > 0 && GeometryUtil.pointInPolygon(nfp[i][0], nfp[0]) && GeometryUtil.polygonArea(nfp[i]) < 0) {
        nfp[i].reverse();
      }
    }
    if (useHoles && A.children && A.children.length > 0) {
      const Bbounds = GeometryUtil.getPolygonBounds(B);
      for (let i = 0; i < A.children.length; i++) {
        const Abounds = GeometryUtil.getPolygonBounds(A.children[i]);
        if (Abounds.width > Bbounds.width && Abounds.height > Bbounds.height) {
          const cnfp = GeometryUtil.noFitPolygon(A.children[i], B, true, searchEdges);
          if (cnfp && cnfp.length > 0) {
            for (let j = 0; j < cnfp.length; j++) {
              if (GeometryUtil.polygonArea(cnfp[j]) < 0) cnfp[j].reverse();
              nfp.push(cnfp[j]);
            }
          }
        }
      }
    }
  }
  return nfp;
}

// --- placement (ported from SVGnest placementworker.js) ------------------

function placePaths(binPolygon, paths, config, nfpCache, onProgress) {
  if (!binPolygon) return null;
  const rotated = [];
  for (let i = 0; i < paths.length; i++) {
    const r = rotatePolygon(paths[i], paths[i].rotation);
    r.rotation = paths[i].rotation;
    r.source = paths[i].source;
    r.id = paths[i].id;
    rotated.push(r);
  }
  paths = rotated;

  const allplacements = [];
  let fitness = 0;
  const binarea = Math.abs(GeometryUtil.polygonArea(binPolygon));
  let key, nfp, minwidth;

  while (paths.length > 0) {
    const placed = [];
    const placements = [];
    fitness += 1; // each new sheet opened costs 1 (lower is better)
    minwidth = null;

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];

      // NFP cache keys are by SHAPE (source) + rotation, not per-copy id, so
      // identical copies reuse the same NFP. Placement ids below stay per-copy.
      key = JSON.stringify({ A: -1, B: path.source, inside: true, Arotation: 0, Brotation: path.rotation });
      const binNfp = nfpCache[key];
      if (!binNfp || binNfp.length === 0) continue; // unplaceable on an empty sheet

      let error = false;
      for (let j = 0; j < placed.length; j++) {
        key = JSON.stringify({ A: placed[j].source, B: path.source, inside: false, Arotation: placed[j].rotation, Brotation: path.rotation });
        if (!nfpCache[key]) { error = true; break; }
      }
      if (error) continue;

      let position = null;
      if (placed.length === 0) {
        for (let j = 0; j < binNfp.length; j++) {
          for (let k = 0; k < binNfp[j].length; k++) {
            if (position === null || binNfp[j][k].x - path[0].x < position.x) {
              position = {
                x: binNfp[j][k].x - path[0].x,
                y: binNfp[j][k].y - path[0].y,
                id: path.id, rotation: path.rotation,
              };
            }
          }
        }
        placements.push(position);
        placed.push(path);
        if (onProgress) onProgress(allplacements.concat([placements]));
        continue;
      }

      const clipperBinNfp = [];
      for (let j = 0; j < binNfp.length; j++) clipperBinNfp.push(toClipperCoordinates(binNfp[j]));
      ClipperLib.JS.ScaleUpPaths(clipperBinNfp, config.clipperScale);

      let clipper = new ClipperLib.Clipper();
      const combinedNfp = new ClipperLib.Paths();
      for (let j = 0; j < placed.length; j++) {
        key = JSON.stringify({ A: placed[j].source, B: path.source, inside: false, Arotation: placed[j].rotation, Brotation: path.rotation });
        nfp = nfpCache[key];
        if (!nfp) continue;
        for (let k = 0; k < nfp.length; k++) {
          const clone = toClipperCoordinates(nfp[k]);
          for (let m = 0; m < clone.length; m++) {
            clone[m].X += placements[j].x;
            clone[m].Y += placements[j].y;
          }
          ClipperLib.JS.ScaleUpPath(clone, config.clipperScale);
          const cleaned = ClipperLib.Clipper.CleanPolygon(clone, 0.0001 * config.clipperScale);
          const area = Math.abs(ClipperLib.Clipper.Area(cleaned));
          if (cleaned.length > 2 && area > 0.1 * config.clipperScale * config.clipperScale) {
            clipper.AddPath(cleaned, ClipperLib.PolyType.ptSubject, true);
          }
        }
      }
      if (!clipper.Execute(ClipperLib.ClipType.ctUnion, combinedNfp, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) continue;

      let finalNfp = new ClipperLib.Paths();
      clipper = new ClipperLib.Clipper();
      clipper.AddPaths(combinedNfp, ClipperLib.PolyType.ptClip, true);
      clipper.AddPaths(clipperBinNfp, ClipperLib.PolyType.ptSubject, true);
      if (!clipper.Execute(ClipperLib.ClipType.ctDifference, finalNfp, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) continue;

      finalNfp = ClipperLib.Clipper.CleanPolygons(finalNfp, 0.0001 * config.clipperScale);
      for (let j = 0; j < finalNfp.length; j++) {
        const area = Math.abs(ClipperLib.Clipper.Area(finalNfp[j]));
        if (finalNfp[j].length < 3 || area < 0.1 * config.clipperScale * config.clipperScale) {
          finalNfp.splice(j, 1); j--;
        }
      }
      if (!finalNfp || finalNfp.length === 0) continue;

      const f = [];
      for (let j = 0; j < finalNfp.length; j++) f.push(toNestCoordinates(finalNfp[j], config.clipperScale));
      finalNfp = f;

      // Choose the placement with the smallest weighted bounding box (gravity
      // toward the left edge), matching SVGnest's heuristic.
      //
      // The already-placed parts' extent is constant while we evaluate this one
      // candidate, so accumulate its bounds ONCE here instead of rebuilding the
      // full point list for every candidate NFP vertex (SVGnest's hot-loop
      // waste — this is O(placedPoints) once, not per vertex).
      let pminx = Infinity, pminy = Infinity, pmaxx = -Infinity, pmaxy = -Infinity;
      for (let m = 0; m < placed.length; m++) {
        for (let nn = 0; nn < placed[m].length; nn++) {
          const px = placed[m][nn].x + placements[m].x;
          const py = placed[m][nn].y + placements[m].y;
          if (px < pminx) pminx = px;
          if (px > pmaxx) pmaxx = px;
          if (py < pminy) pminy = py;
          if (py > pmaxy) pmaxy = py;
        }
      }

      let minarea = null, minx = null;
      for (let j = 0; j < finalNfp.length; j++) {
        const nf = finalNfp[j];
        if (Math.abs(GeometryUtil.polygonArea(nf)) < 2) continue;
        for (let k = 0; k < nf.length; k++) {
          const shiftvector = {
            x: nf[k].x - path[0].x, y: nf[k].y - path[0].y,
            id: path.id, rotation: path.rotation,
          };
          // Extend the constant placed-parts bounds by this candidate's points.
          let minX = pminx, minY = pminy, maxX = pmaxx, maxY = pmaxy;
          for (let m = 0; m < path.length; m++) {
            const x = path[m].x + shiftvector.x, y = path[m].y + shiftvector.y;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          const width = maxX - minX, height = maxY - minY;
          const area = width * 2 + height;
          if (minarea === null || area < minarea ||
              (GeometryUtil.almostEqual(minarea, area) && (minx === null || shiftvector.x < minx))) {
            minarea = area;
            minwidth = width;
            position = shiftvector;
            minx = shiftvector.x;
          }
        }
      }
      if (position) {
        placed.push(path);
        placements.push(position);
        if (onProgress) onProgress(allplacements.concat([placements]));
      }
    }

    if (minwidth) fitness += minwidth / binarea;

    for (let i = 0; i < placed.length; i++) {
      const index = paths.indexOf(placed[i]);
      if (index >= 0) paths.splice(index, 1);
    }

    if (placements && placements.length > 0) allplacements.push(placements);
    else break; // could not place anything more — avoid infinite loop
  }

  fitness += 2 * paths.length; // penalty for parts that could not be placed
  return { placements: allplacements, fitness, unplaced: paths.length, area: binarea };
}

// --- genetic algorithm (ported from SVGnest) -----------------------------

function GeneticAlgorithm(adam, bin, config) {
  this.config = config;
  this.binBounds = GeometryUtil.getPolygonBounds(bin);
  const angles = [];
  for (let i = 0; i < adam.length; i++) angles.push(this.randomAngle(adam[i]));
  this.population = [{ placement: adam, rotation: angles }];
  while (this.population.length < config.populationSize) {
    this.population.push(this.mutate(this.population[0]));
  }
}
GeneticAlgorithm.prototype.randomAngle = function (part) {
  const angleList = [];
  for (let i = 0; i < Math.max(this.config.rotations, 1); i++) {
    angleList.push(i * (360 / this.config.rotations));
  }
  for (let i = angleList.length - 1; i > 0; i--) {
    const j = Math.floor(_rand() * (i + 1));
    const t = angleList[i]; angleList[i] = angleList[j]; angleList[j] = t;
  }
  for (let i = 0; i < angleList.length; i++) {
    const rp = GeometryUtil.rotatePolygon(part, angleList[i]);
    if (rp.width < this.binBounds.width && rp.height < this.binBounds.height) return angleList[i];
  }
  return 0;
};
GeneticAlgorithm.prototype.mutate = function (individual) {
  const clone = { placement: individual.placement.slice(0), rotation: individual.rotation.slice(0) };
  for (let i = 0; i < clone.placement.length; i++) {
    if (_rand() < 0.01 * this.config.mutationRate) {
      const j = i + 1;
      if (j < clone.placement.length) {
        const t = clone.placement[i]; clone.placement[i] = clone.placement[j]; clone.placement[j] = t;
      }
    }
    if (_rand() < 0.01 * this.config.mutationRate) {
      clone.rotation[i] = this.randomAngle(clone.placement[i]);
    }
  }
  return clone;
};
GeneticAlgorithm.prototype.mate = function (male, female) {
  const cutpoint = Math.round(Math.min(Math.max(_rand(), 0.1), 0.9) * (male.placement.length - 1));
  const gene1 = male.placement.slice(0, cutpoint);
  const rot1 = male.rotation.slice(0, cutpoint);
  const gene2 = female.placement.slice(0, cutpoint);
  const rot2 = female.rotation.slice(0, cutpoint);
  const contains = (gene, id) => gene.some((g) => g.id === id);
  for (let i = 0; i < female.placement.length; i++) {
    if (!contains(gene1, female.placement[i].id)) { gene1.push(female.placement[i]); rot1.push(female.rotation[i]); }
  }
  for (let i = 0; i < male.placement.length; i++) {
    if (!contains(gene2, male.placement[i].id)) { gene2.push(male.placement[i]); rot2.push(male.rotation[i]); }
  }
  return [{ placement: gene1, rotation: rot1 }, { placement: gene2, rotation: rot2 }];
};
GeneticAlgorithm.prototype.generation = function () {
  this.population.sort((a, b) => a.fitness - b.fitness);
  const newpop = [this.population[0]]; // elitism
  while (newpop.length < this.population.length) {
    const male = this.randomWeightedIndividual();
    const female = this.randomWeightedIndividual(male);
    const children = this.mate(male, female);
    newpop.push(this.mutate(children[0]));
    if (newpop.length < this.population.length) newpop.push(this.mutate(children[1]));
  }
  this.population = newpop;
};
GeneticAlgorithm.prototype.randomWeightedIndividual = function (exclude) {
  const pop = this.population.slice(0);
  if (exclude && pop.indexOf(exclude) >= 0) pop.splice(pop.indexOf(exclude), 1);
  const rand = _rand();
  let lower = 0;
  const weight = 1 / pop.length;
  let upper = weight;
  for (let i = 0; i < pop.length; i++) {
    if (rand > lower && rand < upper) return pop[i];
    lower = upper;
    upper += 2 * weight * ((pop.length - i) / pop.length);
  }
  return pop[0];
};

// --- worker driver --------------------------------------------------------
//
// A run is a SINGLE deterministic nesting pass (no continuous genetic loop):
// build the area-sorted greedy ordering, compute its NFPs, place once, post the
// result, and finish. Events are streamed to the main thread as `log` messages,
// and each successful placement is streamed as a partial `placement` for a live
// preview.
//
// To make that one pass fast, the O(n²) no-fit-polygon precompute (the heavy,
// embarrassingly-parallel part) is fanned out to nested instances of THIS SAME
// script running in "helper" role; the coordinator assembles the results and
// runs the inherently-serial placement itself. Nested workers aren't supported
// everywhere, so spawning is guarded and degrades to a single-core inline build.

// Parallelism gate. NFP cost scales with the PRODUCT of the two outlines'
// vertex counts (Minkowski/NFP work is ~O(|A|·|B|)), so the expensive case is a
// *few vector-heavy shapes*, not many simple ones. After shape de-dup the raw
// job count is tiny, so gating on job count kept us single-core forever; gate on
// estimated total vertex work instead. Below this, worker startup + data
// transfer outweighs the compute, so we stay single-core regardless of setting.
const PARALLEL_MIN_COST = 200000;

let running = false;
let tree = null, binPolygon = null, config = null;
let sourcePoly = null;      // Map<sourceId, representativePolygon> for NFP compute
let coreCount = 1;          // total cores this run may use (coordinator + helpers)
let activeHelpers = [];     // live nested helper workers (for teardown)

// Post a structured log line to the main thread.
// level: 'info' | 'success' | 'warn' | 'error'
function log(level, message) {
  self.postMessage({ type: 'log', level, message });
}

// Merge caller config over engine defaults (shared by coordinator + helpers).
function withDefaults(c) {
  return Object.assign({
    clipperScale: 10000000,
    curveTolerance: 0.3,
    spacing: 0,
    rotations: 4,
    populationSize: 10,
    mutationRate: 10,
    useHoles: false,
    exploreConcave: false,
  }, c || {});
}

// Turn a raw source outline into its prepared nesting polygon: optional vertex
// simplification, then the gap expansion, then CCW winding (as SVGnest expects).
function prepareSourceOutline(rawPoly) {
  let poly = rawPoly;
  if (config.simplifyTol > 0) poly = simplifyPolygon(poly, config.simplifyTol, config);
  if (config.spacing > 0) {
    const off = polygonOffset(poly, 0.5 * config.spacing, config);
    if (off && off.length >= 3) poly = off;
  }
  if (GeometryUtil.polygonArea(poly) > 0) poly = poly.slice().reverse();
  return poly;
}

function prepare(msg) {
  config = withDefaults(msg.config);

  _rand = (msg.seed != null) ? makeRng(msg.seed) : Math.random;

  // Rebuild polygon arrays + their expando tags (structured-clone postMessage
  // drops non-index properties, so the main thread sends plain objects).
  binPolygon = msg.bin.points.map((p) => ({ x: p.x, y: p.y }));
  binPolygon.width = msg.bin.width;
  binPolygon.height = msg.bin.height;

  // Prepare each distinct source outline ONCE (simplify + gap offset are the
  // expensive steps), then hand every copy a thin array that shares the prepared
  // point data but carries its own id/source/rotation tags.
  const prepBySource = new Map();
  tree = msg.tree.map((item) => {
    let base = prepBySource.get(item.source);
    if (!base) {
      const raw = item.points.map((p) => ({ x: p.x, y: p.y }));
      base = prepareSourceOutline(raw);
      prepBySource.set(item.source, base);
    }
    const poly = base.slice();        // distinct array, shared (read-only) points
    poly.id = item.id;
    poly.source = item.source;
    return poly;
  });

  // Inset the bin by gap/2 so two placed outlines end up `spacing` apart.
  if (config.spacing > 0) {
    const insetBin = polygonOffset(binPolygon, -0.5 * config.spacing, config);
    if (insetBin && insetBin.length >= 3) binPolygon = insetBin;
  }
  binPolygon.id = -1;

  // Consistent winding (CW bin), and recompute bounds for the rectangle fast path.
  if (GeometryUtil.polygonArea(binPolygon) > 0) binPolygon.reverse();
  const bb = GeometryUtil.getPolygonBounds(binPolygon);
  binPolygon.width = bb.width;
  binPolygon.height = bb.height;

  // One representative polygon per source, for shape-keyed NFP computation.
  sourcePoly = new Map();
  for (const poly of tree) if (!sourcePoly.has(poly.source)) sourcePoly.set(poly.source, poly);
}

// Post a (partial or final) placement set with its utilization stats.
// placements: [[{id,x,y,rotation}...], ...] per sheet.
function postPlacement(placements, final) {
  let placedArea = 0;
  const sheets = placements.length;
  let numPlaced = 0;
  const treeAreas = tree.map((t) => Math.abs(GeometryUtil.polygonArea(t)));
  for (let i = 0; i < placements.length; i++) {
    for (let j = 0; j < placements[i].length; j++) {
      placedArea += treeAreas[placements[i][j].id];
      numPlaced++;
    }
  }
  const totalArea = Math.abs(GeometryUtil.polygonArea(binPolygon)) * Math.max(1, sheets);

  self.postMessage({
    type: 'placement',
    placements,
    utilization: totalArea > 0 ? placedArea / totalArea : 0,
    sheets,
    placed: numPlaced,
    total: tree.length,
    unplaced: tree.length - numPlaced,
    final: !!final,
  });
}

function warnUnfit() {
  log('warn', 'A part will not fit the usable sheet area at its chosen rotation.');
}

// The NFP key string MUST match the one placePaths looks up (same property
// order): { A, B, inside, Arotation, Brotation }.
function nfpKey(job) { return JSON.stringify(job); }

// Every DISTINCT NFP needed to place `placelist`, as shape(source)+rotation
// descriptors. Because copies of a part share a shape, the job set is the cross
// product of the distinct (source, rotation) combos present — not O(copies²).
function buildNfpJobs(placelist) {
  const combos = new Map(); // `${source}|${rot}` -> { source, rot }
  for (const p of placelist) {
    const k = p.source + '|' + p.rotation;
    if (!combos.has(k)) combos.set(k, { source: p.source, rot: p.rotation });
  }
  const list = [...combos.values()];

  const jobs = [];
  const seen = new Set();
  const add = (job) => { const ks = nfpKey(job); if (!seen.has(ks)) { seen.add(ks); jobs.push(job); } };
  for (const b of list) {
    add({ A: -1, B: b.source, inside: true, Arotation: 0, Brotation: b.rot });
    for (const a of list) {
      add({ A: a.source, B: b.source, inside: false, Arotation: a.rot, Brotation: b.rot });
    }
  }
  return jobs;
}

// Estimated cost of the whole job list, used to decide whether to fan out.
// Each NFP is ~O(|A|·|B|) in the two outlines' vertex counts, so a handful of
// dense vector shapes can dwarf dozens of rectangles. Summing the per-job
// vertex products gives a gate that tracks real work, not de-duped job count.
function estimateNfpCost(jobs) {
  let cost = 0;
  for (const job of jobs) {
    const A = job.A === -1 ? binPolygon : sourcePoly.get(job.A);
    const B = sourcePoly.get(job.B);
    cost += (A ? A.length : 0) * (B ? B.length : 0);
  }
  return cost;
}

// Compute one NFP job. A/B are source ids (or -1 for the bin) resolved via the
// per-source representative polygon.
function computeJob(job) {
  const A = job.A === -1 ? binPolygon : sourcePoly.get(job.A);
  const B = sourcePoly.get(job.B);
  return computeNfp({ A, B, key: job }, config);
}

// Build the full NFP cache for `jobs`, optionally fanning out to `helperCount`
// nested helper workers. Calls onComplete(cache) when every job is computed.
function buildNfpCache(jobs, helperCount, onComplete) {
  const cache = {};
  const computeInto = (job) => {
    const nfp = computeJob(job);
    cache[nfpKey(job)] = nfp;
    if (job.inside && (!nfp || nfp.length === 0)) warnUnfit();
  };

  // Single-core inline path.
  if (helperCount <= 0) {
    for (let k = 0; k < jobs.length; k++) {
      if (!running) return;
      computeInto(jobs[k]);
    }
    onComplete(cache);
    return;
  }

  // Parallel path: spawn helpers (guarded — nested workers may be unsupported).
  let helpers = [];
  try {
    for (let h = 0; h < helperCount; h++) helpers.push(new Worker(self.location.href));
  } catch (err) {
    for (const w of helpers) { try { w.terminate(); } catch (_) {} }
    log('warn', 'Parallel cores unavailable here; computing on a single core.');
    buildNfpCache(jobs, 0, onComplete);
    return;
  }
  activeHelpers = helpers;

  // Round-robin jobs into lanes; lane 0 is the coordinator, 1..n the helpers.
  const lanes = helperCount + 1;
  const bucket = Array.from({ length: lanes }, () => []);
  for (let k = 0; k < jobs.length; k++) bucket[k % lanes].push(jobs[k]);

  // Helpers only need the distinct prepared source shapes + the bin, not every copy.
  const serialSources = [];
  sourcePoly.forEach((poly, source) => serialSources.push({ source, points: poly.map((p) => ({ x: p.x, y: p.y })) }));
  const serialBin = { points: binPolygon.map((p) => ({ x: p.x, y: p.y })), width: binPolygon.width, height: binPolygon.height };

  let pending = helpers.length;
  const finish = () => {
    if (pending !== 0 || !running) return;
    for (const w of helpers) { try { w.terminate(); } catch (_) {} }
    activeHelpers = [];
    onComplete(cache);
  };

  helpers.forEach((w, idx) => {
    const lane = bucket[idx + 1];
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'nfpResults') return;
      for (let r = 0; r < m.results.length; r++) {
        cache[m.results[r].key] = m.results[r].nfp;
        if (m.results[r].unfit) warnUnfit();
      }
      pending--; finish();
    };
    w.onerror = () => {
      // Helper crashed — fold its lane back into the coordinator so the run
      // still completes correctly, just slower.
      try { w.terminate(); } catch (_) {}
      for (let k = 0; k < lane.length; k++) computeInto(lane[k]);
      pending--; finish();
    };
    w.postMessage({ cmd: 'helperInit', sources: serialSources, bin: serialBin, config });
    w.postMessage({ cmd: 'helperNfp', jobs: lane });
  });

  // Coordinator computes lane 0 while the helpers run on their own threads.
  // (Helper result messages queue until this synchronous loop yields.)
  const myLane = bucket[0];
  for (let k = 0; k < myLane.length; k++) {
    if (!running) { for (const w of helpers) { try { w.terminate(); } catch (_) {} } return; }
    computeInto(myLane[k]);
  }
  finish();
}

// Run a single nesting pass: greedy area-sorted ordering, one placement.
function runOnce() {
  if (!running) return;
  const n = tree.length;
  log('info', `Starting nest — ${n} part${n === 1 ? '' : 's'}, up to ${Math.max(1, config.rotations)} rotation${config.rotations === 1 ? '' : 's'}.`);

  // Largest-area-first ordering, with a seeded valid initial rotation per part.
  const adam = tree.slice(0);
  adam.sort((a, b) => Math.abs(GeometryUtil.polygonArea(b)) - Math.abs(GeometryUtil.polygonArea(a)));
  const ga = new GeneticAlgorithm(adam, binPolygon, config);
  const individual = ga.population[0];
  const placelist = individual.placement;
  const rotations = individual.rotation;
  for (let i = 0; i < placelist.length; i++) placelist[i].rotation = rotations[i];

  const jobs = buildNfpJobs(placelist);
  const helperCount = (coreCount > 1 && jobs.length > 1 && estimateNfpCost(jobs) >= PARALLEL_MIN_COST)
    ? Math.min(coreCount - 1, jobs.length - 1) : 0;
  log('info', `Computing ${jobs.length} shape interaction${jobs.length === 1 ? '' : 's'} for ${n} part${n === 1 ? '' : 's'}` +
    (helperCount > 0 ? ` across ${helperCount + 1} cores…` : ' on 1 core…'));

  buildNfpCache(jobs, helperCount, (nfpCache) => {
    if (!running) return;
    placeAndFinish(placelist, nfpCache, n);
  });
}

// Placement (serial) + result/done reporting.
function placeAndFinish(placelist, nfpCache, n) {
  log('info', 'Placing parts…');
  let result;
  try {
    result = placePaths(binPolygon, placelist.slice(0), config, nfpCache, (snapshot) => {
      if (running) postPlacement(snapshot, false);
    });
  } catch (err) {
    log('error', `Placement failed: ${err && err.message ? err.message : err}`);
    running = false;
    self.postMessage({ type: 'done', placed: 0, unplaced: n });
    return;
  }

  if (result && result.placements.length > 0) {
    postPlacement(result.placements, true);
    const placed = n - result.unplaced;
    const sheets = result.placements.length;
    log('success', `Done — placed ${placed} of ${n} part${n === 1 ? '' : 's'} on ${sheets} sheet${sheets === 1 ? '' : 's'}.`);
    if (result.unplaced > 0) {
      log('warn', `${result.unplaced} part${result.unplaced === 1 ? '' : 's'} could not be placed on this sheet size.`);
    }
    self.postMessage({ type: 'done', placed, unplaced: result.unplaced });
  } else {
    log('error', 'No parts could be placed — check that parts fit within the sheet margins.');
    self.postMessage({ type: 'done', placed: 0, unplaced: n });
  }
  running = false;
}

// Helper role: rebuild the already-prepared source shapes + bin (no re-offset /
// re-winding — the coordinator did that) so this instance can answer NFP jobs.
function initHelper(msg) {
  config = withDefaults(msg.config);
  binPolygon = msg.bin.points.map((p) => ({ x: p.x, y: p.y }));
  binPolygon.width = msg.bin.width;
  binPolygon.height = msg.bin.height;
  binPolygon.id = -1;
  sourcePoly = new Map();
  for (const s of msg.sources) {
    const poly = s.points.map((p) => ({ x: p.x, y: p.y }));
    poly.source = s.source;
    sourcePoly.set(s.source, poly);
  }
}

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.cmd === 'start') {
    coreCount = Math.max(1, msg.cores | 0) || 1;
    log('info', 'Preparing geometry…');
    prepare(msg);
    running = true;
    setTimeout(runOnce, 0);
  } else if (msg.cmd === 'helperInit') {
    initHelper(msg);
  } else if (msg.cmd === 'helperNfp') {
    const results = [];
    for (let k = 0; k < msg.jobs.length; k++) {
      const job = msg.jobs[k];
      const A = job.A === -1 ? binPolygon : sourcePoly.get(job.A);
      const B = sourcePoly.get(job.B);
      const nfp = computeNfp({ A, B, key: job }, config);
      const out = { key: nfpKey(job), nfp };
      if (job.inside && (!nfp || nfp.length === 0)) out.unfit = true;
      results.push(out);
    }
    self.postMessage({ type: 'nfpResults', results });
  } else if (msg.cmd === 'stop') {
    running = false;
    for (const w of activeHelpers) { try { w.terminate(); } catch (_) {} }
    activeHelpers = [];
  }
};
