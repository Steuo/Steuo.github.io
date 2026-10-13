(function (root) {
  "use strict";

  var RAW_EXT = /\.(dng|cr2|cr3|nef|arw|raf|orf|rw2|pef)$/i;

  function asc(b, from, to) {
    var s = "";
    to = Math.min(to, b.length);
    for (var i = from; i < to; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  var HEIC_BRANDS = { heic: 1, heix: 1, heim: 1, heis: 1, hevc: 1, hevx: 1, hevm: 1, hevs: 1 };

  function sniff(b, name, type) {
    var ext = extOf(name);
    var r = { kind: "unknown", animated: false, icoCount: 0 };
    var n = b.length;
    if (n >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) { r.kind = "jpeg"; return r; }
    if (n >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) { r.kind = "png"; return r; }
    if (n >= 6 && asc(b, 0, 4) === "GIF8") { r.kind = "gif"; return r; }
    if (n >= 12 && asc(b, 0, 4) === "RIFF" && asc(b, 8, 12) === "WEBP") {
      r.kind = "webp";
      if (n >= 21 && asc(b, 12, 16) === "VP8X" && (b[20] & 0x02)) r.animated = true;
      return r;
    }
    if (n >= 2 && b[0] === 0xFF && b[1] === 0x0A) { r.kind = "jxl"; return r; }
    if (n >= 12 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0x0C && asc(b, 4, 8) === "JXL " &&
        b[8] === 0x0D && b[9] === 0x0A && b[10] === 0x87 && b[11] === 0x0A) { r.kind = "jxl"; return r; }
    if (n >= 15 && asc(b, 0, 15) === "FUJIFILMCCD-RAW") { r.kind = "raw"; return r; }
    if (n >= 12 && asc(b, 4, 8) === "ftyp") {
      var size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      var major = asc(b, 8, 12);
      var compat = [];
      var end = Math.min(size, n);
      for (var p = 16; p + 4 <= end; p += 4) compat.push(asc(b, p, p + 4));
      if (major === "crx ") { r.kind = "raw"; return r; }
      if (major === "avif" || major === "avis") { r.kind = "avif"; return r; }
      if (HEIC_BRANDS[major]) { r.kind = "heic"; return r; }
      if (major === "mif1" || major === "msf1") {
        if (compat.indexOf("avif") >= 0 || compat.indexOf("avis") >= 0) { r.kind = "avif"; return r; }
        r.kind = "heic";
        return r;
      }
      for (var k = 0; k < compat.length; k++) {
        if (compat[k] === "avif" || compat[k] === "avis") { r.kind = "avif"; return r; }
        if (HEIC_BRANDS[compat[k]]) { r.kind = "heic"; return r; }
      }
    }
    if (n >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4] | (b[5] << 8)) >= 1) {
      r.kind = "ico";
      r.icoCount = b[4] | (b[5] << 8);
      return r;
    }
    if (n >= 18 && b[0] === 0x42 && b[1] === 0x4D) {
      var dib = (b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24)) >>> 0;
      if (dib === 12 || dib === 40 || dib === 52 || dib === 56 || dib === 64 || dib === 108 || dib === 124) {
        r.kind = "bmp";
        return r;
      }
    }
    if (RAW_EXT.test(name || "")) return { kind: "raw", animated: false, icoCount: 0 };

    var text = asc(b, 0, Math.min(n, 4096)).replace(/\0/g, "");
    if (ext === "svgz") { r.kind = "svgz"; return r; }
    if (n >= 2 && b[0] === 0x1F && b[1] === 0x8B) { r.kind = ext === "svg" ? "svgz" : "unknown"; return r; }
    if (/<svg[\s>\/]/i.test(text) || ext === "svg" || String(type).toLowerCase() === "image/svg+xml") {
      r.kind = "svg";
      return r;
    }
    if (ext === "heic" || ext === "heif") { r.kind = "heic"; return r; }
    if (ext === "jxl") { r.kind = "jxl"; return r; }
    if (ext === "avif") { r.kind = "avif"; return r; }
    return r;
  }

  async function pngIsAnimated(readAt, size) {
    var pos = 8;
    for (var i = 0; i < 128 && pos + 8 <= size; i++) {
      var h = await readAt(pos, 8);
      if (!h || h.length < 8) return false;
      var len = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
      var t = String.fromCharCode(h[4], h[5], h[6], h[7]);
      if (t === "acTL") return true;
      if (t === "IDAT" || t === "IEND") return false;
      pos += 12 + len;
    }
    return false;
  }

  function parseJpeg(b, start) {
    var n = b.length, p = start + 2, sof = 0, w = 0, h = 0, prec = 0, scans = 0;
    for (;;) {
      if (p + 1 >= n || b[p] !== 0xFF) return null;
      while (p + 1 < n && b[p + 1] === 0xFF) p++;
      if (p + 1 >= n) return null;
      var m = b[p + 1];
      p += 2;
      if (m === 0xD9) {
        if (!sof || !scans || !w || !h) return null;
        return { end: p, sof: sof, w: w, h: h, prec: prec };
      }
      if (m === 0x01) continue;
      if (m === 0x00 || (m >= 0xD0 && m <= 0xD8)) return null;
      if (p + 2 > n) return null;
      var len = (b[p] << 8) | b[p + 1];
      if (len < 2 || p + len > n) return null;
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        if (len < 8) return null;
        if (!sof) {
          sof = m;
          prec = b[p + 2];
          h = (b[p + 3] << 8) | b[p + 4];
          w = (b[p + 5] << 8) | b[p + 6];
        }
      }
      if (m === 0xDA) {
        if (!sof) return null;
        scans++;
        p += len;
        for (;;) {
          var q = b.indexOf(0xFF, p);
          if (q < 0 || q + 1 >= n) return null;
          var nb = b[q + 1];
          if (nb === 0x00 || (nb >= 0xD0 && nb <= 0xD7)) { p = q + 2; continue; }
          if (nb === 0xFF) { p = q + 1; continue; }
          p = q;
          break;
        }
        continue;
      }
      p += len;
    }
  }

  function decodable(j) {
    return (j.sof === 0xC0 || j.sof === 0xC1 || j.sof === 0xC2) && j.prec === 8;
  }

  function findJpegs(b) {
    var n = b.length, out = [], i = 0;
    while (i < n - 3) {
      i = b.indexOf(0xFF, i);
      if (i < 0 || i > n - 4) break;
      if (b[i + 1] === 0xD8 && b[i + 2] === 0xFF) {
        var info = parseJpeg(b, i);
        if (info) {
          out.push({ start: i, end: info.end, w: info.w, h: info.h, sof: info.sof, prec: info.prec });
          i = info.end;
          continue;
        }
      }
      i++;
    }
    return out;
  }

  function tiffOrientation(b, base) {
    var n = b.length;
    if (base < 0 || base + 8 > n) return 0;
    var bo = b[base];
    if (bo !== b[base + 1] || (bo !== 0x49 && bo !== 0x4D)) return 0;
    var le = bo === 0x49;
    function u16(p) { return le ? (b[p] | (b[p + 1] << 8)) : ((b[p] << 8) | b[p + 1]); }
    function u32(p) {
      return (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24))
                 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3])) >>> 0;
    }
    var magic = u16(base + 2);
    if (magic !== 0x2A && magic !== 0x55 && magic !== 0x4F52 && magic !== 0x5352) return 0;
    var ifd = base + u32(base + 4);
    if (ifd + 2 > n) return 0;
    var cnt = u16(ifd);
    if (cnt > 1000) return 0;
    for (var k = 0; k < cnt; k++) {
      var e = ifd + 2 + 12 * k;
      if (e + 12 > n) break;
      if (u16(e) === 0x0112) {
        var v = u16(e + 2) === 3 ? u16(e + 8) : 0;
        return v >= 1 && v <= 8 ? v : 0;
      }
    }
    return 0;
  }

  function jpegOrientation(b, start, end) {
    var p = start + 2;
    while (p + 4 <= end && b[p] === 0xFF) {
      var m = b[p + 1];
      if (m === 0xDA || m === 0xD9) break;
      var len = (b[p + 2] << 8) | b[p + 3];
      if (len < 2) break;
      if (m === 0xE1 && asc(b, p + 4, p + 10) === "Exif\0\0") {
        return tiffOrientation(b.subarray(0, Math.min(end, p + 2 + len)), p + 10);
      }
      p += 2 + len;
    }
    return 0;
  }

  function containerOrientation(b) {
    var n = b.length;
    if (n > 8 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4D && b[1] === 0x4D))) {
      var o = tiffOrientation(b, 0);
      if (o) return o;
    }
    var limit = Math.min(n - 8, 16 * 1024 * 1024), i = 0;
    while (i < limit) {
      i = b.indexOf(0x43, i);
      if (i < 0 || i >= limit) break;
      if (b[i + 1] === 0x4D && b[i + 2] === 0x54 && b[i + 3] === 0x31) {
        var t = tiffOrientation(b, i + 4);
        if (t) return t;
      }
      i++;
    }
    return 0;
  }

  function extractRawPreviews(b) {
    var cands = findJpegs(b).filter(decodable);
    cands.sort(function (x, y) {
      var d = y.w * y.h - x.w * x.h;
      return d !== 0 ? d : (y.end - y.start) - (x.end - x.start);
    });
    return { candidates: cands, orient: containerOrientation(b) };
  }

  function orientMatrix(o, cw, ch) {
    switch (o) {
      case 2: return [-1, 0, 0, 1, cw, 0];
      case 3: return [-1, 0, 0, -1, cw, ch];
      case 4: return [1, 0, 0, -1, 0, ch];
      case 5: return [0, 1, 1, 0, 0, 0];
      case 6: return [0, 1, -1, 0, cw, 0];
      case 7: return [0, -1, -1, 0, cw, ch];
      case 8: return [0, -1, 1, 0, 0, ch];
      default: return [1, 0, 0, 1, 0, 0];
    }
  }

  function scanTag(s, lt) {
    var q = "";
    for (var j = lt + 1; j < s.length; j++) {
      var c = s.charAt(j);
      if (q) { if (c === q) q = ""; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ">") return j + 1;
    }
    return -1;
  }

  function scanDoctype(s, lt) {
    var depth = 0;
    for (var j = lt + 2; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === '"' || c === "'") {
        var e = s.indexOf(c, j + 1);
        if (e < 0) return -1;
        j = e;
      } else if (c === "<" && s.substr(j, 4) === "<!--") {
        var ce = s.indexOf("-->", j + 4);
        if (ce < 0) return -1;
        j = ce + 2;
      } else if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ">" && depth <= 0) return j + 1;
    }
    return -1;
  }

  function tokenizeXml(s) {
    var toks = [], i = 0, n = s.length;
    while (i < n) {
      var lt = s.indexOf("<", i);
      if (lt < 0) { toks.push({ t: "text", s: s.slice(i) }); break; }
      if (lt > i) toks.push({ t: "text", s: s.slice(i, lt) });
      var end, type;
      if (s.substr(lt, 4) === "<!--") {
        end = s.indexOf("-->", lt + 4);
        if (end < 0) return null;
        end += 3; type = "comment";
      } else if (s.substr(lt, 9) === "<![CDATA[") {
        end = s.indexOf("]]>", lt + 9);
        if (end < 0) return null;
        end += 3; type = "cdata";
      } else if (s.substr(lt, 2) === "<?") {
        end = s.indexOf("?>", lt + 2);
        if (end < 0) return null;
        end += 2; type = "pi";
      } else if (s.substr(lt, 2) === "<!") {
        end = scanDoctype(s, lt);
        if (end < 0) return null;
        type = "doctype";
      } else {
        end = scanTag(s, lt);
        if (end < 0) return null;
        var raw = s.slice(lt, end);
        type = raw.charAt(1) === "/" ? "end" : (raw.slice(-2) === "/>" ? "empty" : "start");
      }
      toks.push({ t: type, s: s.slice(lt, end) });
      i = end;
    }
    return toks;
  }

  var ATTR_RE = /([^\s=\/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'))?/g;

  function parseTag(raw, type) {
    var m = /^<\/?\s*([^\s\/>]+)/.exec(raw);
    if (!m) return null;
    var name = m[1];
    var tag = { name: name, attrs: [], type: type };
    if (type === "end") return tag;
    var from = m[0].length;
    var to = raw.length - (type === "empty" ? 2 : 1);
    var rest = raw.slice(from, to);
    var a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(rest))) tag.attrs.push({ name: a[1], val: a[2] === undefined ? null : a[2] });
    return tag;
  }

  function serializeTag(tag) {
    if (tag.type === "end") return "</" + tag.name + ">";
    var s = "<" + tag.name;
    for (var i = 0; i < tag.attrs.length; i++) {
      s += " " + tag.attrs[i].name + (tag.attrs[i].val !== null ? "=" + tag.attrs[i].val : "");
    }
    return s + (tag.type === "empty" ? "/>" : ">");
  }

  function prefixOf(name) {
    var i = name.indexOf(":");
    return i > 0 ? name.slice(0, i) : "";
  }
  function localOf(name) {
    var i = name.indexOf(":");
    return i > 0 ? name.slice(i + 1) : name;
  }
  function unq(v) { return v === null ? "" : v.slice(1, -1); }

  var DROP_ELEMENT_PREFIX = { inkscape: 1, sodipodi: 1, sketch: 1 };
  var DROP_ATTR_PREFIX = { inkscape: 1, sodipodi: 1, sketch: 1 };
  var KEEP_WS_LOCAL = { text: 1, style: 1, script: 1, foreignObject: 1, title: 1, desc: 1, pre: 1 };

  function minifySvg(text) {
    var toks = tokenizeXml(text);
    if (!toks) return null;
    var hasEntity = false;
    toks.forEach(function (t) { if (t.t === "doctype" && /<!ENTITY/i.test(t.s)) hasEntity = true; });

    var out = [], stack = [], skip = 0;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (skip > 0) {
        if (t.t === "start") skip++;
        else if (t.t === "end") skip--;
        continue;
      }
      var top = stack.length ? stack[stack.length - 1] : false;
      if (t.t === "comment") {
        if (t.s.substr(0, 5) === "<!--!") out.push(t);
      } else if (t.t === "pi") {
        if (!/^<\?xml\s/i.test(t.s)) out.push(t);
      } else if (t.t === "doctype") {
        if (hasEntity) out.push(t);
      } else if (t.t === "cdata") {
        out.push(t);
      } else if (t.t === "text") {
        if (top || /\S/.test(t.s)) out.push(t);
      } else {
        var tag = parseTag(t.s, t.t);
        if (!tag) return null;
        var pre = prefixOf(tag.name), loc = localOf(tag.name);
        if (t.t !== "end") {
          if (DROP_ELEMENT_PREFIX[pre] || (loc === "metadata" && (pre === "" || pre === "svg"))) {
            if (t.t === "start") skip = 1;
            continue;
          }
          tag.attrs = tag.attrs.filter(function (a) { return !DROP_ATTR_PREFIX[prefixOf(a.name)]; });
        }
        if (t.t === "start") {
          var keep = !!top || !!KEEP_WS_LOCAL[loc];
          for (var k = 0; k < tag.attrs.length; k++) {
            if (tag.attrs[k].name === "xml:space") keep = unq(tag.attrs[k].val) === "preserve";
          }
          stack.push(keep);
        } else if (t.t === "end") {
          stack.pop();
        }
        out.push({ t: t.t, tag: tag });
      }
    }

    var body = out.map(function (o) {
      if (!o.tag) return o.s;
      var c = { name: o.tag.name, type: o.tag.type, attrs: o.tag.attrs.filter(function (a) { return a.name.substr(0, 6) !== "xmlns:"; }) };
      return serializeTag(c);
    }).join("");
    out.forEach(function (o) {
      if (!o.tag || o.tag.type === "end") return;
      o.tag.attrs = o.tag.attrs.filter(function (a) {
        if (a.name.substr(0, 6) !== "xmlns:") return true;
        var p = a.name.slice(6);
        if (p === "xml") return true;
        return body.indexOf(p + ":") >= 0;
      });
    });

    var s = out.map(function (o) { return o.tag ? serializeTag(o.tag) : o.s; }).join("");
    return s.replace(/^\s+|\s+$/g, "");
  }

  function parseLen(v) {
    if (v === null || v === undefined) return null;
    var m = /^\s*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)\s*(px|pt|pc|in|cm|mm|em|ex|%)?\s*$/.exec(v);
    if (!m) return null;
    var x = parseFloat(m[1]);
    switch ((m[2] || "px").toLowerCase()) {
      case "px": return x;
      case "pt": return x * 96 / 72;
      case "pc": return x * 16;
      case "in": return x * 96;
      case "cm": return x * 96 / 2.54;
      case "mm": return x * 96 / 25.4;
      case "em": return x * 16;
      case "ex": return x * 8;
      default: return null;
    }
  }

  function svgRootToken(toks) {
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.t === "start" || t.t === "empty") {
        var tag = parseTag(t.s, t.t);
        if (tag && localOf(tag.name) === "svg") return { index: i, tag: tag };
        return null;
      }
    }
    return null;
  }

  function svgRootInfo(text) {
    var toks = tokenizeXml(text);
    if (!toks) return null;
    var r = svgRootToken(toks);
    if (!r) return null;
    var info = { width: null, height: null, viewBox: null };
    r.tag.attrs.forEach(function (a) {
      if (a.name === "width") info.width = parseLen(unq(a.val));
      else if (a.name === "height") info.height = parseLen(unq(a.val));
      else if (a.name === "viewBox") {
        var p = unq(a.val).trim().split(/[\s,]+/).map(parseFloat);
        if (p.length === 4 && p.every(isFinite) && p[2] > 0 && p[3] > 0) info.viewBox = { w: p[2], h: p[3] };
      }
    });
    return info;
  }

  function svgIntrinsic(info) {
    var w = info.width > 0 ? info.width : null, h = info.height > 0 ? info.height : null, vb = info.viewBox;
    var r;
    if (w && h) r = { w: w, h: h, guessed: false };
    else if (vb) {
      var ar = vb.w / vb.h;
      if (w) r = { w: w, h: w / ar, guessed: false };
      else if (h) r = { w: h * ar, h: h, guessed: false };
      else r = { w: vb.w, h: vb.h, guessed: false };
    } else r = { w: w || 300, h: h || 150, guessed: !w && !h };
    r.w = Math.max(1, Math.round(r.w));
    r.h = Math.max(1, Math.round(r.h));
    return r;
  }

  function svgWithSize(text, w, h, fallbackViewBox) {
    var toks = tokenizeXml(text);
    if (!toks) return null;
    var r = svgRootToken(toks);
    if (!r) return null;
    var tag = r.tag, hasW = false, hasH = false, hasVB = false;
    var vbVal = fallbackViewBox ? '"0 0 ' + fallbackViewBox.w + " " + fallbackViewBox.h + '"' : null;
    tag.attrs.forEach(function (a) {
      if (a.name === "width") { a.val = '"' + w + '"'; hasW = true; }
      else if (a.name === "height") { a.val = '"' + h + '"'; hasH = true; }
      else if (a.name === "viewBox") {
        hasVB = true;
        if (vbVal) a.val = vbVal;
      }
    });
    if (!hasW) tag.attrs.push({ name: "width", val: '"' + w + '"' });
    if (!hasH) tag.attrs.push({ name: "height", val: '"' + h + '"' });
    if (!hasVB && vbVal) tag.attrs.push({ name: "viewBox", val: vbVal });
    toks[r.index] = { t: tag.type, s: serializeTag(tag) };
    return toks.map(function (t) { return t.s; }).join("");
  }

  function buildIco(png, w, h) {
    var out = new Uint8Array(22 + png.length);
    var dv = new DataView(out.buffer);
    dv.setUint16(0, 0, true);
    dv.setUint16(2, 1, true);
    dv.setUint16(4, 1, true);
    out[6] = w >= 256 ? 0 : w;
    out[7] = h >= 256 ? 0 : h;
    out[8] = 0;
    out[9] = 0;
    dv.setUint16(10, 1, true);
    dv.setUint16(12, 32, true);
    dv.setUint32(14, png.length, true);
    dv.setUint32(18, 22, true);
    out.set(png, 22);
    return out;
  }

  var api = {
    RAW_EXT: RAW_EXT,
    sniff: sniff,
    pngIsAnimated: pngIsAnimated,
    findJpegs: findJpegs,
    jpegOrientation: jpegOrientation,
    containerOrientation: containerOrientation,
    extractRawPreviews: extractRawPreviews,
    orientMatrix: orientMatrix,
    minifySvg: minifySvg,
    svgRootInfo: svgRootInfo,
    svgIntrinsic: svgIntrinsic,
    svgWithSize: svgWithSize,
    buildIco: buildIco
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StenoFormats = api;
})(typeof window !== "undefined" ? window : this);
