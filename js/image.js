(function () {
  "use strict";

  var C = window.Steno;
  var F = window.StenoFormats;
  var UserError = C.UserError;
  var $ = function (id) { return document.getElementById(id); };

  var quality = $("quality");
  var qualityVal = $("qualityVal");
  var format = $("format");
  var maxDim = $("maxDim");
  var targetSize = $("targetSize");
  var targetVal = $("targetVal");
  var files = [];

  var MIN_QUALITY = 0.05;
  var MAX_CANVAS_PIXELS = 16000000;
  var ICO_MAX = 256;
  var VIEW_MAX = 2400;
  var MAX_CACHE = 3;

  var ICO = "image/x-icon";
  var KIND_MIME = {
    jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
    avif: "image/avif", ico: ICO, heic: "image/heic", jxl: "image/jxl", svg: "image/svg+xml"
  };
  var ALPHA_KINDS = { png: 1, gif: 1, webp: 1, avif: 1, bmp: 1, ico: 1, svg: 1, jxl: 1, unknown: 1 };
  var ACCEPT_EXT = /\.(jpe?g|png|apng|gif|webp|avif|svg|ico|bmp|heic|heif|jxl|dng|cr2|cr3|nef|arw|raf|orf|rw2|pef)$/i;

  function checkCancel(ctx) {
    if (ctx && ctx.cancelled && ctx.cancelled()) throw new C.Cancelled();
  }

  quality.addEventListener("input", function () { qualityVal.textContent = quality.value; });

  function targetPct() {
    var v = parseInt(targetSize.value, 10);
    return v >= 1 && v < 100 ? v : 100;
  }
  function updateTargetLabel() {
    var pct = targetPct();
    var text;
    if (files.length === 1) {
      text = C.fmtBytes(Math.max(1, Math.round(files[0].size * pct / 100))) + (pct === 100 ? " (original)" : " \u00b7 " + pct + "%");
    } else if (files.length > 1) {
      text = pct === 100 ? "Original sizes" : pct + "% of each";
    } else {
      text = pct === 100 ? "Original" : pct + "%";
    }
    targetVal.textContent = text;
  }
  targetSize.addEventListener("input", updateTargetLabel);
  updateTargetLabel();

  var encodeSupport = {};
  function canEncode(type) {
    if (type in encodeSupport) return encodeSupport[type];
    var ok = false;
    try {
      var c = document.createElement("canvas");
      c.width = c.height = 1;
      ok = c.toDataURL(type).indexOf("data:" + type) === 0;
    } catch (e) { }
    encodeSupport[type] = ok;
    return ok;
  }

  function extFor(type) {
    return type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === ICO ? "ico" : "jpg";
  }

  function baseName(file) {
    return (file.name || "").replace(/\.[^.]+$/, "") || "image";
  }

  function toBlob(canvas, type, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new UserError("Your browser couldn\u2019t encode this image (it may be too large)."));
      }, type, q);
    });
  }

  function loadImage(blob, failMessage) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      var release = function () { URL.revokeObjectURL(url); };
      img.onload = function () { resolve({ img: img, release: release }); };
      img.onerror = function () {
        release();
        reject(new UserError(failMessage || "This browser couldn\u2019t read this image (unsupported format, or the file is damaged)."));
      };
      img.src = url;
    });
  }

  function typedBlob(file, mime) {
    return !mime || file.type === mime ? file : new Blob([file], { type: mime });
  }

  function readOptions() {
    var q = Math.min(100, Math.max(1, parseInt(quality.value, 10) || 75)) / 100;
    var cap = parseFloat(maxDim.value);
    if (cap > 0 && cap < 1) throw new UserError("Resize must be at least 1 px (or leave it blank).");
    return {
      format: format.value,
      quality: q,
      maxDim: cap > 0 ? Math.round(cap) : 0,
      targetPct: targetPct() < 100 ? targetPct() : 0
    };
  }

  var infoCache = typeof WeakMap === "function" ? new WeakMap() : null;

  async function getInfo(file) {
    if (infoCache && infoCache.has(file)) return infoCache.get(file);
    var head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    var info = F.sniff(head, file.name, file.type);
    if (info.kind === "png") {
      info.animated = await F.pngIsAnimated(async function (pos, len) {
        return new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
      }, file.size);
    }
    if (infoCache) infoCache.set(file, info);
    return info;
  }

  var cache = [];

  function releaseSrc(src) {
    (src.releases || []).forEach(function (fn) { try { fn(); } catch (e) { } });
    src.releases = [];
  }

  function getSource(file, info) {
    for (var i = 0; i < cache.length; i++) {
      if (cache[i].file === file) {
        var hit = cache.splice(i, 1)[0];
        cache.push(hit);
        return hit.promise;
      }
    }
    var entry = { file: file, dead: false, src: null };
    entry.promise = prepare(file, info).then(function (src) {
      entry.src = src;
      if (entry.dead) releaseSrc(src);
      return src;
    }, function (err) {
      var at = cache.indexOf(entry);
      if (at >= 0) cache.splice(at, 1);
      throw err;
    });
    cache.push(entry);
    while (cache.length > MAX_CACHE) {
      var old = cache.shift();
      old.dead = true;
      if (old.src) releaseSrc(old.src);
    }
    return entry.promise;
  }

  function pruneCache(list) {
    cache = cache.filter(function (e) {
      if (list.indexOf(e.file) >= 0) return true;
      e.dead = true;
      if (e.src) releaseSrc(e.src);
      return false;
    });
  }

  function drawOriented(c2d, img, orient, cw, ch) {
    if (orient > 1) {
      var m = F.orientMatrix(orient, cw, ch);
      c2d.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      c2d.drawImage(img, 0, 0, orient >= 5 ? ch : cw, orient >= 5 ? cw : ch);
      c2d.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      c2d.drawImage(img, 0, 0, cw, ch);
    }
  }

  async function renderView(img, orient, w, h) {
    var s = Math.min(1, VIEW_MAX / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    var canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    try {
      var c2d = canvas.getContext("2d");
      if (!c2d) return null;
      c2d.imageSmoothingEnabled = true;
      c2d.imageSmoothingQuality = "high";
      drawOriented(c2d, img, orient, cw, ch);
      return await toBlob(canvas, "image/jpeg", 0.9);
    } catch (e) {
      return null;
    } finally {
      canvas.width = canvas.height = 0;
    }
  }

  function finishSource(src, loaded) {
    src.img = loaded.img;
    src.releases.push(loaded.release);
    var nw = loaded.img.naturalWidth, nh = loaded.img.naturalHeight;
    if (!nw || !nh) throw new UserError("Couldn\u2019t read this image\u2019s dimensions.");
    src.w = src.orient >= 5 ? nh : nw;
    src.h = src.orient >= 5 ? nw : nh;
    return src;
  }

  async function prepare(file, info) {
    var kind = info.kind;
    var src = {
      kind: kind, mime: KIND_MIME[kind] || "", img: null, w: 0, h: 0, orient: 0, view: null,
      notes: [], animated: !!info.animated, icoCount: info.icoCount || 0, releases: []
    };

    try {
      if (kind === "raw") {
        var bytes = new Uint8Array(await file.arrayBuffer());
        var found = F.extractRawPreviews(bytes);
        if (!found.candidates.length) {
          throw new UserError("No usable JPEG preview was found inside this RAW file (it may hold only sensor data).");
        }
        var loaded = null, chosen = null;
        for (var i = 0; i < Math.min(3, found.candidates.length) && !loaded; i++) {
          var c = found.candidates[i];
          var pv = new Blob([bytes.subarray(c.start, c.end)], { type: "image/jpeg" });
          try {
            loaded = await loadImage(pv);
            chosen = { c: c, blob: pv };
          } catch (e) { loaded = null; }
        }
        if (!loaded) throw new UserError("The preview inside this RAW file couldn\u2019t be decoded by this browser.");
        var own = F.jpegOrientation(bytes, chosen.c.start, chosen.c.end);
        src.orient = own ? 0 : (found.orient > 1 ? found.orient : 0);
        finishSource(src, loaded);
        src.view = src.orient ? await renderView(loaded.img, src.orient, src.w, src.h) : chosen.blob;
        src.notes.push("RAW: used the embedded JPEG preview (" + chosen.c.w + "\u00d7" + chosen.c.h + " px). The sensor data itself isn\u2019t decoded.");
        return src;
      }

      if (kind === "heic") {
        var native = null;
        try { native = await loadImage(typedBlob(file, "image/heic")); } catch (e) { native = null; }
        if (native) return finishSource(src, native);
        await C.requireLibs(["heic2any"]);
        var png;
        try {
          var res = await window.heic2any({ blob: file, toType: "image/png" });
          png = Array.isArray(res) ? res[0] : res;
        } catch (e) {
          throw new UserError("This HEIC/HEIF file couldn\u2019t be decoded" + (e && e.message ? " (" + e.message + ")." : "."));
        }
        if (!png) throw new UserError("This HEIC/HEIF file couldn\u2019t be decoded.");
        finishSource(src, await loadImage(png));
        src.view = png;
        return src;
      }

      if (kind === "jxl") {
        var nat = null;
        try { nat = await loadImage(typedBlob(file, "image/jxl")); } catch (e) { nat = null; }
        if (nat) return finishSource(src, nat);
        if (typeof window.StenoJxlDecode === "function") {
          var data = await window.StenoJxlDecode(await file.arrayBuffer());
          var jc = document.createElement("canvas");
          jc.width = data.width;
          jc.height = data.height;
          jc.getContext("2d").putImageData(data, 0, 0);
          var jb = await toBlob(jc, "image/png");
          jc.width = jc.height = 0;
          finishSource(src, await loadImage(jb));
          src.view = jb;
          return src;
        }
        throw new UserError("This browser can\u2019t open JPEG XL. Safari 17+ can; recent Chrome and Firefox only after JPEG XL is switched on in their settings.");
      }

      var mime = KIND_MIME[kind] || "";
      finishSource(src, await loadImage(typedBlob(file, mime)));
      if (kind === "ico" && src.icoCount > 1) {
        src.notes.push("This icon file holds " + src.icoCount + " sizes; only the largest one was used.");
      }
      return src;
    } catch (err) {
      releaseSrc(src);
      throw err;
    }
  }

  function wellFormedSvg(text) {
    try {
      var doc = new DOMParser().parseFromString(text, "image/svg+xml");
      return !doc.getElementsByTagName("parsererror").length &&
        !!doc.documentElement && doc.documentElement.localName === "svg";
    } catch (e) {
      return false;
    }
  }

  async function compressImage(file, opts, ctx) {
    var info = await getInfo(file);
    checkCancel(ctx);
    if (info.kind === "svgz") {
      throw new UserError("Compressed SVG (.svgz) isn\u2019t supported. Unzip it to .svg first.");
    }
    if (info.kind === "svg") return compressSvg(file, opts, ctx);
    var src = await getSource(file, info);
    checkCancel(ctx);
    return encodeSource(file, src, opts, ctx, null);
  }

  async function compressSvg(file, opts, ctx) {
    var text = await file.text();
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    checkCancel(ctx);
    if (!wellFormedSvg(text)) {
      throw new UserError("This SVG isn\u2019t valid XML, so a browser couldn\u2019t draw it either.");
    }
    var rootInfo = F.svgRootInfo(text);
    if (!rootInfo) throw new UserError("Couldn\u2019t read this SVG.");
    var intr = F.svgIntrinsic(rootInfo);

    if (opts.format === "auto") {
      var min = F.minifySvg(text);
      var notes = ["Vector kept: only comments, metadata and editor data were removed."];
      if (min === null || !wellFormedSvg(min)) {
        min = text;
        notes = ["Couldn\u2019t safely minify this SVG, so it was left as it is."];
      }
      var blob = new Blob([min], { type: "image/svg+xml" });
      var dims = { from: [intr.w, intr.h], to: [intr.w, intr.h] };
      if (blob.size >= file.size) {
        return { name: file.name, blob: file, dims: dims, note: "Already well optimized \u2014 original kept." };
      }
      return { name: baseName(file) + "-compressed.svg", blob: blob, dims: dims, note: notes.join(" ") };
    }

    var W = intr.w, H = intr.h, extra = [];
    if (opts.maxDim > 0) {
      var s = opts.maxDim / Math.max(W, H);
      W = Math.max(1, Math.round(W * s));
      H = Math.max(1, Math.round(H * s));
    } else if (intr.guessed) {
      extra.push("This SVG declares no size, so " + W + "\u00d7" + H + " px was assumed. Use Resize to choose one.");
    }
    var sized = F.svgWithSize(text, W, H, rootInfo.viewBox ? null :
      { w: rootInfo.width > 0 ? rootInfo.width : intr.w, h: rootInfo.height > 0 ? rootInfo.height : intr.h });
    if (sized === null) throw new UserError("Couldn\u2019t read this SVG.");
    var loaded = await loadImage(
      new Blob([sized], { type: "image/svg+xml" }),
      "This browser couldn\u2019t draw this SVG (for example, it may depend on external files)."
    );
    var src = {
      kind: "svg", mime: "image/svg+xml", img: loaded.img, w: W, h: H, orient: 0, view: null,
      notes: ["Rasterized from SVG at " + W + "\u00d7" + H + " px."].concat(extra),
      animated: false, icoCount: 0, releases: [loaded.release]
    };
    try {
      checkCancel(ctx);
      var o2 = { format: opts.format, quality: opts.quality, maxDim: 0, targetPct: opts.targetPct };
      return await encodeSource(file, src, o2, ctx, { from: [intr.w, intr.h] });
    } finally {
      releaseSrc(src);
    }
  }

  async function encodeSource(file, src, opts, ctx, fromOverride) {
    var canvases = [];
    try {
      var srcW = src.w, srcH = src.h;
      var kind = src.kind;
      var conv = kind === "heic" || kind === "raw";
      var notes = [];
      var fmtNotes = [];

      var outType = opts.format;
      if (outType === "auto") {
        if (kind === "jpeg" || kind === "png" || kind === "webp") {
          outType = src.mime;
        } else if (kind === "ico") {
          outType = ICO;
        } else if (conv) {
          outType = "image/jpeg";
        } else {
          outType = canEncode("image/webp") ? "image/webp" : "image/jpeg";
          fmtNotes.push("Saved as " + extFor(outType).toUpperCase() + " (this format can\u2019t be re-encoded as itself).");
        }
      }
      if (outType === "image/webp" && !canEncode("image/webp")) {
        outType = "image/jpeg";
        fmtNotes.push("This browser can\u2019t encode WebP, so JPG was used instead.");
      }
      if (outType === "image/jpeg" && src.mime !== "image/jpeg" && ALPHA_KINDS[kind]) {
        fmtNotes.push("Any transparent areas were filled with white.");
      }
      if (kind === "gif" || ((kind === "png" || kind === "webp") && src.animated)) {
        fmtNotes.push("Animation isn\u2019t preserved \u2014 only the first frame is kept.");
      }

      var isIco = outType === ICO;
      var encType = isIco ? "image/png" : outType;

      var w = srcW, h = srcH, resized = false;
      if (opts.maxDim > 0) {
        var longest = Math.max(w, h);
        if (longest > opts.maxDim) {
          var s = opts.maxDim / longest;
          w = Math.max(1, Math.round(w * s));
          h = Math.max(1, Math.round(h * s));
          resized = true;
        }
      }
      if (isIco && Math.max(w, h) > ICO_MAX) {
        var si = ICO_MAX / Math.max(w, h);
        w = Math.max(1, Math.round(w * si));
        h = Math.max(1, Math.round(h * si));
        resized = true;
        notes.push("Scaled to " + w + "\u00d7" + h + " px (an ICO holds at most 256 px).");
      }
      if (w * h > MAX_CANVAS_PIXELS) {
        var s2 = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
        w = Math.max(1, Math.floor(w * s2));
        h = Math.max(1, Math.floor(h * s2));
        resized = true;
        notes.push("Reduced to " + w + "\u00d7" + h + " px to fit browser limits.");
      }

      var draw = function (cw, ch) {
        canvases.forEach(function (c) { c.width = c.height = 0; });
        canvases.length = 0;
        var canvas = document.createElement("canvas");
        canvases.push(canvas);
        canvas.width = cw;
        canvas.height = ch;
        var c2d = canvas.getContext("2d");
        if (!c2d) throw new UserError("Your browser couldn\u2019t allocate a canvas this large.");
        if (encType === "image/jpeg") {
          c2d.fillStyle = "#ffffff";
          c2d.fillRect(0, 0, cw, ch);
        }
        c2d.imageSmoothingEnabled = true;
        c2d.imageSmoothingQuality = "high";
        drawOriented(c2d, src.img, src.orient, cw, ch);
        return canvas;
      };

      var blob, shrunkForTarget = false, outW = w, outH = h;
      var lossy = encType !== "image/png";
      var targetBytes = opts.targetPct ? Math.max(1, Math.round(file.size * opts.targetPct / 100)) : 0;
      if (targetBytes && !lossy) notes.push("Target size is ignored for " + (isIco ? "ICO" : "PNG") + " (it\u2019s lossless).");

      if (targetBytes && lossy) {
        var fit = await fitToTarget(draw, encType, w, h, opts.quality, targetBytes, ctx);
        blob = fit.blob;
        shrunkForTarget = fit.w !== w || fit.h !== h;
        outW = fit.w; outH = fit.h;
        if (shrunkForTarget) notes.push("Resized to " + fit.w + "\u00d7" + fit.h + " px to reach the target size.");
        if (!fit.met) notes.push("Couldn\u2019t reach " + C.fmtBytes(targetBytes) + " \u2014 this is the smallest possible.");
      } else {
        blob = await toBlob(draw(w, h), encType, opts.quality);
      }

      if (isIco) {
        var png = new Uint8Array(await blob.arrayBuffer());
        blob = new Blob([F.buildIco(png, outW, outH)], { type: ICO });
      }

      var formatUnasked = outType === src.mime || opts.format === "auto";
      if (!conv && formatUnasked && !resized && !shrunkForTarget && blob.size >= file.size) {
        var kept = {
          name: file.name,
          blob: file,
          dims: { from: [srcW, srcH], to: [srcW, srcH] },
          note: ["Already well optimized \u2014 original kept."].concat(notes).join(" ")
        };
        if (src.view) kept.before = src.view;
        return kept;
      }
      if (kind === "heic" && blob.size >= file.size) {
        notes.push("Larger than the original HEIC: HEIC is a more efficient format than " + extFor(outType).toUpperCase() + ". Lower the quality or choose WEBP for a smaller file.");
      }

      var from = fromOverride ? fromOverride.from : [srcW, srcH];
      var out = {
        name: baseName(file) + "-compressed." + extFor(outType),
        blob: blob,
        dims: { from: from, to: [outW, outH] },
        note: fmtNotes.concat(src.notes, notes).join(" ")
      };
      if (src.view) out.before = src.view;
      return out;
    } finally {
      canvases.forEach(function (c) { c.width = c.height = 0; });
    }
  }

  async function fitToTarget(draw, type, w, h, q0, target, ctx) {
    var cw = w, ch = h;
    var smallest = null;
    for (var attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) ctx.status("resizing\u2026");
      checkCancel(ctx);
      var canvas = draw(cw, ch);

      var first = await toBlob(canvas, type, q0);
      if (!smallest || first.size < smallest.blob.size) smallest = { blob: first, w: cw, h: ch };
      if (first.size <= target) return { blob: first, w: cw, h: ch, met: true };

      var floor = await toBlob(canvas, type, MIN_QUALITY);
      if (floor.size < smallest.blob.size) smallest = { blob: floor, w: cw, h: ch };

      if (floor.size <= target) {
        var lo = MIN_QUALITY, hi = q0, best = floor;
        for (var i = 0; i < 7; i++) {
          checkCancel(ctx);
          var mid = (lo + hi) / 2;
          var b = await toBlob(canvas, type, mid);
          if (b.size <= target) { lo = mid; best = b; } else { hi = mid; }
        }
        return { blob: best, w: cw, h: ch, met: true };
      }

      var factor = Math.min(0.9, Math.max(0.5, Math.sqrt(target / floor.size) * 0.95));
      var nw = Math.max(1, Math.round(cw * factor));
      var nh = Math.max(1, Math.round(ch * factor));
      if (nw === cw && nh === ch) break;
      cw = nw;
      ch = nh;
    }
    return { blob: smallest.blob, w: smallest.w, h: smallest.h, met: false };
  }

  C.createApp({
    noun: "image",
    accept: function (f) {
      return /^image\//.test(f.type) || ACCEPT_EXT.test(f.name);
    },
    warm: ["jszip"],
    libsFor: function () { return []; },
    readOptions: readOptions,
    compress: compressImage,
    zipName: "steno-images.zip",
    onQueue: function (list) {
      files = list;
      pruneCache(list);
      if (!list.length) targetSize.value = targetSize.max;
      updateTargetLabel();
    },
    liveInputs: [quality, format, maxDim, targetSize]
  });
})();
