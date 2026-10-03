(function () {
  "use strict";

  var C = window.Steno;
  var UserError = C.UserError;
  var $ = function (id) { return document.getElementById(id); };

  var quality = $("quality");
  var qualityVal = $("qualityVal");
  var maxDimSelect = $("maxDim");
  var scannedMode = $("scannedMode");

  var MAX_CANVAS_PIXELS = 16000000;

  quality.addEventListener("input", function () { qualityVal.textContent = quality.value; });

  function readOptions() {
    var q = Math.min(95, Math.max(20, parseInt(quality.value, 10) || 70)) / 100;
    return {
      quality: q,
      maxDim: parseInt(maxDimSelect.value, 10) || 0,
      scanned: scannedMode.checked
    };
  }

  function readExifOrientation(b, start, end) {
    if (end - start < 14) return 1;
    if (!(b[start] === 0x45 && b[start + 1] === 0x78 && b[start + 2] === 0x69 &&
          b[start + 3] === 0x66 && b[start + 4] === 0 && b[start + 5] === 0)) return 1;
    var t = start + 6;
    var view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var le = b[t] === 0x49 && b[t + 1] === 0x49;
    if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return 1;
    if (view.getUint16(t + 2, le) !== 0x2a) return 1;
    var ifd = t + view.getUint32(t + 4, le);
    if (ifd + 2 > end) return 1;
    var n = view.getUint16(ifd, le);
    for (var k = 0; k < n; k++) {
      var e = ifd + 2 + k * 12;
      if (e + 12 > end) return 1;
      if (view.getUint16(e, le) === 0x0112) {
        var v = view.getUint16(e + 8, le);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
    return 1;
  }

  function inspectJpeg(b) {
    if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    var info = { precision: 0, width: 0, height: 0, components: 0, orientation: 1, hasIcc: false };
    var i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      var m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m === 0xd9) break;
      var len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      var seg = i + 4;
      var end = i + 2 + len;
      if (end > b.length) return null;
      if (m === 0xe1) {
        if (info.orientation === 1) info.orientation = readExifOrientation(b, seg, end);
      } else if (m === 0xe2) {
        if (end - seg >= 12 && b[seg] === 0x49 && b[seg + 1] === 0x43 && b[seg + 2] === 0x43 && b[seg + 3] === 0x5f) {
          info.hasIcc = true;
        }
      } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        info.precision = b[seg];
        info.height = (b[seg + 1] << 8) | b[seg + 2];
        info.width = (b[seg + 3] << 8) | b[seg + 4];
        info.components = b[seg + 5];
      } else if (m === 0xda) {
        break;
      }
      i = end;
    }
    return info.components ? info : null;
  }
  C.internals.inspectJpeg = inspectJpeg;

  function isEncryptedError(e) {
    return (window.PDFLib.EncryptedPDFError && e instanceof window.PDFLib.EncryptedPDFError) ||
      /encrypt/i.test((e && e.message) || "");
  }

  async function openPdf(bytes) {
    try {
      return await window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      console.error("pdf-lib could not open the file:", e);
      if (isEncryptedError(e)) {
        throw new UserError(
          "This PDF is encrypted, so it can\u2019t be edited in place. Remove its password or " +
          "restrictions first, or tick \u201Cscanned document\u201D to rasterize it instead."
        );
      }
      throw new UserError(
        "Couldn\u2019t read this PDF \u2014 it may be damaged. If it opens fine elsewhere, " +
        "try the \u201Cscanned document\u201D option."
      );
    }
  }

  function pdfBlob(bytes) { return new Blob([bytes], { type: "application/pdf" }); }
  function outName(file) { return file.name.replace(/\.pdf$/i, "") + "-compressed.pdf"; }
  function keepOriginal(file, why) {
    return { name: file.name, blob: file, note: why || "Couldn\u2019t make this file any smaller \u2014 original kept." };
  }

  async function compressSmart(file, opts, ctx) {
    var bytes = new Uint8Array(await file.arrayBuffer());
    var doc = await openPdf(bytes);

    var smart = null;
    try {
      var stats = await recompressImages(doc, opts, ctx);
      if (stats.processed > 0) {
        smart = { blob: pdfBlob(await doc.save({ useObjectStreams: true, addDefaultPage: false })), stats: stats };
      } else {
        smart = { blob: null, stats: stats };
      }
    } catch (err) {
      console.error("Image recompression failed, falling back to lossless clean-up:", err);
      smart = { blob: null, failed: true, stats: { processed: 0, skipped: 0 } };
    }

    var best = smart.blob, note = "";
    if (best) {
      note = "Recompressed " + smart.stats.processed + " image" + (smart.stats.processed === 1 ? "" : "s") +
        (smart.stats.skipped ? "; " + smart.stats.skipped + " left as-is." : ".");
    }

    if (!best || best.size >= file.size) {
      ctx.status("optimizing\u2026");
      var fresh = await openPdf(bytes);
      var basic = pdfBlob(await fresh.save({ useObjectStreams: true, addDefaultPage: false }));
      if (!best || basic.size < best.size) {
        best = basic;
        if (smart.failed) {
          note = "Image recompression failed \u2014 lossless clean-up only.";
        } else if (smart.stats.processed > 0) {
          note = "Recompressing the images didn\u2019t make the file smaller \u2014 lossless clean-up only.";
        } else if (smart.stats.skipped > 0) {
          note = "No JPEG images could be recompressed (" + smart.stats.skipped + " left as-is) \u2014 lossless clean-up only.";
        } else {
          note = "No recompressible images found \u2014 lossless clean-up only.";
        }
      }
    }

    if (best.size >= file.size) return keepOriginal(file);
    return { name: outName(file), blob: best, note: note };
  }

  async function recompressImages(doc, opts, ctx) {
    var L = window.PDFLib;
    var PDFName = L.PDFName, PDFDict = L.PDFDict, PDFArray = L.PDFArray;
    var PDFNumber = L.PDFNumber, PDFRef = L.PDFRef;
    var N = function (s) { return PDFName.of(s); };

    var seen = new Set();
    var stats = { processed: 0, skipped: 0 };

    function onlyFilter(dict, name) {
      var f = dict.lookup(N("Filter"));
      if (f instanceof PDFArray) {
        if (f.size() !== 1) return false;
        f = f.lookup(0);
      }
      return !!f && String(f) === "/" + name;
    }

    function colorKind(cs) {
      if (!cs) return null;
      if (cs instanceof PDFName) {
        var n = String(cs);
        return n === "/DeviceRGB" ? "rgb" : n === "/DeviceGray" ? "gray" : null;
      }
      if (cs instanceof PDFArray && cs.size() >= 2 && String(cs.lookup(0)) === "/ICCBased") {
        var prof = cs.lookup(1);
        var comps = prof && prof.dict ? prof.dict.lookup(N("N")) : null;
        return comps instanceof PDFNumber && comps.asNumber() === 3 ? "rgb" : null;
      }
      return null;
    }

    async function recompressOne(stream) {
      var d = stream.dict;
      if (!onlyFilter(d, "DCTDecode")) return false;
      if (d.has(N("Decode")) || d.has(N("Mask"))) return false;
      var im = d.lookup(N("ImageMask"));
      if (im && String(im) === "true") return false;

      var bpc = d.lookup(N("BitsPerComponent"));
      if (bpc instanceof PDFNumber && bpc.asNumber() !== 8) return false;

      var sm = d.lookup(N("SMask"));
      if (sm && sm.dict && sm.dict.has(N("Matte"))) return false;

      var kind = colorKind(d.lookup(N("ColorSpace")));
      if (!kind) return false;

      var info = inspectJpeg(stream.contents);
      if (!info || info.precision !== 8) return false;
      if (info.components !== (kind === "gray" ? 1 : 3)) return false;
      if (info.hasIcc) return false;
      if (info.orientation !== 1) return false;

      var bitmap = await createImageBitmap(new Blob([stream.contents], { type: "image/jpeg" }));
      var canvas = null;
      try {
        var w = bitmap.width, h = bitmap.height;
        if (opts.maxDim > 0) {
          var longest = Math.max(w, h);
          if (longest > opts.maxDim) {
            var s = opts.maxDim / longest;
            w = Math.max(1, Math.round(w * s));
            h = Math.max(1, Math.round(h * s));
          }
        }
        if (w * h > MAX_CANVAS_PIXELS) {
          var cap = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
          w = Math.max(1, Math.floor(w * cap));
          h = Math.max(1, Math.floor(h * cap));
        }
        canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var c2d = canvas.getContext("2d");
        if (!c2d) return false;
        c2d.fillStyle = "#ffffff";
        c2d.fillRect(0, 0, w, h);
        c2d.imageSmoothingEnabled = true;
        c2d.imageSmoothingQuality = "high";
        c2d.drawImage(bitmap, 0, 0, w, h);

        var blob = await new Promise(function (res) { canvas.toBlob(res, "image/jpeg", opts.quality); });
        if (!blob) return false;
        var out = new Uint8Array(await blob.arrayBuffer());
        if (out.length >= stream.contents.length) return false;

        stream.contents = out;
        d.set(N("Width"), PDFNumber.of(w));
        d.set(N("Height"), PDFNumber.of(h));
        d.set(N("BitsPerComponent"), PDFNumber.of(8));
        d.set(N("Filter"), N("DCTDecode"));
        d.delete(N("DecodeParms"));
        d.set(N("Length"), PDFNumber.of(out.length));
        if (kind === "gray") d.set(N("ColorSpace"), N("DeviceRGB"));
        return true;
      } finally {
        if (bitmap.close) bitmap.close();
        if (canvas) canvas.width = canvas.height = 0;
      }
    }

    async function visitResources(resources) {
      if (!resources) return;
      var xobjects = resources.lookupMaybe(N("XObject"), PDFDict);
      if (!xobjects) return;
      var entries = xobjects.entries();
      for (var i = 0; i < entries.length; i++) {
        var value = entries[i][1];
        if (value instanceof PDFRef) {
          var key = value.toString();
          if (seen.has(key)) continue;
          seen.add(key);
        }
        var stream;
        try { stream = doc.context.lookup(value); } catch (e) { continue; }
        if (!stream || !stream.dict || !(stream.contents instanceof Uint8Array)) continue;

        var subtype = String(stream.dict.lookup(N("Subtype")));
        if (subtype === "/Form") {
          await visitResources(stream.dict.lookupMaybe(N("Resources"), PDFDict));
          continue;
        }
        if (subtype !== "/Image") continue;

        try {
          if (await recompressOne(stream)) stats.processed++; else stats.skipped++;
        } catch (e) {
          console.warn("Skipped one image:", e);
          stats.skipped++;
        }
        ctx.status("image " + (stats.processed + stats.skipped));
        await ctx.tick();
      }
    }

    var pages = doc.getPages();
    for (var p = 0; p < pages.length; p++) {
      var node = pages[p].node;
      var res = null;
      try {
        res = typeof node.Resources === "function" ? node.Resources() : node.lookupMaybe(N("Resources"), PDFDict);
      } catch (e) { res = null; }
      await visitResources(res);
    }
    return stats;
  }

  async function compressRasterize(file, opts, ctx) {
    var pdfjs = window.pdfjsLib;
    var data = new Uint8Array(await file.arrayBuffer());

    var pdf;
    try {
      pdf = await pdfjs.getDocument({ data: data }).promise;
    } catch (e) {
      console.error("pdf.js could not open the file:", e);
      if (e && e.name === "PasswordException") throw new UserError("This PDF needs a password to open.");
      throw new UserError("Couldn\u2019t read this PDF \u2014 it may be damaged.");
    }

    try {
      var outDoc = await window.PDFLib.PDFDocument.create({ updateMetadata: false });
      for (var i = 1; i <= pdf.numPages; i++) {
        ctx.status("page " + i + " of " + pdf.numPages);
        var page = await pdf.getPage(i);
        var canvas = null;
        try {
          var base = page.getViewport({ scale: 1 });
          var unit = page.userUnit || 1;
          var wPt = base.width * unit, hPt = base.height * unit;

          var scale = 2;
          if (opts.maxDim > 0) scale = Math.min(scale, opts.maxDim / Math.max(base.width, base.height));
          var pixels = base.width * base.height * scale * scale;
          if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

          var viewport = page.getViewport({ scale: scale });
          canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          var c2d = canvas.getContext("2d");
          if (!c2d) throw new UserError("Your browser couldn\u2019t allocate a canvas for page " + i + ".");
          c2d.fillStyle = "#ffffff";
          c2d.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: c2d, viewport: viewport, background: "#ffffff" }).promise;

          var blob = await new Promise(function (res) { canvas.toBlob(res, "image/jpeg", opts.quality); });
          if (!blob) throw new UserError("Your browser couldn\u2019t encode page " + i + " (it may be too large).");
          var jpg = await outDoc.embedJpg(new Uint8Array(await blob.arrayBuffer()));

          var outPage = outDoc.addPage([wPt, hPt]);
          outPage.drawImage(jpg, { x: 0, y: 0, width: wPt, height: hPt });
        } finally {
          page.cleanup();
          if (canvas) canvas.width = canvas.height = 0;
        }
        await ctx.tick();
      }

      var blobOut = pdfBlob(await outDoc.save({ useObjectStreams: true }));
      if (blobOut.size >= file.size) {
        return keepOriginal(file, "Rasterizing would have made this larger, so the original was kept.");
      }
      return {
        name: outName(file),
        blob: blobOut,
        note: pdf.numPages + " page" + (pdf.numPages === 1 ? "" : "s") + " rasterized \u2014 text is no longer selectable."
      };
    } finally {
      try { await pdf.destroy(); } catch (e) { }
    }
  }

  C.createApp({
    noun: "PDF",
    accept: function (f) { return f.type === "application/pdf" || /\.pdf$/i.test(f.name); },
    warm: ["pdflib", "jszip"],
    libsFor: function (opts) { return opts.scanned ? ["pdflib", "pdfjs"] : ["pdflib"]; },
    readOptions: readOptions,
    compress: function (file, opts, ctx) {
      return opts.scanned ? compressRasterize(file, opts, ctx) : compressSmart(file, opts, ctx);
    },
    zipName: "steno-pdfs.zip"
  });
})();