/* the cube: pixel screen renderer.
   Downsamples images to an N x N LED grid and draws the grid as a diffused LED panel. */
'use strict';

window.CubeScreen = (() => {
  const OFF_COVERAGE = 0.45;  // cells less opaque than this stay unlit
  const OFF_LEVEL = 22;       // cells darker than this (brightest channel, 0-255) stay unlit
  const TRANSITION_MS = 520;
  const SPARKLE = 0.12;       // fraction of the transition a freshly lit LED stays over-bright

  /* Area-average an image into an n x n grid. Each cell is [r, g, b] or null (unlit).
     The image is fitted (contained) into a square, so non-square images are letterboxed. */
  function downsample(source, n) {
    let w = source.naturalWidth || source.width;
    let h = source.naturalHeight || source.height;
    const shrink = Math.min(1, 1024 / Math.max(w, h));
    w = Math.max(1, Math.round(w * shrink));
    h = Math.max(1, Math.round(h * shrink));
    // Tiny images get a nearest-neighbour upscale first so every cell receives samples.
    const grow = Math.max(w, h) < n * 4 ? Math.ceil((n * 8) / Math.max(w, h)) : 1;
    w *= grow;
    h *= grow;
    const side = Math.max(w, h);

    const c = document.createElement('canvas');
    c.width = c.height = side;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = grow === 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, Math.floor((side - w) / 2), Math.floor((side - h) / 2), w, h);
    const data = ctx.getImageData(0, 0, side, side).data;

    const cellOf = new Int32Array(side);
    const span = new Float64Array(n);
    for (let i = 0; i < side; i++) {
      cellOf[i] = Math.min(n - 1, Math.floor((i * n) / side));
      span[cellOf[i]]++;
    }

    // Alpha-weighted sums so transparent pixels don't darken the average.
    const acc = new Float64Array(n * n * 4);
    for (let y = 0; y < side; y++) {
      const row = cellOf[y] * n;
      let p = y * side * 4;
      for (let x = 0; x < side; x++, p += 4) {
        const a = data[p + 3];
        if (!a) continue;
        const k = (row + cellOf[x]) * 4;
        acc[k] += data[p] * a;
        acc[k + 1] += data[p + 1] * a;
        acc[k + 2] += data[p + 2] * a;
        acc[k + 3] += a;
      }
    }

    const grid = new Array(n * n).fill(null);
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cy * n + cx;
        const k = i * 4;
        const a = acc[k + 3];
        if (!a || a / (255 * span[cx] * span[cy]) < OFF_COVERAGE) continue;
        const r = acc[k] / a, g = acc[k + 1] / a, b = acc[k + 2] / a;
        if (Math.max(r, g, b) < OFF_LEVEL) continue;
        grid[i] = [r, g, b];
      }
    }
    return grid;
  }

  let grain = null;
  function grainCanvas() {
    if (grain) return grain;
    grain = document.createElement('canvas');
    grain.width = grain.height = 128;
    const g = grain.getContext('2d');
    const img = g.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 90;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return grain;
  }

  let hotspot = null;
  function hotspotCanvas() {
    if (hotspot) return hotspot;
    hotspot = document.createElement('canvas');
    hotspot.width = hotspot.height = 64;
    const g = hotspot.getContext('2d');
    const grad = g.createRadialGradient(32, 29, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return hotspot;
  }

  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

  class PixelScreen {
    constructor(canvas, settings) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.settings = settings;
      this.leds = document.createElement('canvas');   // sharp LED layer
      this.bloom = document.createElement('canvas');  // lit LEDs only, blurred into the glow
      this.grid = null;
      this.from = null;
      this.order = null;
      this.start = 0;
      this.queued = false;
      this.grainPattern = null;
      // Observe the exact device-pixel size so the backing store maps 1:1 to screen pixels
      // (no browser resampling, which would soften pixel edges).
      const observer = new ResizeObserver((entries) => this.resize(entries[0]));
      try {
        observer.observe(canvas, { box: 'device-pixel-content-box' });
      } catch {
        observer.observe(canvas);
      }
    }

    resize(entry) {
      const box = entry && entry.devicePixelContentBoxSize && entry.devicePixelContentBoxSize[0];
      // Both sizes ignore CSS 3D transforms, so cube faces render at their flat size.
      const size = box ? box.inlineSize : Math.round(this.canvas.clientWidth * (window.devicePixelRatio || 1));
      if (size && size !== this.canvas.width) {
        for (const c of [this.canvas, this.leds, this.bloom]) c.width = c.height = size;
      }
      this.requestRender();
    }

    setGrid(grid, animate) {
      if (animate && this.settings.transition) {
        const shown = this.snapshot();
        this.from = shown && shown.length === grid.length ? shown : new Array(grid.length).fill(null);
        this.order = Float32Array.from({ length: grid.length }, () => Math.random() * (1 - SPARKLE));
        this.start = performance.now();
      } else {
        this.from = null;
        this.order = null;
      }
      this.grid = grid;
      this.requestRender();
    }

    progress() {
      if (!this.order) return 1;
      const p = (performance.now() - this.start) / TRANSITION_MS;
      if (p >= 1) {
        this.order = null;
        this.from = null;
        return 1;
      }
      return p;
    }

    // What the panel currently shows, so an interrupted transition continues from it.
    snapshot() {
      const p = this.progress();
      if (!this.order) return this.grid;
      return this.grid.map((c, i) => (p >= this.order[i] ? c : this.from[i]));
    }

    requestRender() {
      if (this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => {
        this.queued = false;
        this.render();
        if (this.order) this.requestRender();
      });
    }

    shade([r, g, b], boost) {
      const s = this.settings;
      if (s.matte) {
        // Desaturate and compress towards the middle: closer to ink on paper than light.
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = (r + (l - r) * 0.3) * 0.74 + 34;
        g = (g + (l - g) * 0.3) * 0.74 + 34;
        b = (b + (l - b) * 0.3) * 0.74 + 34;
      }
      const k = s.brightness * boost;
      return `rgb(${clamp(r * k)},${clamp(g * k)},${clamp(b * k)})`;
    }

    render() {
      const W = this.canvas.width;
      if (!W || !this.grid) return;
      const s = this.settings;
      const matte = s.matte;
      const grid = this.grid;
      const n = Math.round(Math.sqrt(grid.length));
      const p = this.progress();
      const { from, order } = this;

      // Whole-device-pixel pitch, gap and cell size: every LED is identical and edge-sharp.
      const pitch = Math.max(2, Math.floor((W * 0.92) / n));
      const gap = Math.min(pitch - 1, Math.max(1, Math.round(pitch * s.gap)));
      const cell = pitch - gap;
      const offset = Math.floor((W - (n * pitch - gap)) / 2);
      const radius = cell * 0.24;
      const lw = cell >= 8 ? Math.max(1, Math.round(W / 600)) : 0;
      const lo = [], hi = [];
      for (let k = 0; k < n; k++) {
        lo.push(offset + k * pitch);
        hi.push(offset + k * pitch + cell);
      }

      const base = matte ? '#2a2521' : '#15110e';
      const L = this.leds.getContext('2d');
      const B = this.bloom.getContext('2d');
      L.globalCompositeOperation = 'source-over';
      L.globalAlpha = 1;
      L.fillStyle = base;
      L.fillRect(0, 0, W, W);
      B.clearRect(0, 0, W, W);

      const offPath = new Path2D();
      const rimPath = new Path2D();  // inset by half a line so the rim lands on whole pixels
      const lit = [];
      for (let cy = 0; cy < n; cy++) {
        for (let cx = 0; cx < n; cx++) {
          const i = cy * n + cx;
          let c = grid[i];
          let boost = 1;
          if (order) {
            const d = p - order[i];
            if (d < 0) c = from[i];
            else if (d < SPARKLE && c) boost = 1 + 0.6 * (1 - d / SPARKLE);
          }
          const x = lo[cx], y = lo[cy], w = hi[cx] - x, h = hi[cy] - y;
          if (c) lit.push({ x, y, w, h, color: this.shade(c, boost) });
          else {
            offPath.roundRect(x, y, w, h, radius);
            if (lw) rimPath.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, Math.max(0, radius - lw / 2));
          }
        }
      }

      // Unlit LEDs: dim grey-brown with a faint rim (skipped when cells are too small for one).
      L.fillStyle = matte ? '#3a342f' : '#2a241f';
      L.fill(offPath);
      if (lw) {
        L.lineWidth = lw;
        L.strokeStyle = matte ? 'rgba(255,240,220,0.10)' : 'rgba(255,232,205,0.075)';
        L.stroke(rimPath);
      }

      const spread = gap * 0.45;
      for (const d of lit) {
        L.fillStyle = d.color;
        L.beginPath();
        L.roundRect(d.x, d.y, d.w, d.h, radius);
        L.fill();
        B.fillStyle = d.color;
        B.beginPath();
        B.roundRect(d.x - spread, d.y - spread, d.w + spread * 2, d.h + spread * 2, radius + spread);
        B.fill();
      }
      if (!matte) {
        // A brighter centre on each lit LED, like the emitter behind the plastic.
        L.globalCompositeOperation = 'lighter';
        L.globalAlpha = 0.16;
        const spot = hotspotCanvas();
        for (const d of lit) L.drawImage(spot, d.x, d.y, d.w, d.h);
        L.globalCompositeOperation = 'source-over';
        L.globalAlpha = 1;
      }

      const ctx = this.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, W, W);

      // Diffuser blur, with a little of the sharp layer kept for structure.
      const soft = s.blur * pitch * 0.3 * (matte ? 1.15 : 1);
      if (soft > 0.25) {
        ctx.filter = `blur(${soft}px)`;
        ctx.drawImage(this.leds, 0, 0);
        ctx.filter = 'none';
        ctx.globalAlpha = 0.3 * (1 - s.blur);
        ctx.drawImage(this.leds, 0, 0);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(this.leds, 0, 0);
      }

      // Bloom: a tight halo into the gaps plus a wide, faint wash.
      const glow = s.glow * Math.min(1.5, s.brightness) * (matte ? 0.12 : 1);
      if (glow > 0.01 && lit.length) {
        ctx.globalCompositeOperation = 'screen';
        ctx.filter = `blur(${pitch * 0.3}px)`;
        ctx.globalAlpha = Math.min(1, glow * 0.85);
        ctx.drawImage(this.bloom, 0, 0);
        ctx.filter = `blur(${pitch}px)`;
        ctx.globalAlpha = Math.min(1, glow * 0.4);
        ctx.drawImage(this.bloom, 0, 0);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
      }

      // Frosted window: lift blacks / lower contrast and add grain, both scaled by the
      // diffuser amount so 0 gives a perfectly clean panel. Matte keeps some paper tone.
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = matte ? 0.5 + 0.5 * s.blur : s.blur;
      ctx.fillStyle = matte ? 'rgba(222,214,200,0.12)' : 'rgba(205,196,182,0.08)';
      ctx.fillRect(0, 0, W, W);

      if (s.blur > 0) {
        this.grainPattern = this.grainPattern || ctx.createPattern(grainCanvas(), 'repeat');
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = (matte ? 0.55 : 0.45) * s.blur;
        ctx.fillStyle = this.grainPattern;
        ctx.fillRect(0, 0, W, W);
      }
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'screen';
      const sheen = ctx.createLinearGradient(0, 0, W * 0.6, W);
      sheen.addColorStop(0, 'rgba(255,255,255,0.07)');
      sheen.addColorStop(0.5, 'rgba(255,255,255,0.015)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, W, W);

      ctx.globalCompositeOperation = 'source-over';
      const vignette = ctx.createRadialGradient(W / 2, W / 2, W * 0.35, W / 2, W / 2, W * 0.75);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.28)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, W);
      ctx.restore();
    }
  }

  return { PixelScreen, downsample };
})();
