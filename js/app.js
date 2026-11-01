/* the cube: image queues, slideshow, settings and views. Nothing persists between sessions. */
'use strict';

(() => {
  const { PixelScreen, downsample } = window.CubeScreen;

  const DEFAULTS = {
    res: 24,
    matte: false,
    brightness: 1,
    glow: 0.6,
    blur: 0,
    gap: 0.18,
    transition: true,
    autoplay: false,
    interval: 3,
    angle: 38,
  };
  const settings = { ...DEFAULTS };

  const ACCEPT = /^image\/(png|jpe?g|webp|gif)$/;
  const THUMB_MIME = 'application/x-cube-thumb';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Grain texture for the matte bezel.
  (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 120;
    const g = c.getContext('2d');
    const img = g.createImageData(120, 120);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    document.documentElement.style.setProperty('--noise', `url(${c.toDataURL()})`);
  })();

  // Shown while a queue is empty.
  const placeholder = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#f2c14e';
    g.beginPath();
    g.arc(128, 128, 104, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#000';
    g.fillRect(82, 84, 22, 34);
    g.fillRect(152, 84, 22, 34);
    g.strokeStyle = '#000';
    g.lineWidth = 20;
    g.beginPath();
    g.arc(128, 132, 56, 0.2 * Math.PI, 0.8 * Math.PI);
    g.stroke();
    return c;
  })();
  const placeholderGrids = {};
  const placeholderGrid = () => (placeholderGrids[settings.res] ||= downsample(placeholder, settings.res));

  let uid = 0;
  function loadImage(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ id: ++uid, name: file.name, url, img, grids: {} });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  const ICON_X = '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>';

  class Player {
    constructor(id) {
      this.id = id;
      this.queue = [];
      this.index = -1;
      this.dragFrom = -1;
      this.screen = new PixelScreen($(`#screen-${id}`), settings);
      this.strip = $(`#strip-${id}`);
      this.counter = $(`#counter-${id}`);
      this.prevBtn = $(`#prev-${id}`);
      this.nextBtn = $(`#next-${id}`);
      this.prevBtn.addEventListener('click', () => { this.prev(); restartAutoplay(); });
      this.nextBtn.addEventListener('click', () => { this.next(); restartAutoplay(); });
      this.show(-1, false);
    }

    get current() { return this.queue[this.index] || null; }

    gridFor(item) { return (item.grids[settings.res] ||= downsample(item.img, settings.res)); }

    async add(files) {
      const list = [...files].filter((f) => ACCEPT.test(f.type));
      if (!list.length) return;
      const items = (await Promise.all(list.map(loadImage))).filter(Boolean);
      if (!items.length) return;
      const wasEmpty = !this.queue.length;
      this.queue.push(...items);
      if (wasEmpty) this.show(0);
      else this.renderUI();
    }

    show(i, animate = true) {
      const n = this.queue.length;
      if (!n) {
        this.index = -1;
        this.screen.setGrid(placeholderGrid(), animate);
      } else {
        this.index = ((i % n) + n) % n;
        this.screen.setGrid(this.gridFor(this.current), animate);
      }
      this.renderUI();
    }

    next() { if (this.queue.length > 1) this.show(this.index + 1); }
    prev() { if (this.queue.length > 1) this.show(this.index - 1); }
    refresh() { this.show(this.index, false); }

    remove(id) {
      const at = this.queue.findIndex((it) => it.id === id);
      if (at < 0) return;
      const [gone] = this.queue.splice(at, 1);
      URL.revokeObjectURL(gone.url);
      if (at === this.index) {
        this.show(Math.min(at, this.queue.length - 1));
      } else {
        if (at < this.index) this.index--;
        this.renderUI();
      }
    }

    // Move the item at `from` so it lands before the item currently at `to`.
    move(from, to) {
      if (to === from || to === from + 1) return;
      const cur = this.current;
      const [item] = this.queue.splice(from, 1);
      this.queue.splice(to > from ? to - 1 : to, 0, item);
      this.index = this.queue.indexOf(cur);
      this.renderUI();
    }

    renderUI() {
      const n = this.queue.length;
      this.counter.textContent = n ? `${this.index + 1} / ${n}` : 'No images';
      this.prevBtn.disabled = this.nextBtn.disabled = n < 2;

      const tiles = this.queue.map((item, i) => this.thumb(item, i));
      tiles.push(this.addTile(!n));
      this.strip.replaceChildren(...tiles);

      const active = $('.thumb.active', this.strip);
      if (active) {
        const s = this.strip;
        if (active.offsetLeft < s.scrollLeft || active.offsetLeft + active.offsetWidth > s.scrollLeft + s.clientWidth) {
          s.scrollTo({ left: active.offsetLeft - (s.clientWidth - active.offsetWidth) / 2, behavior: 'smooth' });
        }
      }
    }

    thumb(item, i) {
      const t = document.createElement('div');
      t.className = 'thumb' + (i === this.index ? ' active' : '');
      t.draggable = true;
      t.title = item.name;
      const img = new Image();
      img.src = item.url;
      img.alt = item.name;
      img.draggable = false;
      if (Math.max(item.img.naturalWidth, item.img.naturalHeight) <= 64) img.className = 'pixelated';
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.setAttribute('aria-label', `Remove ${item.name}`);
      rm.innerHTML = ICON_X;
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        this.remove(item.id);
      });
      t.append(img, rm);

      t.addEventListener('click', () => {
        if (i !== this.index) {
          this.show(i);
          restartAutoplay();
        }
      });
      t.addEventListener('dragstart', (e) => {
        this.dragFrom = i;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(THUMB_MIME, String(i));
        t.classList.add('dragging');
      });
      t.addEventListener('dragend', () => {
        this.dragFrom = -1;
        $$('.thumb', this.strip).forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
      });
      t.addEventListener('dragover', (e) => {
        if (this.dragFrom < 0) return;
        e.preventDefault();
        const after = this.isAfter(e, t);
        $$('.thumb', this.strip).forEach((el) => el.classList.remove('drop-before', 'drop-after'));
        t.classList.add(after ? 'drop-after' : 'drop-before');
      });
      t.addEventListener('drop', (e) => {
        if (this.dragFrom < 0) return;
        e.preventDefault();
        this.move(this.dragFrom, i + (this.isAfter(e, t) ? 1 : 0));
      });
      return t;
    }

    isAfter(e, el) {
      const r = el.getBoundingClientRect();
      return e.clientX > r.left + r.width / 2;
    }

    addTile(empty) {
      const label = document.createElement('label');
      label.className = 'add-tile' + (empty ? ' wide' : '');
      label.title = 'Add PNG or JPG images';
      label.innerHTML = ICON_PLUS + (empty ? '<span>Drop PNGs here or click to add</span>' : '');
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'image/png,image/jpeg';
      input.addEventListener('change', () => {
        this.add(input.files);
        input.value = '';
      });
      label.append(input);
      return label;
    }
  }

  const players = {
    main: new Player('main'),
    left: new Player('left'),
    right: new Player('right'),
  };
  const allPlayers = Object.values(players);

  /* Views */
  let view = 'single';
  let focused = players.left;

  function setView(next) {
    view = next;
    $$('[data-view]').forEach((el) => (el.hidden = el.dataset.view !== view));
    $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === view)));
    document.body.classList.toggle('in-cube', view === 'cube');
    restartAutoplay();
  }
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.tab)));

  function setFocus(player) {
    focused = player;
    $$('.queue').forEach((q) => q.classList.toggle('focused', q.dataset.player === player.id));
  }
  $$('.view-cube [data-player]').forEach((el) =>
    el.addEventListener('pointerdown', () => setFocus(players[el.dataset.player]))
  );
  setFocus(players.left);

  const visiblePlayers = () => (view === 'single' ? [players.main] : [players.left, players.right]);

  /* Auto-play */
  let timer = null;
  function restartAutoplay() {
    clearInterval(timer);
    timer = null;
    if (settings.autoplay) {
      timer = setInterval(() => visiblePlayers().forEach((p) => p.next()), Math.max(0.5, settings.interval) * 1000);
    }
  }

  /* Keyboard */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    e.preventDefault();
    const targets = view === 'single' ? [players.main] : e.shiftKey ? visiblePlayers() : [focused];
    targets.forEach((p) => (e.key === 'ArrowLeft' ? p.prev() : p.next()));
    restartAutoplay();
  });

  /* File drag and drop anywhere on the page */
  const overlay = $('#drop-overlay');
  const dropLabel = $('#drop-label');
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const NAMES = { main: 'the screen', left: 'the left face', right: 'the right face' };

  function playerFor(target) {
    if (view === 'single') return players.main;
    const host = target && target.closest && target.closest('[data-player]');
    return host ? players[host.dataset.player] : focused;
  }

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropLabel.textContent = `Drop images to add to ${NAMES[playerFor(e.target).id]}`;
    overlay.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) overlay.classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    overlay.classList.remove('show');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const player = playerFor(e.target);
    if (view === 'cube') setFocus(player);
    player.add(e.dataTransfer.files);
  });

  /* Settings */
  const FORMAT = {
    brightness: (v) => `${Math.round(v * 100)}%`,
    glow: (v) => `${Math.round(v * 100)}%`,
    blur: (v) => `${Math.round(v * 100)}%`,
    gap: (v) => `${Math.round(v * 100)}%`,
    angle: (v) => `${v}°`,
  };

  function syncControls() {
    $$('[data-setting]').forEach((input) => {
      const v = settings[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = v;
      else input.value = v;
    });
    Object.keys(FORMAT).forEach((key) => ($(`output[data-for="${key}"]`).textContent = FORMAT[key](settings[key])));
    $$('#res button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.res === settings.res)));
    $('#cube').style.setProperty('--angle', settings.angle);
  }

  function applySetting(key) {
    syncControls();
    if (key === 'res') allPlayers.forEach((p) => p.refresh());
    else if (key === 'autoplay' || key === 'interval') restartAutoplay();
    else if (key !== 'angle') allPlayers.forEach((p) => p.screen.requestRender());
  }

  $$('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    const event = input.type === 'range' ? 'input' : 'change';
    input.addEventListener(event, () => {
      if (input.type === 'checkbox') {
        settings[key] = input.checked;
      } else {
        const v = parseFloat(input.value);
        if (Number.isNaN(v)) return syncControls();
        settings[key] = Math.min(+input.max || Infinity, Math.max(+input.min || 0, v));
      }
      applySetting(key);
    });
  });

  $$('#res button').forEach((b) =>
    b.addEventListener('click', () => {
      settings.res = +b.dataset.res;
      applySetting('res');
    })
  );

  $('#reset').addEventListener('click', () => {
    Object.assign(settings, DEFAULTS);
    applySetting('res');
    restartAutoplay();
  });

  syncControls();

  // Handy for poking at things from the console.
  window.cube = { players, settings };
})();
