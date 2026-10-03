(function () {
  "use strict";

  function create(container, opts) {
    opts = opts || {};
    const minScale = 1;
    const maxScale = opts.maxScale || 6;

    container.classList.add("compare-viewer");
    container.innerHTML = `
      <div class="compare-frame" id="cvFrame">
        <div class="compare-empty" id="cvEmpty">rendering…</div>
        <div class="compare-pane compare-before"><img class="compare-img" draggable="false" alt=""></div>
        <div class="compare-pane compare-after"><img class="compare-img" draggable="false" alt=""></div>
        <div class="compare-handle" id="cvHandle" tabindex="0" role="slider" aria-label="Compare before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
          <div class="compare-handle-line"></div>
          <div class="compare-handle-grip">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 7 3 12l5 5M16 7l5 5-5 5"/>
            </svg>
          </div>
        </div>
        <div class="compare-tag compare-tag-before">before</div>
        <div class="compare-tag compare-tag-after">after</div>
      </div>
      <div class="compare-zoom-hint" id="cvZoomHint">scroll to zoom · drag to compare</div>
    `;

    const frame = container.querySelector("#cvFrame");
    const emptyNote = container.querySelector("#cvEmpty");
    const beforeImg = container.querySelector(".compare-before .compare-img");
    const afterImg = container.querySelector(".compare-after .compare-img");
    const afterPane = container.querySelector(".compare-after");
    const handle = container.querySelector("#cvHandle");
    const zoomHint = container.querySelector("#cvZoomHint");

    let pos = 50;
    let scale = 1, tx = 0, ty = 0;
    let draggingHandle = false;
    let panning = false;
    let panStart = null;
    let hasBefore = false, hasAfter = false;
    let hideHintTimer = null;

    function refreshEmptyState() {
      emptyNote.style.display = hasBefore ? "none" : "flex";
    }

    function applyTransform() {
      const t = `translate(${tx}px, ${ty}px) scale(${scale})`;
      beforeImg.style.transform = t;
      afterImg.style.transform = t;
      frame.classList.toggle("zoomed", scale > 1.001);
    }

    function clampPan() {
    }

    function setPosition(pct) {
      pos = Math.min(97, Math.max(3, pct));
      afterPane.style.clipPath = `inset(0 0 0 ${pos}%)`;
      handle.style.left = pos + "%";
      handle.setAttribute("aria-valuenow", Math.round(pos));
    }
    setPosition(50);

    function xToPct(clientX) {
      const r = frame.getBoundingClientRect();
      return ((clientX - r.left) / r.width) * 100;
    }

    function flashHint() {
      zoomHint.classList.add("show");
      clearTimeout(hideHintTimer);
      hideHintTimer = setTimeout(() => zoomHint.classList.remove("show"), 1400);
    }

    handle.addEventListener("pointerdown", (e) => {
      draggingHandle = true;
      handle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    handle.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") setPosition(pos - 3);
      if (e.key === "ArrowRight") setPosition(pos + 3);
    });

    window.addEventListener("pointermove", (e) => {
      if (draggingHandle) {
        setPosition(xToPct(e.clientX));
      } else if (panning && panStart) {
        tx = panStart.tx + (e.clientX - panStart.x);
        ty = panStart.ty + (e.clientY - panStart.y);
        clampPan();
        applyTransform();
      }
    });
    window.addEventListener("pointerup", () => {
      draggingHandle = false;
      panning = false;
      panStart = null;
      frame.classList.remove("panning");
    });

    frame.addEventListener("pointerdown", (e) => {
      if (e.target === handle || handle.contains(e.target)) return;
      if (scale > 1) {
        panning = true;
        panStart = { x: e.clientX, y: e.clientY, tx, ty };
        frame.classList.add("panning");
      }
    });

    frame.addEventListener(
      "wheel",
      (e) => {
        if (!hasBefore) return;
        e.preventDefault();
        const factor = -e.deltaY > 0 ? 1.12 : 1 / 1.12;
        const newScale = Math.min(maxScale, Math.max(minScale, scale * factor));
        if (newScale === scale) return;

        const r = frame.getBoundingClientRect();
        const cx = e.clientX - r.left - r.width / 2;
        const cy = e.clientY - r.top - r.height / 2;
        tx = cx - (cx - tx) * (newScale / scale);
        ty = cy - (cy - ty) * (newScale / scale);
        scale = newScale;
        if (scale <= 1.001) {
          scale = 1;
          tx = 0;
          ty = 0;
        }
        applyTransform();
      },
      { passive: false }
    );

    frame.addEventListener("dblclick", () => {
      scale = 1;
      tx = 0;
      ty = 0;
      applyTransform();
    });

    refreshEmptyState();

    return {
      setBefore(url) {
        hasBefore = !!url;
        if (url) beforeImg.src = url;
        refreshEmptyState();
        if (url) flashHint();
      },
      setAfter(url) {
        hasAfter = !!url;
        if (url) afterImg.src = url;
      },
      clear() {
        hasBefore = false;
        hasAfter = false;
        beforeImg.removeAttribute("src");
        afterImg.removeAttribute("src");
        refreshEmptyState();
      },
      resetZoom() {
        scale = 1;
        tx = 0;
        ty = 0;
        applyTransform();
      },
      setPosition,
    };
  }

  window.CompareSlider = { create };
})();