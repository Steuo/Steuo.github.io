# Steno — project blueprint

Written so that another person, or another AI instance, can pick this project up cold.
Read this first, then `README.md` (user-facing docs). This file covers what the project is,
how it is built, what was changed in the latest revision, and what was and was not verified.

---

## 1. What this is

Steno is a **static, backend-less, in-browser compressor** for images and PDFs.

- No server, no upload, no build step. Everything runs in the visitor's tab (Canvas API,
  `pdf-lib`, `pdf.js`). It is meant to be hosted as plain files (GitHub Pages etc.).
- Two pages share one layout language and one controller (`createApp` in `js/common.js`): `index.html` (images) and `pdf/index.html` (PDFs).
- Design is deliberately minimal: fixed palette (`--bg #FDFDFD`, `--ink #000`, `--red #CE0304`,
  white), no web fonts, no framework, ES5-style JS in IIFEs.
- Privacy promise: nothing leaves the tab. Third-party libs load from `vendor/` first, CDN only
  lazily (when a run needs them) and never if `ALLOW_CDN = false` in `js/common.js`.

## 2. File map

```
index.html        image page: dock (settings) + preview grid of cards
pdf/index.html    PDF page: single centred panel with settings + one row per file
css/style.css     whole design system (tokens at top; workspace/dock layout for the image page)
js/common.js      shared: helpers, library loader, createApp() controller (live runs, queue, UI, downloads)
js/image.js       image compression: options, canvas resize/encode, target-size search, decode cache
js/pdf.js         PDF compression: smart (recompress embedded JPEGs in place) and scanned (rasterize)
tools/vendor.sh   downloads jszip / pdf-lib / pdf.js (+worker) into vendor/ (pinned versions)
assets/           logo.svg, logo.webp, favicon.ico, apple-touch-icon.png
README.md         user-facing docs
BLUEPRINT.md      this file
LICENSE           MIT
```

`vendor/` is not in the repo until someone runs `sh tools/vendor.sh`.

## 3. Architecture

### 3.1 Tool = config object + `Steno.createApp(cfg)`

Each page script (`image.js`, `pdf.js`) only knows about its own compression and calls
`createApp` with:

| field | meaning |
|---|---|
| `noun` | `"image"` or `"PDF"` (used in messages) |
| `accept(file)` | is this file type allowed |
| `warm` | libs to look for in `vendor/` at page load (never touches the network) |
| `libsFor(opts)` | libs a run needs up front (`pdflib`, `pdfjs`; the image page returns none, and `image.js` asks for `heic2any` itself when it meets a HEIC file) |
| `readOptions()` | snapshot of the settings controls; may throw `UserError` (e.g. resize < 1) |
| `compress(file, opts, ctx)` | returns `{ name, blob, note?, dims?, before? }` |
| `zipName` | name of the "Download all" zip |
| `onQueue(list)` | optional; called whenever the queue changes (image page: prunes the decode cache, resets the Target slider when the queue is empty) |
| `liveInputs` | optional array of controls; together with a `#previewGrid` in the page this turns on **live mode** (image page only) |

`ctx` given to `compress`:

- `status(text)`: progress text (shown on the Compress button in manual mode; a no-op in live mode)
- `tick()`: yield to the UI
- `cancelled()`: **live mode only**; returns true when the run has been superseded or the app is busy.
  `image.js` calls it through `checkCancel(ctx)`, which throws `Steno.Cancelled`. In manual mode
  `ctx.cancelled` is undefined, so `checkCancel` is a no-op.

There is no `delay` or `dispose` field; debounce timing lives in `common.js` and caches are pruned via `onQueue`.

### 3.2 The two run modes

The same controller drives both pages, but they behave differently:

| | image page (`index.html`) | PDF page (`pdf/index.html`) |
|---|---|---|
| mode | **live**: no Compress button | **manual**: `#compressBtn` |
| results shown in | `#previewGrid` cards | `#panel` rows (`.file-row`, `.summary-row`) |
| Download | `#downloadAllBtn` (label is `Download` for one file, `Download all (.zip)` for several) | per-row link, plus `#downloadAllBtn` once there is more than one result |
| `busy` | never set (live runs are cancellable) | set for the duration of a run; adding files or pressing × meanwhile shows "Please wait until the current run finishes" |

#### Live mode (image page)

State (all inside `createApp`):

- `queue[]` (files) and `cards[]` (one per file). A card holds the file, its DOM, the last output
  `out`, the options signature `sig` it was produced with, an `err`, and `dead` once disposed.
- `liveDirty` (a change happened that no run has picked up yet), `liveRunning`, `liveTimer` (debounce),
  `liveIdle` (promise of the current loop, awaited by `stopLive()`).
- `lastSettingsSig`: the options signature seen by the last settings event (see step 1).

Flow:

1. `input`/`change` on any control in `cfg.liveInputs` → `settingsChanged`. It computes
   `currentSig()` (= `JSON.stringify(readOptions())`) and **returns early if it equals
   `lastSettingsSig`**. A single edit fires both `input` and `change`; without this guard the second
   event would re-disable Download in the middle of a click (typing in Resize, then clicking Download
   blurs the field, which fires `change`). `reset()` sets `lastSettingsSig = null`, because it moves the
   Target slider back to 100 without any event; otherwise dragging the slider back to the old value
   would be ignored. An unreadable setting gives `currentSig() === null`, which is never skipped.
2. Otherwise it clears finished results, marks the cards `is-updating`, and calls
   `scheduleLive(delay, trailing)`: 90 ms throttle (`LIVE_THROTTLE`) for sliders/selects, 400 ms trailing
   debounce (`LIVE_DEBOUNCE`) while typing in a number field.
3. When the timer fires, `kickLive()` starts `liveLoop()` (never two at once). The loop runs while
   `liveDirty && !busy`: it clears `liveDirty`, reads the options (invalid → `notify` the message, stop),
   then compresses, **one at a time**, every card whose `sig` differs from the current one, applying each
   result with `applyOut` / `applyError` as soon as it exists. If another change arrives meanwhile
   (`liveDirty` again), `ctx.cancelled()` turns true, the compressor throws `Cancelled`, the loop catches
   it (`err.name === "Cancelled"`) and starts over with the new options. Cards already matching the
   options are skipped, so adding a file only compresses the new one.
4. `updateDownloadAll()` keeps `#downloadAllBtn` disabled while `liveRunning || liveDirty || liveTimer`,
   so the file you get always equals the numbers on screen. The totals block is `#liveTotal`
   (`#liveState`, `#livePct`, `#liveBar`).

#### Manual mode (PDF page)

`run()` (bound to `#compressBtn`): reads options, `setBusy(true)`, clears old results, loads the libraries
`libsFor(opts)` needs, then compresses the queue one file at a time and renders a row per result.

Rules to keep when editing:

- Any `try/catch` inside a `compress()` implementation **must rethrow cancellation**
  (`if (e && e.name === "Cancelled") throw e;`) or a stale live run will keep going or "fall back" wrongly.
- Swap a card's blob URL **after** the new one is on screen, then revoke the old.
- Download stays disabled until the numbers on screen match the settings (live mode: see step 4).
- Any code that changes a live input's value without firing an event must also reset `lastSettingsSig`
  (today only `reset()` does this, through `onQueue`'s Target-slider reset).

### 3.3 Image compression (`js/image.js`)

- Options: quality (0.10–1.00), output format (`auto` keeps the source format; GIF/AVIF/BMP → WEBP
  or JPG), max side (blank = keep), target size as a percentage of the original (slider 1–100, JPG/WEBP only).
- Canvas re-encode; JPG gets a white background first (no alpha). 16 MP canvas cap (iOS Safari).
  Whenever a source that can have transparency is saved as JPG, the result carries the note
  "Any transparent areas were filled with white." (this includes choosing JPG explicitly).
- Target size: try the slider quality; if too big, try the floor quality; if the floor fits,
  bisect (7 steps) for the highest quality that fits; otherwise shrink pixels and repeat (≤ 6 rounds).
- If the result is bigger than the original and neither format nor size was changed, the
  original is returned ("Already well optimized").
- Formats (`js/formats.js`, pure functions, no DOM; unit-testable under Node): content sniffing,
  RAW preview extraction (scan for JPEG streams, keep only decodable baseline/progressive ones,
  largest first, so lossless-JPEG sensor data is skipped), EXIF/TIFF/CR3 orientation, SVG
  minify/size helpers, ICO writer.
- SVG → raster: `svgWithSize(text, w, h, fallbackViewBox)` rewrites `width`/`height`. An SVG with no usable
  `viewBox` would be cropped rather than scaled, so `compressSvg` passes the original size as a fallback and
  a `viewBox="0 0 W H"` is added (or an unusable one replaced). SVGs that already have a valid `viewBox`
  are left alone.
- **Decode cache**: `image.js` keeps up to `MAX_CACHE = 3` decoded sources (LRU, `getSource`) so slider
  changes don't re-decode; `pruneCache(list)` (called from `onQueue`) drops entries for files that left the
  queue and releases their decoded sources.
- A compressor may return `out.before` (a Blob) as a displayable stand-in for originals the browser can't
  show (HEIC/RAW); common.js swaps it in.
- HEIC: native decode first, else `heic2any` (lazy, `vendor/` then CDN). RAW and HEIC are always
  converted (never "original kept"). JPEG XL: native only, plus an optional `window.StenoJxlDecode` hook.

### 3.4 PDF compression (`js/pdf.js`)

- **Smart (default)**: walk page resources (and nested Form XObjects), re-encode eligible
  DCTDecode images at the chosen quality/max size, leave anything risky untouched (CMYK, Indexed,
  ICC, EXIF-rotated, /Decode, masks, non-8-bit…). Falls back to a lossless object-stream re-save,
  then to the original file. Never returns a bigger file.
- **Scanned**: render each page with `pdf.js` at ≤ 2× (capped by max size / 16 MP), rebuild as JPEG
  pages at the original physical size. Text becomes non-selectable.
- There is no byte cache: each run reads the file with `file.arrayBuffer()`, and the scanned path passes that
  `Uint8Array` straight to `pdfjs.getDocument({ data })` (no copy is made).

### 3.5 Layout notes (CSS)

- Image page: `.workspace` is `position: fixed` over the stage: settings dock bottom-left, scrolling
  preview grid on the right; on ≤ 760 px the dock moves to the bottom. There is no body class for it
  (the page behind is covered by the fixed workspace).
- `[hidden]` is forced with `display: none !important`, so toggling `hidden` always wins.
- `.live-total` / `.live-state` / `.live-sizes` / `.live-pct` (the totals block) and `.is-updating` on a
  card or on `.live-total` (dimming while numbers are stale) belong to live mode.

## 4. Changes in this revision

### Output format simplified (latest)

- `index.html`: removed the "Keep original format" (`value="auto"`) option from the Output format
  select, and removed the hint paragraph under it ("PNG stays lossless, so it only shrinks with
  Resize. Pick WEBP or JPG for bigger savings. HEIC and RAW files become JPG; SVG stays a vector
  unless you pick a raster format.").
- JPG is now the first option, so it is the default selection. A PNG (or any other input) is
  output as JPG unless the user picks another format in Advanced settings.
- No JS, CSS or other file was changed. The `"auto"` branches in `js/image.js` (SVG minify path,
  `encodeSource`, `formatUnasked`) are still present but can no longer be reached from the UI,
  because the select no longer offers that value.
- Other hints (Quality, Target size) and the "PNG (lossless)" option label were left as they were.

### Bug fixes

1. **The × ("start over") button also opened the file picker, on both pages.** `reset()` hides the panel
   during the click; the same click then bubbles to the stage handler, which sees a hidden panel and
   treats it as a click on the empty stage. (An earlier revision of this file said this was fixed, but the
   code did not contain the fix.) The stage handler now ignores clicks whose target is inside `#toolPanel`.
   Clicking the empty stage still opens the picker.
2. **Image page: the first Download click after typing in Resize was swallowed.** Clicking blurs the number
   field, which fires `change`; `settingsChanged` reran even though nothing had changed since the `input`
   event, and disabled Download before the click completed. `settingsChanged` now skips events whose
   options signature equals `lastSettingsSig`, and `reset()` clears it (see 3.2).
3. **An SVG without a `viewBox`, saved as PNG/JPG/WEBP/ICO with Resize set, came out mostly empty** (a
   100×100 red square resized to 200 gave only a red top-left quarter). See `svgWithSize` in 3.3.
4. **Choosing JPG explicitly for a transparent PNG gave no "filled with white" note** (the README says the
   note appears). The condition in `encodeSource` no longer excludes an explicit JPG choice.
5. `js/compare.js` was not loaded by any page and nothing referenced it; it was deleted.
6. This file was out of date and has been rewritten to match the code.
7. **A cancelled SVG-to-raster run leaked the SVG's blob URL.** `compressSvg` called `checkCancel` before the
   `try/finally` that releases the loaded SVG. Reproduced in Chromium with 60 quick Quality changes on an SVG
   saved as PNG: 25 blob URLs outstanding after settling (about 2 expected) and 23 still outstanding after ×.
   `checkCancel` now sits inside the `try`; the same run leaves 2, then 0 after ×.
8. **PDF smart mode had no 16 MP canvas cap** (the image page and scanned mode both do). With "Don't resize", an
   embedded JPEG above 16 MP went through a full-size canvas; where a browser returns a blank canvas, the blank
   image would pass the "is it smaller" check and replace the original. Such images are now scaled to fit.
   Verified in Chromium (a 5000x4000 image comes out 4472x3577); not tested on iOS Safari.

### Earlier revision (kept for history)

- Byte formatting could print "1024 KB" for sizes just under 1 MB; it now rolls over to MB.
- The image page switched to live compression (no Compress button; every settings change re-runs).

## 5. Verification (what was actually run)

**This revision.** Headless Chromium (Playwright) against a local static server with the CDN blocked.
Each case was run on the original tree (must fail) and on the fixed tree (must pass):

- × on the image page and on the PDF page no longer opens the picker; clicking the empty stage still does.
- Image page: type a Resize value, wait for Download to enable, click it once → the file downloads
  (300 px wide). Fails on the original.
- After × and re-adding a file, moving the Target slider back to a value used before the reset updates
  the result. This also fails if only the `lastSettingsSig = null` line in `reset()` is removed.
- 100×100 red SVG without `viewBox` → PNG at Resize 200: 200×200 and all four corners opaque red.
- Transparent PNG with JPG chosen explicitly shows the white-fill note; auto format on a PNG does not.
- `svgWithSize` under Node: no viewBox, valid viewBox (untouched), invalid viewBox (replaced), width only,
  no size, prefixed root (`svg:svg`), percentage size, self-closing root, and the old 3-argument call.

**Not verified:** the *scanned* PDF path against the real `pdf.js` 3.11 (it cannot be loaded offline),
real HEIC and RAW files, Firefox and Safari, and PDFs with CMYK, ICC or EXIF-rotated images. The PDF page
was only exercised for the × behavior (it needs `pdf-lib`, which was not available offline for a full run).

**Earlier revision (not re-run now).** A larger Playwright suite covered live updates, readout = downloaded
size, rapid slider changes, reset mid-run, corrupt files, multi-file zips, and missing-library recovery.

## 6. Known limitations / ideas

- Only JPEG images inside PDFs are recompressed in smart mode (see README "Limitations").
- Live mode re-parses a PDF on every run; very large PDFs will feel slower per change. A worker or
  caching rendered pages for the scanned mode would help.
- The animated-GIF note is shown for every GIF (a frame count isn't read).
- Ideas: per-file remove button, remembering settings in `localStorage`. (The before/after compare slider
  already exists: it is built inside `common.js`, in the card markup.)

## 7. Working conventions

- No build tools, no frameworks, no web fonts. Keep the four-colour palette.
- Keep the loader order: `vendor/` → CDN (lazy). Don't add anything that contacts a third party on
  page load.
- Test in a real browser after touching `common.js`: the controller is timing-sensitive.
