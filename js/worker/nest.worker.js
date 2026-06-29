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

function minkowskiDifference(A, B) {
  const Ac = toClipperCoordinates(A);
  ClipperLib.JS.ScaleUpPath(Ac, 10000000);
  const Bc = toClipperCoordinates(B);
  ClipperLib.JS.ScaleUpPath(Bc, 10000000);
  for (let i = 0; i < Bc.length; i++) { Bc[i].X *= -1; Bc[i].Y *= -1; }
  const solution = ClipperLib.Clipper.MinkowskiSum(Ac, Bc, true);
  let clipperNfp, largestArea = null;
  for (let i = 0; i < solution.length; i++) {
    const n = toNestCoordinates(solution[i], 10000000);
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
      nfp = minkowskiDifference(A, B);
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

function placePaths(binPolygon, paths, config, nfpCache) {
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

      key = JSON.stringify({ A: -1, B: path.id, inside: true, Arotation: 0, Brotation: path.rotation });
      const binNfp = nfpCache[key];
      if (!binNfp || binNfp.length === 0) continue; // unplaceable on an empty sheet

      let error = false;
      for (let j = 0; j < placed.length; j++) {
        key = JSON.stringify({ A: placed[j].id, B: path.id, inside: false, Arotation: placed[j].rotation, Brotation: path.rotation });
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
        continue;
      }

      const clipperBinNfp = [];
      for (let j = 0; j < binNfp.length; j++) clipperBinNfp.push(toClipperCoordinates(binNfp[j]));
      ClipperLib.JS.ScaleUpPaths(clipperBinNfp, config.clipperScale);

      let clipper = new ClipperLib.Clipper();
      const combinedNfp = new ClipperLib.Paths();
      for (let j = 0; j < placed.length; j++) {
        key = JSON.stringify({ A: placed[j].id, B: path.id, inside: false, Arotation: placed[j].rotation, Brotation: path.rotation });
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
      let minarea = null, minx = null;
      for (let j = 0; j < finalNfp.length; j++) {
        const nf = finalNfp[j];
        if (Math.abs(GeometryUtil.polygonArea(nf)) < 2) continue;
        for (let k = 0; k < nf.length; k++) {
          const allpoints = [];
          for (let m = 0; m < placed.length; m++) {
            for (let n = 0; n < placed[m].length; n++) {
              allpoints.push({ x: placed[m][n].x + placements[m].x, y: placed[m][n].y + placements[m].y });
            }
          }
          const shiftvector = {
            x: nf[k].x - path[0].x, y: nf[k].y - path[0].y,
            id: path.id, rotation: path.rotation,
          };
          for (let m = 0; m < path.length; m++) {
            allpoints.push({ x: path[m].x + shiftvector.x, y: path[m].y + shiftvector.y });
          }
          const rectbounds = GeometryUtil.getPolygonBounds(allpoints);
          const area = rectbounds.width * 2 + rectbounds.height;
          if (minarea === null || area < minarea ||
              (GeometryUtil.almostEqual(minarea, area) && (minx === null || shiftvector.x < minx))) {
            minarea = area;
            minwidth = rectbounds.width;
            position = shiftvector;
            minx = shiftvector.x;
          }
        }
      }
      if (position) { placed.push(path); placements.push(position); }
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

let running = false;
let tree = null, binPolygon = null, config = null;
let GA = null, best = null, generations = 0;

function prepare(msg) {
  config = Object.assign({
    clipperScale: 10000000,
    curveTolerance: 0.3,
    spacing: 0,
    rotations: 4,
    populationSize: 10,
    mutationRate: 10,
    useHoles: false,
    exploreConcave: false,
  }, msg.config || {});

  _rand = (msg.seed != null) ? makeRng(msg.seed) : Math.random;

  // Rebuild polygon arrays + their expando tags (structured-clone postMessage
  // drops non-index properties, so the main thread sends plain objects).
  binPolygon = msg.bin.points.map((p) => ({ x: p.x, y: p.y }));
  binPolygon.width = msg.bin.width;
  binPolygon.height = msg.bin.height;

  tree = msg.tree.map((item) => {
    const poly = item.points.map((p) => ({ x: p.x, y: p.y }));
    poly.id = item.id;
    poly.source = item.source;
    return poly;
  });

  // Enforce the gap: expand each part by spacing/2 and inset the bin by
  // spacing/2 so two placed outlines end up `spacing` apart.
  if (config.spacing > 0) {
    for (let i = 0; i < tree.length; i++) {
      const src = tree[i];
      const off = polygonOffset(src, 0.5 * config.spacing, config);
      off.id = src.id; off.source = src.source;
      tree[i] = off;
    }
    const insetBin = polygonOffset(binPolygon, -0.5 * config.spacing, config);
    if (insetBin && insetBin.length >= 3) binPolygon = insetBin;
  }
  binPolygon.id = -1;

  // Ensure consistent winding directions (CCW parts, CW bin), as SVGnest expects.
  if (GeometryUtil.polygonArea(binPolygon) > 0) binPolygon.reverse();
  for (let i = 0; i < tree.length; i++) {
    if (GeometryUtil.polygonArea(tree[i]) > 0) tree[i].reverse();
  }
  // Recompute bin bounds used by the bin's inner-NFP rectangle fast path.
  const bb = GeometryUtil.getPolygonBounds(binPolygon);
  binPolygon.width = bb.width;
  binPolygon.height = bb.height;

  GA = null; best = null; generations = 0;
}

// Run one optimizer step: evaluate one individual, update best, post result.
function step() {
  if (!running) return;

  if (GA === null) {
    const adam = tree.slice(0);
    adam.sort((a, b) => Math.abs(GeometryUtil.polygonArea(b)) - Math.abs(GeometryUtil.polygonArea(a)));
    GA = new GeneticAlgorithm(adam, binPolygon, config);
  }

  let individual = null;
  for (let i = 0; i < GA.population.length; i++) {
    if (!GA.population[i].fitness) { individual = GA.population[i]; break; }
  }
  if (individual === null) {
    GA.generation();
    generations++;
    individual = GA.population[1];
  }

  const placelist = individual.placement;
  const rotations = individual.rotation;
  for (let i = 0; i < placelist.length; i++) placelist[i].rotation = rotations[i];

  // Build the NFP cache needed for this individual.
  const nfpCache = {};
  for (let i = 0; i < placelist.length; i++) {
    const part = placelist[i];
    let key = { A: -1, B: part.id, inside: true, Arotation: 0, Brotation: rotations[i] };
    nfpCache[JSON.stringify(key)] = computeNfp({ A: binPolygon, B: part, key }, config);
    for (let j = 0; j < i; j++) {
      const placed = placelist[j];
      key = { A: placed.id, B: part.id, inside: false, Arotation: rotations[j], Brotation: rotations[i] };
      nfpCache[JSON.stringify(key)] = computeNfp({ A: placed, B: part, key }, config);
    }
  }

  const result = placePaths(binPolygon, placelist.slice(0), config, nfpCache);
  if (result && result.placements.length > 0) {
    individual.fitness = result.fitness;

    if (!best || result.fitness < best.fitness) {
      best = result;
      postBest();
    }
  } else {
    individual.fitness = 1e9; // mark evaluated so the GA can move on
  }

  if (running) setTimeout(step, 0);
}

function postBest() {
  // Utilization = placed part area / (bin area × sheets used).
  let placedArea = 0;
  const sheets = best.placements.length;
  let numPlaced = 0;
  const treeAreas = tree.map((t) => Math.abs(GeometryUtil.polygonArea(t)));
  for (let i = 0; i < best.placements.length; i++) {
    for (let j = 0; j < best.placements[i].length; j++) {
      placedArea += treeAreas[best.placements[i][j].id];
      numPlaced++;
    }
  }
  const totalArea = Math.abs(GeometryUtil.polygonArea(binPolygon)) * Math.max(1, sheets);

  self.postMessage({
    type: 'placement',
    placements: best.placements, // [[{id,x,y,rotation}...], ...] per sheet
    utilization: totalArea > 0 ? placedArea / totalArea : 0,
    sheets,
    placed: numPlaced,
    total: tree.length,
    unplaced: best.unplaced,
    fitness: best.fitness,
    generations,
  });
}

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.cmd === 'start') {
    prepare(msg);
    running = true;
    setTimeout(step, 0);
  } else if (msg.cmd === 'stop') {
    running = false;
  }
};
