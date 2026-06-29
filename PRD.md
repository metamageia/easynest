# EasyNest — PRD

> A browser-only, no-backend true-shape nesting tool for prepress, hosted as a static GitHub Page. Forked from SVGnest's pure-JavaScript core. Its reason to exist: nest PDFs/SVGs/PNGs/JPGs onto press sheets while preserving **exact vector geometry and exact spot/separation color names** in the exported PDF.

## Glossary

- **Part** — one nestable object. One PDF page = one part; each PNG/JPG/SVG = one part. A multi-page PDF auto-expands to one part per page.
- **Artwork payload** — the original, untouched source content of a part (PDF page, SVG, or raster), preserved through the whole pipeline and re-emitted on export.
- **Nesting outline** — an approximate polygon, derived per part, used *only* by the packing algorithm to decide placement. Never exported, never affects fidelity.
- **Sheet** — the press sheet onto which parts are nested; defined by width × height, with a non-printable **margin** and a **gap** (edge-to-edge spacing between parts).
- **True-shape nesting** — packing parts along their actual outlines (not bounding boxes) via No-Fit-Polygon (NFP) geometry and a genetic optimizer.
- **Placement** — a part instance positioned on a sheet: target part, sheet index, x/y, rotation.
- **Utilization** — percentage of usable sheet area covered by placed parts.
- **Separation / spot color** — a named PDF colorspace (e.g. `PANTONE 485 C`, `Dieline`). Preserved byte-for-byte for PDF inputs.
- **Nest job** — the full run: the set of parts (with quantities) + sheet config, fed to the optimizer to produce per-sheet placements.

## Problem Statement

I run prepress for a print team. When I need to gang multiple pieces of artwork onto a single press sheet to save material, my options are bad. Deepnest does true-shape nesting well, but it is a desktop app that flattens artwork to plain paths — it destroys the **named spot colors** and exact vector content my files depend on, so its output is unusable for commercial printing. Manual imposition in Illustrator/Acrobat preserves the artwork but is slow and wastes material because I'm hand-placing irregular shapes. I have no quick, trustworthy way to take a pile of print-ready PDFs (and the occasional SVG/PNG/JPG), pack them tightly onto a sheet I define, and get back a press-ready PDF with every spot color and vector path intact.

## Solution

EasyNest is a single-page web app (HTML/CSS/JS, no backend, no build step, served from GitHub Pages) that my team opens in a browser. I drag in my files, set a quantity for each, define my sheet size and spacing, and click nest. It packs the parts using true-shape nesting, filling as many sheets as the quantities require, and shows me the layout improving live with a running utilization figure. When I'm happy, I stop and export a print-ready PDF — one page per sheet — in which every PDF part is embedded **exactly as it came in**: vector paths, named spot/separation colors, overprint, and fonts all preserved, simply repositioned and rotated. Raster and SVG parts come along too. No artwork is ever rasterized or recolored on its way out.

## User Stories

1. As a prepress operator, I want to open EasyNest from a URL with nothing to install, so that any teammate can use it on any machine.
2. As a prepress operator, I want to drag and drop one or more files onto the app, so that I can add parts quickly.
3. As a prepress operator, I want a file-picker button as an alternative to drag-and-drop, so that I can add files without dragging.
4. As a prepress operator, I want to import PDF files as parts, so that I can nest my print-ready artwork.
5. As a prepress operator, I want each page of a multi-page PDF to become its own part, so that I can nest documents that contain several pieces.
6. As a prepress operator, I want to import SVG files as parts, so that I can nest vector artwork that isn't already PDF.
7. As a prepress operator, I want to import PNG and JPG files as parts, so that I can nest raster artwork alongside vector pieces.
8. As a prepress operator, I want to see a thumbnail of each imported part in a parts list, so that I can confirm what I've added.
9. As a prepress operator, I want each part to show its name and physical dimensions, so that I can sanity-check size before nesting.
10. As a prepress operator, I want to set a quantity for each individual part, so that the sheet reflects how many of each piece I actually need.
11. As a prepress operator, I want to increment/decrement quantities with a stepper and by typing a number, so that I can adjust counts fast.
12. As a prepress operator, I want to remove a part from the list, so that I can correct a mistaken import.
13. As a prepress operator, I want to define a custom sheet width and height, so that the layout matches my actual stock.
14. As a prepress operator, I want to pick from common sheet-size presets (e.g. Letter, Tabloid, 12×18, 13×19, 28×40), so that I don't have to type dimensions for routine jobs.
15. As a prepress operator, I want to choose my units (inches or millimeters), so that I can work in the system I think in. Inches is the default.
16. As a prepress operator, I want to set a sheet margin (non-printable / gripper edge), so that no part lands in an unprintable zone.
17. As a prepress operator, I want to set a gap (edge-to-edge spacing) between parts, so that pieces don't touch and can be cut/separated cleanly.
18. As a prepress operator, I want PDF and SVG parts placed at their exact native physical size (1:1, never auto-scaled), so that my artwork prints at the intended dimensions.
19. As a prepress operator, I want raster parts (and unitless-viewBox SVGs) sized by an assumed 300 DPI by default, so that they get a sane physical size without my intervention.
20. As a prepress operator, I want to override a raster part's size (by width/height or by DPI), so that I can correct images that aren't actually 300 DPI.
21. As a prepress operator, I want parts free to rotate to any angle during nesting, so that the optimizer achieves the tightest packing and best material yield.
22. As a prepress operator, I want a single "Start Nest" action, so that I can kick off the optimization without configuring algorithm internals.
23. As a prepress operator, I want the nesting to run in the background without freezing the page, so that the UI stays responsive while it works.
24. As a prepress operator, I want the sheet preview to update live to the best layout found so far, so that I can watch the result improve.
25. As a prepress operator, I want a running utilization percentage, so that I can judge how good the current layout is.
26. As a prepress operator, I want a "Stop" action, so that I can end the run the moment the layout is good enough.
27. As a prepress operator, I want parts that exceed one sheet to overflow automatically onto additional sheets, so that all requested quantities get placed without manual intervention.
28. As a prepress operator, I want to page through the resulting sheets in the preview, so that I can review each one before exporting.
29. As a prepress operator, I want to see how many sheets the job produced, so that I can anticipate the press run.
30. As a prepress operator, I want to export the result as a single PDF with one page per sheet, so that I have a press-ready imposition file.
31. As a prepress operator, I want every PDF part embedded in the export exactly as imported — vector paths, named spot/separation colors, overprint, and fonts intact — so that the output is acceptable for commercial printing.
32. As a prepress operator, I want SVG parts converted to vector in the exported PDF (not rasterized), so that they stay crisp at any size.
33. As a prepress operator, I want raster parts embedded at their native resolution, so that image quality isn't degraded on export.
34. As a prepress operator, I want each part's position and rotation in the export to match exactly what the optimizer placed, so that the printed sheet matches the preview.
35. As a prepress operator, I want the exported PDF's page size to equal my defined sheet size, so that it drops straight into my press workflow.
36. As a prepress operator, I want my last-used settings (sheet size, units, margin, gap, rotation) remembered between sessions, so that I don't re-enter them every time.
37. As a prepress operator, I want a clear single-screen layout with parts, preview, and settings all visible, so that I can iterate quickly.
38. As a prepress operator, I want to be warned if a single part is larger than the usable sheet area, so that I understand why it couldn't be placed.
39. As a prepress operator, I want to change a quantity or setting and re-run the nest, so that I can compare layouts without rebuilding the job from scratch.
40. As a prepress operator, I want a clear indication while nesting is in progress versus stopped/idle, so that I know the current state of the run.
41. As a prepress operator, I want to add more files to an existing job before nesting, so that I can build up a sheet incrementally.
42. As a prepress operator, I want the export action available once a valid layout exists, so that I don't accidentally export an empty or stale result.

## Implementation Decisions

### Architecture & hosting
- Pure client-side single-page app: HTML, CSS, and JavaScript only. **No build step, no compilation, no backend.** Deployable as static files to GitHub Pages.
- Third-party libraries are vendored as browser-ready bundles and loaded directly (no bundler). Internal code is organized as plain modules.
- The app is structured in layers: a thin **UI shell** (DOM, parts list, settings panel, paged sheet preview) on top; a headless **core engine** in the middle; vendored libraries at the bottom. The UI never talks to the libraries directly for nesting/export — it goes through the core engine.

### Nesting engine
- True-shape nesting is provided by a fork of **SVGnest's pure-JavaScript core** (No-Fit-Polygon geometry + genetic optimizer). No native/WASM components.
- The optimizer runs in a **web worker** so the main thread stays responsive. It runs continuously, emitting progressively better placement results and a utilization figure, until the user stops it.
- Rotation is unconstrained ("free") — the optimizer evaluates fine-grained rotation angles to maximize yield.
- The genetic optimizer accepts an injectable seed for its random number generator, so a given job + seed yields a reproducible layout. (Reproducibility aid; no automated test suite is planned — verification is hands-on.)

### Part model & normalization
- Import normalizes every input into a **Part**: a stable identity, the original **artwork payload** (kept untouched), the part's intrinsic physical size, a quantity, and a derived **nesting outline** polygon.
- Multi-page PDFs are expanded at import into one Part per page.
- The **nesting outline** is derived by a unified raster-trace: render the part to an offscreen canvas, threshold it (alpha channel for transparent parts; background-color removal for opaque rasters), run marching-squares to get a contour, and simplify it to a polygon. This outline is consumed only by the optimizer and is intentionally approximate; it never participates in export.
- Physical sizing rules: PDF and SVG parts use their intrinsic size (placed 1:1, never auto-scaled). Raster parts and unitless-viewBox SVGs default to 300 DPI, with a per-part override expressed as width/height or DPI.

### Sheet & job model
- A **Sheet config** carries width, height, units, margin, and gap. The usable nesting area is the sheet inset by the margin; the gap is enforced as minimum edge-to-edge spacing between placed outlines.
- A **Nest job** is the set of Parts (with quantities) plus the Sheet config. The optimizer produces a result of per-sheet **Placements** (part instance, sheet index, x/y, rotation) and overflows onto additional sheets automatically until all quantities are placed.
- A part whose outline cannot fit within the usable sheet area is surfaced to the user as unplaceable rather than silently dropped.

### Export & fidelity (the crown jewel)
- Export composes a single multi-page PDF (one page per sheet) using **pdf-lib**, with each page's MediaBox equal to the configured sheet size.
- **PDF parts are embedded as PDF pages** (copied as form content), preserving their content streams and resources verbatim — vector geometry, named Separation/DeviceN spot colors, overprint, and fonts — repositioned and rotated by an exact affine transform only. Artwork is never rasterized or recolored on export.
- **SVG parts are converted to vector** for embedding (via an SVG→PDF vector conversion), keeping them resolution-independent. Known limitation: advanced filters, some gradients, and unembedded fonts may be approximated; the documented workaround is to pre-export such SVGs to PDF.
- **Raster parts** are embedded as native PNG/JPG images at their source resolution, sized per the part's physical dimensions.
- Placement transforms applied at export match the optimizer's result exactly, so the exported sheet is a faithful realization of the preview.

### Persistence & state
- User settings (sheet size, units, margin, gap, rotation) persist in the browser's localStorage between sessions. Imported files and computed layouts are not persisted — they are re-added per session.
- Placement is fully automatic in v1: no manual drag/rotate of placed parts; the user changes settings/quantities and re-runs.

### Explicitly out of scope for v1
- SVG export (PDF output only).
- Spot-color inspector / detection UI (spot colors are still preserved silently).
- Printer's marks (crop/registration/slug).
- Manual placement editing after auto-nest.
- Auto-splitting a single file into multiple parts (one part per page/file only).
- Full project save/load of files + layouts.
