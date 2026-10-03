(function (global) {
  "use strict";

  class UserError extends Error {
    constructor(message) {
      super(message);
      this.name = "UserError";
    }
  }

  class Cancelled extends Error {
    constructor() {
      super("Cancelled");
      this.name = "Cancelled";
    }
  }

  function fmtBytes(n) {
    if (!isFinite(n) || n < 0) n = 0;
    if (n < 1024) return Math.round(n) + " B";
    var kb = n / 1024;
    if (kb < 1023.5) return kb.toFixed(kb < 10 ? 1 : 0) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function savedPct(before, after) {
    if (!before) return 0;
    var s = Math.round((1 - after / before) * 100) || 0;
    if (s >= 100 && after > 0) s = 99;
    return s;
  }

  function pctLabel(saved) {
    if (saved > 0) return "\u2212" + saved + "%";
    if (saved < 0) return "+" + Math.abs(saved) + "%";
    return "0%";
  }

  function uniqueName(used, name) {
    var dot = name.lastIndexOf(".");
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : "";
    var candidate = name;
    var i = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = stem + " (" + i + ")" + ext;
      i++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function tick() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  var ALLOW_CDN = true;
  var BASE = (function () {
    var el = document.currentScript;
    var src = el && el.getAttribute("src");
    var m = src && /^(.*?)js\/common\.js(?:[?#].*)?$/.exec(src);
    return m ? m[1] : "";
  })();
  var LIBS = {
    jszip: {
      label: "ZIP",
      global: "JSZip",
      urls: [
        BASE + "vendor/jszip.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
        "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
      ]
    },
    heic2any: {
      label: "HEIC decoding",
      global: "heic2any",
      urls: [
        BASE + "vendor/heic2any.min.js",
        "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js",
        "https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js"
      ]
    },
    pdflib: {
      label: "PDF editing",
      global: "PDFLib",
      urls: [
        BASE + "vendor/pdf-lib.min.js",
        "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
        "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"
      ]
    },
    pdfjs: {
      label: "PDF rendering",
      global: "pdfjsLib",
      urls: [
        BASE + "vendor/pdf.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"
      ],
      onLoaded: function (url) {
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = url.replace(/pdf\.min\.js$/, "pdf.worker.min.js");
      }
    }
  };
  var pending = {};
  var warming = {};

  function isRemote(url) { return /^https?:/i.test(url); }

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      var done = false;
      var timer = setTimeout(function () { finish(false); }, 20000);
      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (ok) resolve(url);
        else { s.remove(); reject(new Error("Could not load " + url)); }
      }
      s.src = url;
      s.async = true;
      if (isRemote(url)) {
        s.crossOrigin = "anonymous";
        s.referrerPolicy = "no-referrer";
      }
      s.onload = function () { finish(true); };
      s.onerror = function () { finish(false); };
      document.head.appendChild(s);
    });
  }

  async function tryUrls(lib, urls) {
    for (var i = 0; i < urls.length; i++) {
      try { await loadScript(urls[i]); } catch (e) { continue; }
      if (global[lib.global]) {
        if (lib.onLoaded) lib.onLoaded(urls[i]);
        return true;
      }
    }
    return false;
  }

  function warmLocal(names) {
    (names || []).forEach(function (name) {
      var lib = LIBS[name];
      if (!lib || global[lib.global] || warming[name] || pending[name]) return;
      var local = lib.urls.filter(function (u) { return !isRemote(u); });
      warming[name] = tryUrls(lib, local).catch(function () { return false; });
    });
  }

  function loadLib(name) {
    var lib = LIBS[name];
    if (!lib) return Promise.reject(new Error("Unknown library: " + name));
    if (pending[name]) return pending[name];
    var p = (async function () {
      var warmedLocal = warming[name] ? await warming[name] : null;
      if (global[lib.global]) return;
      var urls = ALLOW_CDN ? lib.urls : lib.urls.filter(function (u) { return !isRemote(u); });
      if (warmedLocal === false) urls = urls.filter(isRemote);
      if (!(await tryUrls(lib, urls))) {
        throw new UserError(
          "Couldn\u2019t load the " + lib.label + " library. " +
          (ALLOW_CDN ? "Check your connection, or run" : "Run") +
          " tools/vendor.sh to bundle it with the site."
        );
      }
    })();
    pending[name] = p;
    p.catch(function () { delete pending[name]; });
    return p;
  }

  function requireLibs(names) {
    return Promise.all((names || []).map(loadLib)).then(function () {});
  }

  function dimsText(d) {
    var a = d.from[0] + "\u00d7" + d.from[1];
    var b = d.to[0] + "\u00d7" + d.to[1];
    return (a === b ? a : a + " \u2192 " + b) + " px";
  }

  function createApp(cfg) {
    var $ = function (id) { return document.getElementById(id); };
    var stage = $("stage"), emptyState = $("emptyState"), toolPanel = $("toolPanel");
    var fileInput = $("fileInput"), resetBtn = $("resetBtn"), compressBtn = $("compressBtn");
    var downloadAllBtn = $("downloadAllBtn"), panel = $("panel"), panelEmpty = $("panelEmpty");
    var previewGrid = $("previewGrid");
    var advancedToggle = $("advancedToggle"), advancedFields = $("advancedFields");
    var queueInfo = $("queueInfo"), queueNote = $("queueNote"), addMoreBtn = $("addMoreBtn");
    var hint = emptyState.querySelector(".hint");
    var defaultHint = hint.textContent;

    var liveInputs = cfg.liveInputs || [];
    var live = !!(previewGrid && liveInputs.length);
    var liveTotalEl = $("liveTotal");
    var auto = live && !compressBtn;
    var zipping = false;

    var queue = [];
    var cards = [];
    var ranOnce = false;
    var results = [];
    var urls = [];
    var busy = false;
    var noteTimer = null;

    var liveDirty = false;
    var liveRunning = false;
    var liveTimer = null;
    var liveIdle = Promise.resolve();
    var LIVE_THROTTLE = 90;
    var LIVE_DEBOUNCE = 400;

    stage.classList.add("is-empty");

    function notify(msg) {
      clearTimeout(noteTimer);
      if (toolPanel.hidden) {
        hint.textContent = msg;
        noteTimer = setTimeout(function () { hint.textContent = defaultHint; }, 3500);
      } else {
        queueNote.textContent = msg;
        noteTimer = setTimeout(function () { queueNote.textContent = ""; }, 5000);
      }
    }

    function fileKey(f) { return [f.name, f.size, f.lastModified].join("|"); }

    function updateQueueUI() {
      var total = queue.reduce(function (s, f) { return s + f.size; }, 0);
      queueInfo.textContent = queue.length === 1
        ? queue[0].name + " \u00b7 " + fmtBytes(total)
        : queue.length + " files \u00b7 " + fmtBytes(total);
      if (compressBtn) compressBtn.textContent = queue.length > 1 ? "Compress " + queue.length + " files" : "Compress";
      if (cfg.onQueue) cfg.onQueue(queue.slice());
    }

    function addFiles(fileList) {
      var incoming = Array.prototype.slice.call(fileList || []);
      if (!incoming.length) return;
      if (busy) { notify("Please wait until the current run finishes."); return; }

      var have = new Set(queue.map(fileKey));
      var rejected = 0, dupes = 0, added = 0, parts = [];
      incoming.forEach(function (f) {
        if (!cfg.accept(f)) { rejected++; return; }
        var k = fileKey(f);
        if (have.has(k)) { dupes++; return; }
        have.add(k);
        queue.push(f);
        if (previewGrid) addCard(f);
        added++;
      });

      if (added > 0) {
        if (results.length || ranOnce || (panel && panel.querySelector(".file-row"))) {
          clearResults();
          parts.push("previous results cleared");
        }
        emptyState.hidden = true;
        toolPanel.hidden = false;
        stage.classList.remove("is-empty");
        updateQueueUI();
        if (previewGrid) updateLayoutMode();
        if (live) scheduleLive(0);
      }
      if (rejected) parts.push(rejected + " skipped (not " + (cfg.noun === "PDF" ? "a PDF" : "an image") + ")");
      if (dupes) parts.push(dupes + " already added");
      if (parts.length) notify(parts.join(" \u00b7 "));
      else if (added > 0) { queueNote.textContent = ""; }
    }

    function clearResults() {
      urls.forEach(function (u) { URL.revokeObjectURL(u); });
      urls = [];
      results = [];
      ranOnce = false;
      cards.forEach(function (c) {
        if (!c.finalUrl) return;
        c.finalUrl = "";
        c.finalName = "";
        c.el.classList.remove("is-done");
        renderCardResult(c);
      });
      if (panel) Array.prototype.slice.call(panel.querySelectorAll(".file-row, .summary-row")).forEach(function (n) { n.remove(); });
      downloadAllBtn.hidden = true;
      setEmptyHint(true);
    }

    function setEmptyHint(show) { if (panelEmpty) panelEmpty.style.display = show ? "" : "none"; }

    var resizeObserver = window.ResizeObserver
      ? new ResizeObserver(function (entries) {
          entries.forEach(function (en) {
            for (var i = 0; i < cards.length; i++) {
              if (cards[i].thumb === en.target) { layoutCard(cards[i]); break; }
            }
          });
        })
      : null;
    if (!resizeObserver) window.addEventListener("resize", function () { cards.forEach(layoutCard); });

    function addCard(file) {
      var el = document.createElement("div");
      el.className = "card";
      el.innerHTML =
        '<div class="thumb">' +
          '<div class="cmp" role="slider" tabindex="-1" aria-hidden="true" ' +
            'aria-label="Compare original and compressed (plus and minus keys zoom)" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">' +
            '<div class="viewport">' +
              '<div class="layer"><img class="img-after" alt="" draggable="false"></div>' +
              '<div class="clip-before"><div class="layer"><img class="img-before" alt="" draggable="false"></div></div>' +
            "</div>" +
            '<span class="cmp-line" aria-hidden="true"><span class="cmp-knob"></span></span>' +
          "</div>" +
          '<span class="thumb-tag tag-before">Original</span>' +
          '<span class="thumb-tag tag-after is-result">Compressed</span>' +
          '<span class="thumb-busy">Updating\u2026</span>' +
          '<span class="thumb-none">No preview</span>' +
          '<button class="expand-btn" type="button" aria-label="Enlarge preview" title="Enlarge preview">' +
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>' +
          "</button>" +
          '<div class="zoom-ctl">' +
            '<button class="zoom-btn zoom-level" type="button" title="Reset zoom" aria-label="Reset zoom">1\u00d7</button>' +
            '<button class="zoom-btn zoom-out" type="button" title="Zoom out" aria-label="Zoom out">\u2212</button>' +
            '<button class="zoom-btn zoom-in" type="button" title="Zoom in" aria-label="Zoom in">+</button>' +
          "</div>" +
        "</div>" +
        '<div class="card-body">' +
          '<div class="file-name">' + escapeHtml(file.name) + "</div>" +
          '<div class="card-result"></div>' +
        "</div>";
      var card = {
        file: file,
        el: el,
        thumb: el.querySelector(".thumb"),
        cmp: el.querySelector(".cmp"),
        imgBefore: el.querySelector(".img-before"),
        imgAfter: el.querySelector(".img-after"),
        tagAfter: el.querySelector(".tag-after"),
        expandBtn: el.querySelector(".expand-btn"),
        zoomLevel: el.querySelector(".zoom-level"),
        zoomOutBtn: el.querySelector(".zoom-out"),
        zoomInBtn: el.querySelector(".zoom-in"),
        result: el.querySelector(".card-result"),
        thumbUrl: URL.createObjectURL(file),
        liveUrl: "",
        beforeUrl: "",
        beforeBlob: null,
        out: null,
        err: "",
        sig: "",
        finalUrl: "",
        finalName: "",
        pos: 50,
        ar: 0,
        zoom: 1,
        zx: 0,
        zy: 0,
        dead: false
      };

      card.imgBefore.addEventListener("error", function () { el.classList.add("no-preview"); });
      card.imgBefore.addEventListener("load", function () {
        el.classList.remove("no-preview");
        if (card.imgBefore.naturalWidth && card.imgBefore.naturalHeight) {
          card.ar = card.imgBefore.naturalWidth / card.imgBefore.naturalHeight;
        }
        layoutCard(card);
      });
      card.imgAfter.addEventListener("load", function () { setLiveVisible(card, true); });
      card.imgAfter.addEventListener("error", function () { setLiveVisible(card, false); });

      bindInteractions(card);
      card.expandBtn.addEventListener("click", function () {
        var large = el.classList.toggle("is-large");
        card.expandBtn.title = large ? "Shrink preview" : "Enlarge preview";
        card.expandBtn.setAttribute("aria-label", card.expandBtn.title);
        if (large) el.scrollIntoView({ block: "nearest" });
      });

      card.imgBefore.src = card.thumbUrl;
      previewGrid.appendChild(el);
      cards.push(card);
      if (resizeObserver) resizeObserver.observe(card.thumb);
      setPos(card, 50);
      applyView(card);
      renderCardResult(card);
    }

    function layoutCard(card) {
      var W = card.thumb.clientWidth, H = card.thumb.clientHeight, s = card.cmp.style;
      if (!card.ar || !W || !H) {
        s.left = "0"; s.top = "0"; s.width = "100%"; s.height = "100%";
        applyView(card);
        return;
      }
      var w = W, h = W / card.ar;
      if (h > H) { h = H; w = H * card.ar; }
      s.left = (W - w) / 2 + "px";
      s.top = (H - h) / 2 + "px";
      s.width = w + "px";
      s.height = h + "px";
      applyView(card);
    }

    function setPos(card, p) {
      p = Math.min(100, Math.max(0, p));
      card.pos = p;
      card.cmp.style.setProperty("--pos", p + "%");
      card.cmp.setAttribute("aria-valuenow", String(Math.round(p)));
      card.cmp.setAttribute("aria-valuetext", Math.round(p) + "% original, " + Math.round(100 - p) + "% compressed");
    }

    function setLiveVisible(card, on) {
      card.el.classList.toggle("has-live", on);
      card.cmp.tabIndex = on ? 0 : -1;
      card.cmp.setAttribute("aria-hidden", on ? "false" : "true");
    }

    var MAX_ZOOM = 16;

    function applyView(card) {
      var s = card.zoom;
      var lo = 1 - s;
      card.zx = Math.min(0, Math.max(lo, card.zx));
      card.zy = Math.min(0, Math.max(lo, card.zy));
      var st = card.cmp.style;
      st.setProperty("--zs", String(s));
      st.setProperty("--zx", card.zx * card.cmp.clientWidth + "px");
      st.setProperty("--zy", card.zy * card.cmp.clientHeight + "px");
      var zoomed = s > 1.001;
      card.el.classList.toggle("is-zoomed", zoomed);
      card.zoomLevel.textContent = (Math.round(s * 10) / 10) + "\u00d7";
      card.zoomOutBtn.disabled = !zoomed;
      card.zoomInBtn.disabled = s >= MAX_ZOOM - 0.001;
    }

    function zoomTo(card, s2, px, py) {
      var W = card.cmp.clientWidth, H = card.cmp.clientHeight;
      if (!W || !H) return;
      s2 = Math.min(MAX_ZOOM, Math.max(1, s2));
      if (s2 < 1.001) s2 = 1;
      var s1 = card.zoom;
      var cx = (px - card.zx * W) / s1;
      var cy = (py - card.zy * H) / s1;
      card.zoom = s2;
      card.zx = (px - cx * s2) / W;
      card.zy = (py - cy * s2) / H;
      applyView(card);
    }

    function zoomBy(card, factor) {
      zoomTo(card, card.zoom * factor, card.cmp.clientWidth / 2, card.cmp.clientHeight / 2);
    }

    function bindInteractions(card) {
      var thumb = card.thumb;
      var pointers = new Map();
      var mode = null;
      var moved = false;
      var last = null;
      var pinch = null;
      var gestureStart = null;

      function rect() { return card.cmp.getBoundingClientRect(); }
      function posFrom(e) {
        var r = rect();
        return r.width ? ((e.clientX - r.left) / r.width) * 100 : 50;
      }
      function localPoint(e) {
        var r = rect();
        return {
          x: Math.min(r.width, Math.max(0, e.clientX - r.left)),
          y: Math.min(r.height, Math.max(0, e.clientY - r.top))
        };
      }
      function nearDivider(e) {
        var r = rect();
        return Math.abs(e.clientX - (r.left + (card.pos / 100) * r.width)) <= 18;
      }
      function onControls(e) { return !!(e.target.closest && e.target.closest(".expand-btn, .zoom-ctl")); }
      function noPicture() { return card.el.classList.contains("no-preview"); }
      function isLive() { return card.el.classList.contains("has-live"); }
      function twoPoints() {
        var it = pointers.values();
        return [it.next().value, it.next().value];
      }

      function startPinch() {
        var p = twoPoints(), r = rect();
        var mx = (p[0].x + p[1].x) / 2 - r.left, my = (p[0].y + p[1].y) / 2 - r.top;
        pinch = {
          d0: Math.max(1, Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)),
          s0: card.zoom,
          cx: (mx - card.zx * r.width) / card.zoom,
          cy: (my - card.zy * r.height) / card.zoom
        };
        mode = "pinch";
        moved = true;
        thumb.classList.remove("is-panning");
      }
      function updatePinch() {
        var p = twoPoints(), r = rect();
        if (!pinch || !p[0] || !p[1] || !r.width || !r.height) return;
        var mx = (p[0].x + p[1].x) / 2 - r.left, my = (p[0].y + p[1].y) / 2 - r.top;
        var d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        var s2 = Math.min(MAX_ZOOM, Math.max(1, pinch.s0 * d / pinch.d0));
        if (s2 < 1.001) s2 = 1;
        card.zoom = s2;
        card.zx = (mx - pinch.cx * s2) / r.width;
        card.zy = (my - pinch.cy * s2) / r.height;
        applyView(card);
      }

      thumb.addEventListener("pointerdown", function (e) {
        if (onControls(e) || noPicture()) return;
        if (e.pointerType === "mouse") {
          if (e.button !== 0) return;
          pointers.clear();
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { thumb.setPointerCapture(e.pointerId); } catch (err) { }
        if (pointers.size === 2) { startPinch(); return; }
        if (pointers.size > 2) return;
        moved = false;
        if (card.zoom > 1.001 && !(isLive() && nearDivider(e))) {
          mode = "pan";
          last = { x: e.clientX, y: e.clientY };
          thumb.classList.add("is-panning");
        } else if (isLive()) {
          mode = "divider";
          if (e.pointerType !== "touch") {
            setPos(card, posFrom(e));
            try { card.cmp.focus({ preventScroll: true }); } catch (err) { }
          }
        } else {
          mode = null;
        }
      });

      thumb.addEventListener("pointermove", function (e) {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (mode === "pinch") { updatePinch(); return; }
        if (mode === "pan") {
          var r = rect();
          if (r.width && r.height) {
            card.zx += (e.clientX - last.x) / r.width;
            card.zy += (e.clientY - last.y) / r.height;
            applyView(card);
          }
          last = { x: e.clientX, y: e.clientY };
          moved = true;
        } else if (mode === "divider") {
          moved = true;
          setPos(card, posFrom(e));
        }
      });

      function release(e) {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        try { thumb.releasePointerCapture(e.pointerId); } catch (err) { }
        if (mode === "pinch") {
          if (pointers.size >= 2) return;
          pinch = null;
          var rest = pointers.values().next().value;
          if (rest && card.zoom > 1.001) {
            mode = "pan";
            last = { x: rest.x, y: rest.y };
            thumb.classList.add("is-panning");
            return;
          }
          mode = null;
          return;
        }
        if (e.type === "pointerup" && mode === "divider" && e.pointerType === "touch" && !moved) {
          setPos(card, posFrom(e));
        }
        if (!pointers.size) {
          mode = null;
          thumb.classList.remove("is-panning");
        }
      }
      thumb.addEventListener("pointerup", release);
      thumb.addEventListener("pointercancel", release);

      thumb.addEventListener("wheel", function (e) {
        if (noPicture()) return;
        var big = previewGrid.classList.contains("is-single") || card.el.classList.contains("is-large");
        var pinching = e.ctrlKey || e.metaKey;
        if (!pinching && !big && card.zoom <= 1.001) return;
        var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
        var factor = Math.exp(-dy * (pinching ? 0.006 : 0.0018));
        if (!pinching && card.zoom <= 1.001 && factor < 1) return;
        e.preventDefault();
        var p = localPoint(e);
        zoomTo(card, card.zoom * factor, p.x, p.y);
      }, { passive: false });

      thumb.addEventListener("dblclick", function (e) {
        if (onControls(e) || noPicture()) return;
        var p = localPoint(e);
        zoomTo(card, card.zoom > 1.001 ? 1 : 3, p.x, p.y);
      });

      thumb.addEventListener("gesturestart", function (e) {
        if (pointers.size || noPicture()) { gestureStart = null; return; }
        e.preventDefault();
        gestureStart = card.zoom;
      });
      thumb.addEventListener("gesturechange", function (e) {
        if (gestureStart === null) return;
        e.preventDefault();
        var p = localPoint(e);
        zoomTo(card, gestureStart * e.scale, p.x, p.y);
      });
      thumb.addEventListener("gestureend", function () { gestureStart = null; });

      card.zoomInBtn.addEventListener("click", function () { zoomBy(card, 1.5); });
      card.zoomOutBtn.addEventListener("click", function () { zoomBy(card, 1 / 1.5); });
      card.zoomLevel.addEventListener("click", function () {
        zoomTo(card, 1, card.cmp.clientWidth / 2, card.cmp.clientHeight / 2);
      });

      card.cmp.addEventListener("keydown", function (e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(card, 1.5); return; }
        if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(card, 1 / 1.5); return; }
        if (e.key === "0") {
          e.preventDefault();
          zoomTo(card, 1, card.cmp.clientWidth / 2, card.cmp.clientHeight / 2);
          return;
        }
        var step = e.shiftKey ? 1 : 5, p = card.pos;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") p -= step;
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") p += step;
        else if (e.key === "Home") p = 0;
        else if (e.key === "End") p = 100;
        else return;
        e.preventDefault();
        setPos(card, p);
      });
    }

    function updateLayoutMode() {
      previewGrid.classList.toggle("is-single", cards.length === 1);
    }

    function renderCardResult(card) {
      if (card.err) {
        card.result.innerHTML = '<div class="file-error">' + escapeHtml(card.err) + "</div>";
      } else if (!card.out) {
        card.result.innerHTML = '<div class="file-stats"><span>' + fmtBytes(card.file.size) + "</span></div>";
      } else {
        card.result.innerHTML = resultHtml({
          before: card.file.size,
          after: card.out.blob.size,
          note: card.out.note,
          dims: card.out.dims,
          name: card.finalName,
          url: auto ? (card.liveUrl && card.finalName ? card.liveUrl : "") : card.finalUrl
        });
      }
    }

    function applyOut(card, out, sig) {
      card.out = out;
      card.err = "";
      card.sig = sig;
      card.el.classList.remove("is-error", "is-updating");
      card.tagAfter.textContent = out.blob === card.file ? "Original kept" : "Compressed";
      if (out.before && card.beforeBlob !== out.before) {
        var oldBefore = card.beforeUrl;
        card.beforeBlob = out.before;
        card.beforeUrl = URL.createObjectURL(out.before);
        card.imgBefore.src = card.beforeUrl;
        if (oldBefore) URL.revokeObjectURL(oldBefore);
      }
      var old = card.liveUrl;
      card.liveUrl = URL.createObjectURL(out.blob);
      card.imgAfter.src = card.liveUrl;
      if (old) URL.revokeObjectURL(old);
      syncNames(card);
      renderCardResult(card);
    }

    function applyError(card, message, sig) {
      card.out = null;
      card.err = message;
      card.sig = sig;
      card.finalUrl = "";
      card.finalName = "";
      card.el.classList.remove("is-done", "is-updating");
      card.el.classList.add("is-error");
      setLiveVisible(card, false);
      if (card.liveUrl) {
        card.imgAfter.removeAttribute("src");
        URL.revokeObjectURL(card.liveUrl);
        card.liveUrl = "";
      }
      syncNames(card);
      renderCardResult(card);
    }

    function disposeCard(card) {
      card.dead = true;
      if (resizeObserver) resizeObserver.unobserve(card.thumb);
      URL.revokeObjectURL(card.thumbUrl);
      if (card.liveUrl) URL.revokeObjectURL(card.liveUrl);
      if (card.beforeUrl) URL.revokeObjectURL(card.beforeUrl);
      card.el.remove();
    }

    function reset() {
      if (busy) return;
      if (live) { clearTimeout(liveTimer); liveTimer = null; liveDirty = false; }
      queue = [];
      lastSettingsSig = null;
      clearResults();
      cards.forEach(disposeCard);
      cards = [];
      if (cfg.onQueue) cfg.onQueue([]);
      if (previewGrid) updateLayoutMode();
      clearTimeout(noteTimer);
      hint.textContent = defaultHint;
      queueNote.textContent = "";
      toolPanel.hidden = true;
      emptyState.hidden = false;
      stage.classList.add("is-empty");
      fileInput.value = "";
      updateLiveTotal();
    }

    function setBusy(v) {
      busy = v;
      if (compressBtn) compressBtn.disabled = v;
      resetBtn.disabled = v;
      addMoreBtn.disabled = v;
      if (live) liveInputs.forEach(function (el) { el.disabled = v; });
      if (!v) updateQueueUI();
    }

    var lastSettingsSig = null;
    function settingsChanged(e) {
      if (!live || busy) return;
      var sNow = currentSig();
      if (sNow !== null && sNow === lastSettingsSig) return;
      lastSettingsSig = sNow;
      if (results.length || ranOnce) clearResults();
      cards.forEach(function (c) { c.el.classList.add("is-updating"); });
      var typed = e && e.target && e.target.type === "number";
      scheduleLive(typed ? LIVE_DEBOUNCE : LIVE_THROTTLE, typed);
    }

    function scheduleLive(delay, trailing) {
      if (!live) return;
      liveDirty = true;
      if (trailing) { clearTimeout(liveTimer); liveTimer = null; }
      if (!liveTimer) {
        liveTimer = setTimeout(function () { liveTimer = null; kickLive(); }, delay);
      }
      updateLiveTotal();
    }

    function stopLive() {
      liveDirty = true;
      clearTimeout(liveTimer);
      liveTimer = null;
      return liveIdle;
    }

    function kickLive() {
      if (!live || liveRunning || busy || !cards.length) return;
      liveRunning = true;
      liveIdle = liveLoop()
        .catch(function (err) { console.error("Live preview failed", err); })
        .then(function () {
          liveRunning = false;
          if (liveDirty && !busy && cards.length) scheduleLive(0);
          else updateLiveTotal();
        });
      updateLiveTotal();
    }

    async function liveLoop() {
      while (liveDirty && !busy && cards.length) {
        liveDirty = false;
        var opts;
        try { opts = cfg.readOptions(); }
        catch (e) {
          notify(friendly(e));
          cards.forEach(function (c) { c.el.classList.remove("is-updating"); });
          return;
        }
        var sig = JSON.stringify(opts);
        var list = cards.slice();
        list.forEach(function (c) { c.el.classList.toggle("is-updating", !c.dead && c.sig !== sig); });
        updateLiveTotal();

        var lctx = {
          status: function () {},
          tick: tick,
          cancelled: function () { return liveDirty || busy; }
        };
        for (var i = 0; i < list.length; i++) {
          var card = list[i];
          if (liveDirty || busy) break;
          if (card.dead || card.sig === sig) continue;
          var out = null, failure = null;
          try { out = await cfg.compress(card.file, opts, lctx); }
          catch (err) {
            if (err && err.name === "Cancelled") break;
            failure = err;
          }
          if (liveDirty || busy) break;
          if (card.dead) continue;
          if (failure) {
            console.error("Failed to process", card.file.name, failure);
            applyError(card, friendly(failure), sig);
          } else {
            applyOut(card, out, sig);
          }
          updateLiveTotal();
          await tick();
        }
        if (!liveDirty && !busy) {
          list.forEach(function (c) { c.el.classList.remove("is-updating"); });
        }
      }
      updateLiveTotal();
    }

    function currentSig() {
      try { return JSON.stringify(cfg.readOptions()); } catch (e) { return null; }
    }

    function syncNames(skip) {
      if (!auto) return;
      var used = new Set();
      cards.forEach(function (c) {
        var n = c.out ? uniqueName(used, c.out.name) : "";
        if (n !== c.finalName) {
          c.finalName = n;
          if (c !== skip && c.out) renderCardResult(c);
        }
      });
    }

    function updateDownloadAll() {
      if (!auto) return;
      var ready = cards.some(function (c) { return !!c.out; });
      downloadAllBtn.hidden = !ready;
      if (!zipping) {
        downloadAllBtn.textContent = cards.length === 1 ? "Download" : "Download all (.zip)";
        downloadAllBtn.disabled = liveRunning || liveDirty || !!liveTimer;
      }
    }

    function updateLiveTotal() {
      updateDownloadAll();
      if (!liveTotalEl) return;
      var ready = cards.filter(function (c) { return c.out; });
      var working = liveRunning || liveDirty || !!liveTimer;
      if (!cards.length || (!ready.length && !working)) { liveTotalEl.hidden = true; return; }
      liveTotalEl.hidden = false;
      liveTotalEl.classList.toggle("is-updating", working);
      var failed = cards.filter(function (c) { return c.err; }).length;
      $("liveState").textContent = working ? "updating\u2026" : (failed ? failed + " failed" : "");
      if (!ready.length) {
        $("liveSizes").textContent = "\u2026";
        $("livePct").textContent = "";
        $("liveBar").style.width = "0%";
        return;
      }
      var before = 0, after = 0;
      ready.forEach(function (c) { before += c.file.size; after += c.out.blob.size; });
      var saved = savedPct(before, after);
      $("liveSizes").textContent = fmtBytes(before) + " \u2192 " + fmtBytes(after);
      $("livePct").textContent = pctLabel(saved);
      $("liveBar").style.width = Math.min(100, Math.max(0, saved)) + "%";
    }

    function resultHtml(r) {
      var saved = savedPct(r.before, r.after);
      var width = Math.min(100, Math.max(0, saved));
      return '<div class="file-stats"><span>' + fmtBytes(r.before) + '</span><span class="arrow">\u2192</span>' +
        '<span class="after">' + fmtBytes(r.after) + '</span><span class="pct">' + pctLabel(saved) + "</span></div>" +
        '<div class="file-bar"><div class="file-bar-fill" style="width:' + width + '%"></div></div>' +
        (r.dims ? '<div class="file-dims">' + escapeHtml(dimsText(r.dims)) + "</div>" : "") +
        (r.note ? '<div class="file-note">' + escapeHtml(r.note) + "</div>" : "") +
        (r.url
          ? '<div class="file-actions"><a href="' + r.url + '" download="' + escapeHtml(r.name) + '">Download</a></div>'
          : "");
    }

    function renderRow(r, idx) {
      var card = previewGrid && cards[idx];
      if (card) {
        card.finalUrl = r.url;
        card.finalName = r.name;
        card.el.classList.add("is-done");
        renderCardResult(card);
        return;
      }
      var row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = '<div class="file-name">' + escapeHtml(r.name) + "</div>" + resultHtml(r);
      panel.appendChild(row);
    }

    function renderError(name, message) {
      var row = document.createElement("div");
      row.className = "file-row is-error";
      row.innerHTML =
        (name ? '<div class="file-name">' + escapeHtml(name) + "</div>" : "") +
        '<div class="file-error">' + escapeHtml(message) + "</div>";
      panel.appendChild(row);
    }

    function renderSummary() {
      var before = results.reduce(function (s, r) { return s + r.before; }, 0);
      var after = results.reduce(function (s, r) { return s + r.after; }, 0);
      var row = document.createElement("div");
      row.className = "summary-row";
      row.innerHTML =
        '<span class="summary-total">' + fmtBytes(before) + " \u2192 " + fmtBytes(after) + "</span>" +
        '<span class="summary-pct">' + pctLabel(savedPct(before, after)) + "</span>";
      panel.appendChild(row);
    }

    function friendly(err) {
      if (err instanceof UserError) return err.message;
      var m = err && err.message ? String(err.message) : String(err);
      return "Something went wrong: " + (m.length > 200 ? m.slice(0, 200) + "\u2026" : m);
    }

    async function run() {
      if (!queue.length || busy) return;
      var opts;
      try { opts = cfg.readOptions(); }
      catch (e) { notify(friendly(e)); return; }
      var sig = JSON.stringify(opts);

      setBusy(true);
      clearResults();
      ranOnce = true;
      setEmptyHint(false);
      var used = new Set();
      try {
        compressBtn.textContent = "Loading\u2026";
        if (live) await stopLive();
        try { await requireLibs(cfg.libsFor(opts)); }
        catch (err) { renderError("", friendly(err)); return; }

        for (var i = 0; i < queue.length; i++) {
          var file = queue[i];
          var card = live ? cards[i] : null;
          var label = queue.length > 1 ? (i + 1) + "/" + queue.length + " \u00b7 " + file.name : file.name;
          var ctx = {
            status: function (text) {
              compressBtn.textContent = label + (text ? " \u00b7 " + text : "");
            },
            tick: tick
          };
          ctx.status("");
          var known = card && card.sig === sig;
          if (known && card.err) {
          } else {
            try {
              var out = known && card.out ? card.out : await cfg.compress(file, opts, ctx);
              if (card && !known) applyOut(card, out, sig);
              var r = {
                name: uniqueName(used, out.name),
                before: file.size,
                after: out.blob.size,
                blob: out.blob,
                note: out.note || "",
                dims: out.dims
              };
              r.url = URL.createObjectURL(r.blob);
              urls.push(r.url);
              results.push(r);
              renderRow(r, i);
            } catch (err) {
              console.error("Failed to process", file.name, err);
              if (card) applyError(card, friendly(err), sig);
              else renderError(file.name, friendly(err));
            }
          }
          await tick();
        }
        if (results.length && !previewGrid) renderSummary();
        if (results.length > 1) downloadAllBtn.hidden = false;
      } finally {
        setBusy(false);
        if (live) {
          cards.forEach(function (c) { c.el.classList.remove("is-updating"); });
          scheduleLive(0);
        }
      }
    }

    if (compressBtn) compressBtn.addEventListener("click", run);
    resetBtn.addEventListener("click", reset);
    addMoreBtn.addEventListener("click", function () { if (!busy) fileInput.click(); });

    if (live) {
      liveInputs.forEach(function (el) {
        el.addEventListener("input", settingsChanged);
        el.addEventListener("change", settingsChanged);
      });
    }

    fileInput.addEventListener("change", function () {
      addFiles(fileInput.files);
      fileInput.value = "";
    });

    stage.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("#toolPanel")) return;
      if (!toolPanel.hidden || busy) return;
      fileInput.click();
    });
    emptyState.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    advancedToggle.setAttribute("aria-expanded", "false");
    advancedToggle.addEventListener("click", function () {
      advancedFields.hidden = !advancedFields.hidden;
      advancedToggle.setAttribute("aria-expanded", String(!advancedFields.hidden));
    });

    var dragDepth = 0;
    function hasFiles(e) {
      return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1);
    }
    window.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      stage.classList.add("drag");
    });
    window.addEventListener("dragover", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
    });
    window.addEventListener("dragleave", function (e) {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) stage.classList.remove("drag");
    });
    window.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      stage.classList.remove("drag");
      addFiles(e.dataTransfer.files);
    });

    function triggerDownload(blob, name) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }

    function downloadItems() {
      if (!auto) {
        return results.length ? results.map(function (r) { return { name: r.name, blob: r.blob }; }) : null;
      }
      var sig = currentSig();
      if (sig === null) {
        try { cfg.readOptions(); } catch (e) { notify(friendly(e)); }
        return null;
      }
      var items = [], stale = false;
      cards.forEach(function (c) {
        if (c.err) return;
        if (c.out && c.sig === sig) items.push({ name: c.finalName, blob: c.out.blob });
        else stale = true;
      });
      if (stale) { notify("Preview is still updating \u2014 try again in a moment."); return null; }
      return items.length ? items : null;
    }

    if (auto) {
      previewGrid.addEventListener("click", function (e) {
        var a = e.target.closest && e.target.closest(".file-actions a");
        if (!a) return;
        var card = cards.filter(function (c) { return c.result.contains(a); })[0];
        if (card && !(card.out && card.sig === currentSig())) {
          e.preventDefault();
          notify("Preview is still updating \u2014 try again in a moment.");
        }
      });
    }

    downloadAllBtn.addEventListener("click", async function () {
      if (zipping) return;
      var items = downloadItems();
      if (!items) return;
      if (auto && cards.length === 1 && items.length === 1) {
        triggerDownload(items[0].blob, items[0].name);
        return;
      }
      var original = downloadAllBtn.textContent;
      zipping = true;
      downloadAllBtn.disabled = true;
      downloadAllBtn.textContent = "Zipping\u2026";
      try {
        await requireLibs(["jszip"]);
        var zip = new global.JSZip();
        items.forEach(function (it) { zip.file(it.name, it.blob); });
        var blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
        triggerDownload(blob, cfg.zipName);
      } catch (err) {
        console.error(err);
        notify(friendly(err));
      } finally {
        zipping = false;
        downloadAllBtn.textContent = original;
        downloadAllBtn.disabled = false;
        if (auto) updateDownloadAll();
      }
    });

    warmLocal(cfg.warm);
  }

  global.Steno = {
    UserError: UserError,
    Cancelled: Cancelled,
    fmtBytes: fmtBytes,
    escapeHtml: escapeHtml,
    savedPct: savedPct,
    pctLabel: pctLabel,
    uniqueName: uniqueName,
    tick: tick,
    requireLibs: requireLibs,
    createApp: createApp,
    internals: {}
  };
})(window);