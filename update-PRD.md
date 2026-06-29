# EasyNest — Session Update / Handoff

Supplements `PRD.md`. Captures changes + clarifications from the nesting-engine
work session so it can be resumed cleanly. **Nothing here has been formally
tested** — changes were made and reasoned through; verification (running the app,
syntax check) was NOT completed. Hard-reload the browser when testing (workers
and modules cache aggressively).

---

## What changed this session

### 1. Event / error log panel
- Toggle button (`▤ Log`) next to the status pill in the top bar; panel hidden
  by default; Clear + Close controls.
- Unread badge counts events while closed; turns red (`.alert`) if any unread
  event is a warning/error; clears when the panel is opened.
- Log is cleared on each **Start Nest**.
- Worker streams `{type:'log', level, message}` (`level` = info|success|warn|error)
  → `NestRunner.onLog` → `Engine.onLog` → `main.js addLog()`.

### 2. Single nesting pass (was: continuous genetic loop)
- The worker now runs **one deterministic pass** and stops, instead of looping
  the GA forever until "Stop".
- Pass = largest-area-first ordering + a seeded valid initial rotation per part
  (still uses `GeneticAlgorithm` only to produce `population[0]`), compute its
  NFPs, place once, report, done.
- New status **`done`** ("Done" green pill); layout persists until parts/settings
  change. Stop button still works.

### 3. Live preview
- `placePaths` takes an `onProgress` callback and emits a partial placement after
  **every** successful part placement → preview canvas fills in part-by-part.

### 4. Multi-core = parallelize the single pass (NOT best-of-N)
- **Decision:** user wants ONE pass, as fast as possible. So extra cores
  accelerate the *one* pass by parallelizing the O(n²) **NFP precompute** (the
  heavy, embarrassingly-parallel part). Placement stays serial (Amdahl-bounded).
- Architecture: the nest worker is **role-aware**. The coordinator (spawned by
  `NestRunner`) prepares geometry, decides ordering+rotations, builds the NFP job
  list, and spawns up to `cores-1` **nested helper workers** (same script,
  `new Worker(self.location.href)`), round-robins jobs across coordinator+helpers,
  assembles the cache, then runs placement itself.
  - Helper protocol: `helperInit {sources, bin, config}` → `helperNfp {jobs}` →
    `{type:'nfpResults', results:[{key, nfp, unfit?}]}`.
  - Nested workers may be unsupported (older Safari): spawning is wrapped in
    try/catch and **degrades gracefully to single-core inline** (also on helper
    `onerror`, that helper's lane is recomputed inline).
- **`cores` setting**: `'auto'` (= `navigator.hardwareConcurrency`) or an integer,
  clamped to detected cores. UI: "CPU cores" select, "Auto (N)" + 1..N.
  `Engine.detectCores()` / `Engine.resolveCores()`.

### 5. NFP de-duplication by shape (`source` + rotation)
- NFP cache + job list are keyed by `(source, rotation)` instead of per-copy id.
  Identical copies share one NFP. Work drops from **O(totalCopies²)** to
  **O(distinctShapes² × rotations²)**.
- `placePaths` lookups use `path.source` / `placed.source`; placement OUTPUT ids
  stay per-copy (`path.id`) so results still map back to the right parts.
- `sourcePoly: Map<source, representativePolygon>` resolves shapes for NFP compute
  in both coordinator and helpers.

### 6. Startup-delay fixes
- Immediate `Preparing geometry…` log emitted **before** `prepare()` runs.
- Gap-offset (ClipperOffset) is now computed **once per distinct source** and
  shared to all copies (was once per copy → could be a silent minute+).

### 7. Nesting-detail control (speed vs tightness)
- New "Nesting detail" select: **Fast / Balanced / Tight** → `settings.detail` →
  `detailToTolerance()` (points): fast 2.0, balanced 0.75, tight 0.
- Worker simplifies each source outline once (`ClipperLib.CleanPolygon`) before
  NFP. Affects only the throwaway nesting outline — **export fidelity untouched**.
- **Default = Balanced** (a deliberate change from old always-tight behavior).

---

## Settings added (persisted in localStorage `easynest.settings.v1`)
- `cores`: `'auto'` | positive int. Default `'auto'`.
- `detail`: `'tight' | 'balanced' | 'fast'`. Default `'balanced'`.

---

## Files touched
- `js/worker/nest.worker.js` — **major**: single-pass driver, log/done/progress
  messages, parallel-NFP coordinator+helper roles, per-source prepare/dedup,
  shape-keyed NFP, simplify.
- `js/core/nest.js` — `NestRunner` forwards log/done, `cores` in start payload,
  `detailToTolerance()`, config `simplifyTol`.
- `js/core/engine.js` — `onLog` hook, `done` status, `detectCores`/`resolveCores`.
- `js/core/storage.js` — `cores` + `detail` defaults & persistence.
- `index.html` — log panel + toggle, cores select, detail select.
- `css/styles.css` — log toggle/panel/badge styles, `.pill.done`.
- `js/main.js` — log panel logic, cores/detail populate+sync+wire, `done` label.

---

## Known issues / open decisions (next session)

1. **Core gate too aggressive — log "always 1 core".**
   Parallel helpers only spawn when NFP job count ≥ `PARALLEL_MIN_JOBS` (48). But
   the de-dup shrank job counts, so typical jobs (a handful of shapes) never clear
   it → effectively always single-core. The gate should weigh **per-NFP cost
   (vertex count / vector complexity)**, not raw job count — the slow case is a
   *few complex* vector shapes. **TODO:** rework the gate (vertex-weighted, or just
   much lower) so vector-heavy jobs actually fan out.

2. **NFP count log is confusing.**
   "Computing 12 no-fit polygons" with 5 parts = `shapes + shapes²` (each shape vs
   bin + every ordered shape pair). 12 ⇒ 3 distinct shapes (3 + 9). It's correct
   but reads like a bug. **TODO:** relabel, e.g. "Computing 12 shape interactions
   for 5 parts…".

3. **Vector overlap — BRACKETED (likely not a code bug).**
   User concluded the overlap on their test was a **test-file artifact**: the
   cutline in the test PDF extended past the artboard, so the trace came from the
   image inside the cutline shape; with that understood, the gap looked roughly
   correct. Gap math (expand part by gap/2, inset bin by gap/2) is structurally
   sound and unchanged. Revisit only if it reproduces on a clean file.
   - Related open call: **default detail = Balanced** simplifies outlines slightly
     *inward*, which can undersize true-shape vector outlines. Consider flipping
     default to **Tight**, and/or making simplification expand outward so it can
     never undersize.
   - Note: preview paints each part's **rectangular thumbnail** (bounding box), so
     true-shape nests show overlapping rectangles even when outlines are gap-apart
     — cosmetic, not a real collision. The thin outline stroke is the real bound.

---

## Verification status
- Not run. No automated tests in repo (static, no-build app). Manual testing by
  user in-browser. Recommend: confirm (a) `Preparing…` log appears instantly,
  (b) a high-quantity job nests fast (dedup), (c) cores >1 actually fans out once
  the gate is reworked.
