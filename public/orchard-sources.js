/*
 * Source selector (YT Music / SoundCloud / both) and SoundCloud account control.
 *
 * Talks to the bridge's /sc/* JSON endpoints. The backend owns the mode, so a
 * change just persists it and reloads the renderer, which refetches home,
 * library and auth state under the new mode.
 */
(() => {
  const MODE_KEY = 'orchard:source-mode';
  const MODES = [
    ['ytm', 'YT Music'],
    ['sc', 'SoundCloud'],
    ['both', 'YT & SC']
  ];
  const port = new URLSearchParams(location.search).get('socketPort');
  if (!port) return;
  const base = `http://127.0.0.1:${port}`;

  const readMode = () => {
    try { return MODES.some(([m]) => m === localStorage.getItem(MODE_KEY)) ? localStorage.getItem(MODE_KEY) : 'ytm'; } catch { return 'ytm'; }
  };
  const writeMode = (mode) => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage unavailable */ } };

  const state = { mode: readMode(), signedIn: false, user: null, busy: '' };
  window.__orchardSource = state;

  async function call(path) {
    const response = await fetch(`${base}${path}`);
    const json = await response.json();
    if (!json.ok) throw new Error(json.error || 'Request failed');
    return json.data;
  }

  function applyStatus(data) {
    state.mode = data.mode;
    state.signedIn = Boolean(data.signedIn);
    state.user = data.user || null;
    writeMode(state.mode);
    document.documentElement.dataset.source = state.mode;
    render();
  }

  const style = document.createElement('style');
  style.textContent = `
    .osrc { margin: 2px 0 6px; font-size: 11px; line-height: 1.2; }
    .sidebar-group--nav > .sidebar-label { display: none; }
    .osrc .osrc-seg { display: flex; padding: 3px; gap: 2px; border-radius: 9px; background: rgba(255,255,255,.07); }
    .osrc .osrc-seg button { all: unset; box-sizing: border-box; flex: 1 1 0; min-width: 0; text-align: center; border-radius: 7px; padding: 6px 0; font-size: 10px; letter-spacing: -.1px; overflow: hidden; text-overflow: ellipsis; color: rgba(255,255,255,.62); font-weight: 600; cursor: pointer; white-space: nowrap; }
    .osrc .osrc-seg button:hover { color: #fff; }
    .osrc .osrc-seg button.osrc-on { background: var(--q-primary, #7509ce); color: #fff; }
    .osrc .osrc-seg button:disabled { opacity: .5; cursor: default; }
    .osrc-account { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,.05); color: rgba(255,255,255,.8); }
    .osrc-account img { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; }
    .osrc-account .osrc-name { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
    .osrc-account .osrc-name b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .osrc-account .osrc-name small { font-size: 10px; opacity: .65; }
    .osrc-account button { flex: none; }
    .osrc-account button { border: 0; border-radius: 6px; padding: 5px 9px; background: rgba(255,255,255,.12); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .osrc-account button.osrc-primary { background: #ff5500; }
    .osrc-account button:disabled { opacity: .6; cursor: default; }
    .osrc-error { margin-top: 6px; color: #ff8a80; }
    .sidebar-inner { overflow-y: auto !important; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.35) transparent; }
    .sidebar-group--playlists { flex: 1 0 200px !important; min-height: 200px !important; }
    .sidebar-group--status { position: sticky; bottom: 0; z-index: 5; background: color-mix(in srgb, var(--bg, #0b0b0b) 94%, transparent); backdrop-filter: blur(12px); padding-top: 6px; }
    .sidebar-playlist-scroll { overflow-y: auto !important; scrollbar-width: thin !important; scrollbar-color: rgba(255,255,255,.4) rgba(255,255,255,.06); padding-right: 6px !important; }
    .auth-gate__panel .osrc { width: 100%; max-width: 320px; margin: 14px auto 0; }
    html[data-source="sc"] .nav-link[data-yt-only] { display: none !important; }
    html[data-source="sc"] .nav-link[data-sc-hide] { display: none !important; }
    html:not([data-source="sc"]) .nav-link[data-lib="stations"] { display: none !important; }
    html[data-source="sc"] .nav-link[data-lib-name="artists"] > span { font-size: 0; }
    html[data-source="sc"] .nav-link[data-lib-name="artists"] > span::after { content: 'Following'; font-size: 14px; }
  `;
  document.head.appendChild(style);

  function build() {
    const root = document.createElement('div');
    root.className = 'osrc';
    root.setAttribute('data-osrc', '');

    const seg = document.createElement('div');
    seg.className = 'osrc-seg';
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', 'Music source');
    for (const [mode, label] of MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.mode = mode;
      button.textContent = label;
      button.addEventListener('click', () => switchMode(mode));
      seg.appendChild(button);
    }
    root.appendChild(seg);

    const account = document.createElement('div');
    account.className = 'osrc-account';
    root.appendChild(account);

    const error = document.createElement('div');
    error.className = 'osrc-error';
    root.appendChild(error);
    return root;
  }

  function paint(root) {
    for (const button of root.querySelectorAll('.osrc-seg button')) {
      button.classList.toggle('osrc-on', button.dataset.mode === state.mode);
      button.disabled = Boolean(state.busy);
    }

    const account = root.querySelector('.osrc-account');
    account.style.display = state.mode === 'ytm' ? 'none' : 'flex';
    account.replaceChildren();
    if (state.mode === 'ytm') return;

    if (state.signedIn) {
      if (state.user?.thumbnail) {
        const img = document.createElement('img');
        img.src = state.user.thumbnail;
        img.alt = '';
        account.appendChild(img);
      }
      const name = document.createElement('span');
      name.className = 'osrc-name';
      name.title = `${state.user?.name || 'Signed in'} · SoundCloud`;
      const who = document.createElement('b');
      who.textContent = state.user?.name || 'Signed in';
      const via = document.createElement('small');
      via.textContent = 'SoundCloud';
      name.append(who, via);
      const out = document.createElement('button');
      out.type = 'button';
      out.textContent = 'Sign out';
      out.disabled = Boolean(state.busy);
      out.addEventListener('click', signOut);
      account.append(name, out);
    } else {
      const name = document.createElement('span');
      name.className = 'osrc-name';
      name.textContent = 'SoundCloud';
      const inn = document.createElement('button');
      inn.type = 'button';
      inn.className = 'osrc-primary';
      inn.textContent = state.busy === 'login' ? 'Waiting…' : 'Sign in';
      inn.disabled = Boolean(state.busy);
      inn.addEventListener('click', signIn);
      account.append(name, inn);
    }
  }

  function setError(message) {
    for (const el of document.querySelectorAll('.osrc-error')) el.textContent = message || '';
  }

  /** Re-reads auth/home/search under the new source without reloading, so playback and parties survive. */
  async function refreshApp() {
    const store = window.__orchardStore;
    if (!store) { location.reload(); return; }
    try {
      store.homeData.value = { home: { sections: [] }, library: { sections: [] } };
      await store.fetchAuthStatus();
      const view = store.activeView.value;
      if (view === 'search' && store.query.value?.trim()) store.runSearch();
      else if (!['home', 'queue', 'settings', 'support'].includes(view)) store.navigateToView('home');
    } catch {
      location.reload();
    }
  }

  async function switchMode(mode) {
    if (mode === state.mode || state.busy) return;
    state.busy = 'mode';
    render();
    try {
      applyStatus(await call(`/sc/mode?set=${encodeURIComponent(mode)}`));
      state.busy = '';
      render();
      await refreshApp();
    } catch (error) {
      state.busy = '';
      setError(error.message);
      render();
    }
  }

  async function signIn() {
    if (state.busy) return;
    state.busy = 'login';
    setError('');
    render();
    try {
      const data = await call('/sc/login');
      state.busy = '';
      applyStatus(data);
      if (data.signedIn) await refreshApp();
    } catch (error) {
      state.busy = '';
      setError(error.message);
      render();
    }
  }

  async function signOut() {
    if (state.busy) return;
    state.busy = 'logout';
    render();
    try {
      applyStatus(await call('/sc/logout'));
      state.busy = '';
      render();
      await refreshApp();
    } catch (error) {
      state.busy = '';
      setError(error.message);
      render();
    }
  }

  function render() {
    for (const root of document.querySelectorAll('[data-osrc]')) paint(root);
    document.documentElement.dataset.source = state.mode;
  }

  const YT_ONLY = /(New|Radio|Concerts|Podcasts|Replay)$/;
  let scheduled = false;
  function ensureMounted() {
    scheduled = false;

    const nav = document.querySelector('.sidebar-inner > nav.sidebar-group--nav');
    if (nav && !nav.previousElementSibling?.hasAttribute?.('data-osrc')) {
      nav.parentElement.insertBefore(build(), nav);
      render();
    }

    const panel = document.querySelector('.auth-gate__panel');
    if (panel && !panel.querySelector('[data-osrc]')) {
      panel.appendChild(build());
      render();
    }

    for (const link of document.querySelectorAll('.sidebar .nav-link')) {
      const text = link.textContent.trim();
      if (YT_ONLY.test(text)) link.setAttribute('data-yt-only', '');
      if (/Songs$/.test(text)) link.setAttribute('data-sc-hide', '');
      if (/Artists$/.test(text)) link.setAttribute('data-lib-name', 'artists');
    }
  }

  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(ensureMounted, 30);
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.documentElement.dataset.source = state.mode;
  call('/sc/status').then(applyStatus).catch(() => {});
})();

/*
 * Appearance: pick any font installed on the system.
 * Platform badges: in the mixed client, mark whether things come from
 * YT Music or SoundCloud.
 */
(() => {
  const FONT_KEY = 'orchard:font-family';
  const FONT_LIST_KEY = 'orchard:font-list';
  const FALLBACK = '"Avenir Next","Helvetica Neue","Liberation Sans",sans-serif';
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* unavailable */ } }
  };

  const css = document.createElement('style');
  document.head.appendChild(css);
  const fontStyle = document.createElement('style');
  document.head.appendChild(fontStyle);

  css.textContent = `
    .osrc-font-control { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .osrc-font-control select { min-width: 200px; max-width: 280px; padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: inherit; font: inherit; }
    .osrc-font-control select option { background: #1b1b1b; color: #eee; }
    .osrc-font-control button { padding: 7px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.08); color: inherit; font: inherit; cursor: pointer; }
    .osrc-font-note { width: 100%; text-align: right; font-size: 12px; opacity: .7; }
    .osrc-src { display: inline-flex; flex: none; width: 15px; height: 15px; margin-right: 6px; vertical-align: -3px; }
    .osrc-src svg { width: 100%; height: 100%; display: block; }
    .osrc-src.osrc-np { width: 20px; height: 20px; margin: 0 10px 0 2px; align-self: center; }
    .osrc-thumb-badge { position: absolute; right: 4px; bottom: 4px; z-index: 3; pointer-events: none; display: flex; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
    .osrc-thumb-badge svg { width: 100%; height: 100%; display: block; }
  `;

  /* ---------------------------------------------------------------- fonts */
  function applyFont(name) {
    fontStyle.textContent = name ? `body { font-family: "${name.replace(/["\\]/g, '')}", ${FALLBACK} !important; }` : '';
  }
  applyFont(store.get(FONT_KEY));

  const readList = () => { try { return JSON.parse(store.get(FONT_LIST_KEY) || '[]'); } catch { return []; } };

  async function loadSystemFonts() {
    let families = [];
    try {
      if (typeof window.queryLocalFonts === 'function') {
        const fonts = await window.queryLocalFonts();
        families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      }
    } catch { /* needs a visible window and permission; fall back to the system list */ }
    if (!families.length) {
      const port = new URLSearchParams(location.search).get('socketPort');
      const json = await (await fetch(`http://127.0.0.1:${port}/fonts`)).json();
      families = json.data || [];
    }
    if (!families.length) throw new Error('Could not read the installed fonts.');
    store.set(FONT_LIST_KEY, JSON.stringify(families));
    return families;
  }

  function fillSelect(select, families) {
    const current = store.get(FONT_KEY) || '';
    select.replaceChildren();
    select.appendChild(new Option('Default (Avenir Next)', ''));
    const list = current && !families.includes(current) ? [current, ...families] : families;
    for (const family of list) {
      const option = new Option(family, family);
      option.style.fontFamily = `"${family}"`;
      select.appendChild(option);
    }
    select.value = current;
  }

  function buildFontRow() {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.setAttribute('data-osrc-font', '');

    const copy = document.createElement('div');
    copy.className = 'settings-row__copy';
    copy.innerHTML = '<label>Font</label><p>Use any font installed on this computer for the whole app.</p>';

    const control = document.createElement('div');
    control.className = 'osrc-font-control';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Font');
    fillSelect(select, readList());
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = readList().length ? 'Refresh fonts' : 'Load installed fonts';
    const note = document.createElement('div');
    note.className = 'osrc-font-note';

    select.addEventListener('change', () => {
      store.set(FONT_KEY, select.value || null);
      applyFont(select.value);
    });
    button.addEventListener('click', async () => {
      button.disabled = true;
      note.textContent = 'Reading installed fonts…';
      try {
        const families = await loadSystemFonts();
        fillSelect(select, families);
        button.textContent = 'Refresh fonts';
        note.textContent = `${families.length} fonts found.`;
      } catch (error) {
        note.textContent = error?.message || 'Could not read installed fonts.';
      } finally {
        button.disabled = false;
      }
    });

    control.append(select, button, note);
    row.append(copy, control);
    return row;
  }

  /* --------------------------------------------------------------- badges */
  const SVG = {
    ytm: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#f00"/><path d="M9.6 7.4v9.2l7.4-4.6z" fill="#fff"/></svg>',
    sc: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#f50"/><path fill="#fff" d="M5.2 14.1v2.3h.8v-2.3zm1.6-1.4v3.7h.8v-3.7zm1.6-.8v4.5h.8v-4.5zm1.6-.7v5.2h.8v-5.2zm1.6-.4v5.6h5.2c1.3 0 2.2-.9 2.2-2.1 0-1.2-.9-2.1-2.1-2.1-.3 0-.5 0-.7.1-.3-1.5-1.5-2.4-3-2.4-.6 0-1.1.1-1.6.4z"/></svg>'
  };
  const TITLES = { ytm: 'YouTube Music', sc: 'SoundCloud' };

  function sourceOfUrl(url) {
    if (/sndcdn\.com/i.test(url)) return 'sc';
    if (/ytimg\.com|ggpht\.com|googleusercontent\.com|gstatic\.com|youtube\.com/i.test(url)) return 'ytm';
    return '';
  }

  function badge(source, size, className) {
    const el = document.createElement('span');
    el.className = className;
    el.setAttribute('data-osrc-src', source);
    el.title = TITLES[source];
    el.innerHTML = SVG[source];
    if (size) { el.style.width = `${size}px`; el.style.height = `${size}px`; }
    return el;
  }

  function activeSource() {
    const track = window.__orchardStore?.activeTrack?.value;
    if (!track?.id) return '';
    return String(track.id).startsWith('sc:') || track.source === 'soundcloud' ? 'sc' : 'ytm';
  }

  function decorate() {
    const mixed = window.__orchardSource?.mode === 'both';
    if (!mixed) {
      for (const el of document.querySelectorAll('[data-osrc-src]')) el.remove();
      return;
    }

    // Now playing: a single badge beside the track details in the player bar.
    const source = activeSource();
    for (const info of document.querySelectorAll('.player-track__info')) {
      const existing = info.previousElementSibling?.matches?.('.osrc-np') ? info.previousElementSibling : null;
      if (!source) { existing?.remove(); continue; }
      if (existing?.getAttribute('data-osrc-src') === source) continue;
      existing?.remove();
      info.before(badge(source, 0, 'osrc-src osrc-np'));
    }

    // Everything else is tagged by where its artwork is hosted.
    for (const img of document.querySelectorAll('main img, .q-page img, aside img')) {
      if (img.closest('.sidebar, .osrc, .player-section, .mini-cover-button')) continue;
      const width = img.getBoundingClientRect().width;
      if (width < 30 || width > 300) continue;
      const kind = sourceOfUrl(img.currentSrc || img.src || '');
      const host = img.closest('.q-img') || img.parentElement;
      if (!kind || !host) continue;
      const existing = host.querySelector(':scope > .osrc-thumb-badge');
      const hostStyle = getComputedStyle(host);
      const radius = hostStyle.borderTopLeftRadius; const round = parseFloat(radius) >= (radius.includes('%') ? 40 : width * 0.4);
      const key = `${kind}${round ? '-round' : ''}`;
      if (existing?.getAttribute('data-osrc-key') === key) continue;
      existing?.remove();
      if (hostStyle.position === 'static') host.style.position = 'relative';
      const size = Math.max(12, Math.min(22, Math.round(width * 0.16)));
      const el = badge(kind, size, 'osrc-thumb-badge');
      el.setAttribute('data-osrc-key', key);
      // Circular avatars clip their corners, so tuck the badge inside the circle.
      if (round) { const inset = Math.round(width * 0.15); el.style.right = `${inset}px`; el.style.bottom = `${inset}px`; }
      host.appendChild(el);
    }
  }

  /* ------------------------------------------------------------ lifecycle */
  let scheduled = false;
  function pass() {
    scheduled = false;
    const title = document.getElementById('settings-appearance-title');
    const section = title?.closest('section');
    if (section && !section.querySelector('[data-osrc-font]')) {
      const first = section.querySelector('.settings-row');
      const row = buildFontRow();
      if (first) first.after(row);
      else section.appendChild(row);
    }
    decorate();
  }

  new MutationObserver((records) => {
    // Our own badge insertions must not retrigger the pass endlessly.
    const own = (n) => n.nodeType === 1 && n.hasAttribute?.('data-osrc-src');
    if (records.every((r) => r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(own))) return;
    if (scheduled) return;
    scheduled = true;
    // Throttled: the player bar mutates the DOM every tick, and the pass measures every image.
    setTimeout(() => requestIdleCallback(pass, { timeout: 1500 }), 800);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  // Active-track changes do not always touch the DOM structure; poll cheaply.
  setInterval(() => { if (window.__orchardSource?.mode === 'both') requestIdleCallback(decorate, { timeout: 3000 }); }, 3000);
})();


/*
 * Appearance: text colour for buttons only.
 */
(() => {
  const KEY = 'orchard:button-color';
  const store = {
    get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
    set: (v) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* unavailable */ } }
  };
  const style = document.createElement('style');
  document.head.appendChild(style);
  // Buttons only: leave toggles, sliders, active/accent-driven states and cover/title rows alone.
  const BTN = ':is(button, .q-btn):not(.q-toggle):not(.q-slider):not(.library-link):not(.table-row):not([class*="card"]):not([class*="cover"]):not([class*="track"]):not([class*="--active"]):not(.active):not([aria-pressed="true"]):not([class*="text-primary"]):not(.osrc-on)';
  const apply = (color) => {
    style.textContent = color && /^#[0-9a-f]{6}$/i.test(color)
      ? `${BTN} { color: ${color} !important; }
         .right-queue-expand, .right-queue-sort, .right-queue-clear, .queue-view__sort, .queue-view__clear,
         :is(.right-queue-expand, .right-queue-sort, .right-queue-clear, .queue-view__sort, .queue-view__clear) * { color: ${color} !important; }`
    : '';
  };
  apply(store.get());

  function buildRow() {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.setAttribute('data-osrc-btncolor', '');
    const copy = document.createElement('div');
    copy.className = 'settings-row__copy';
    copy.innerHTML = '<label>Button text color</label><p>Font color of button labels (Open, Best mix, Clear all, etc.). Toggles, sliders and accent-colored states are not affected.</p>';
    const control = document.createElement('div');
    control.className = 'osrc-font-control';
    const input = document.createElement('input');
    input.type = 'color';
    input.setAttribute('aria-label', 'Button text color');
    input.value = store.get() || '#ffffff';
    input.style.cssText = 'width:48px;height:34px;padding:2px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:transparent;cursor:pointer';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset';
    input.addEventListener('input', () => { store.set(input.value); apply(input.value); });
    reset.addEventListener('click', () => { store.set(null); apply(null); input.value = '#ffffff'; });
    control.append(input, reset);
    row.append(copy, control);
    return row;
  }

  let scheduled = false;
  function pass() {
    scheduled = false;
    const section = document.getElementById('settings-appearance-title')?.closest('section');
    if (!section || section.querySelector('[data-osrc-btncolor]')) return;
    const anchor = section.querySelector('[data-osrc-font]') || section.querySelector('.settings-row');
    const row = buildRow();
    if (anchor) anchor.after(row); else section.appendChild(row);
  }
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(pass, 150);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();


/*
 * Accent color: the app writes --q-primary on <html>, but Quasar pins its own
 * value on <body>, which wins for everything below it (toggles, sliders, menus).
 * Mirror the accent onto <body> so those controls follow it.
 */
(() => {
  const sync = () => {
    const value = document.documentElement.style.getPropertyValue('--q-primary');
    if (value && document.body && document.body.style.getPropertyValue('--q-primary') !== value) {
      document.body.style.setProperty('--q-primary', value);
    }
  };
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  document.addEventListener('DOMContentLoaded', sync);
  sync();
})();

/*
 * Performance mode: switches off the decorative work that costs CPU, GPU and
 * memory every frame (CSS animations and transitions, backdrop blur, and the
 * animated immersive artwork background). The previous background setting is
 * remembered and restored when the mode is turned off.
 */
(() => {
  const KEY = 'orchard:perf-mode';
  const PREV_KEY = 'orchard:perf-prev-immersive';
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* unavailable */ } }
  };

  const style = document.createElement('style');
  style.textContent = `
    html.orchard-perf *, html.orchard-perf *::before, html.orchard-perf *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
    html.orchard-perf *, html.orchard-perf *::before, html.orchard-perf *::after {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    html.orchard-perf .q-ripple { display: none !important; }
    .osrc-perf-btn { min-width: 64px; padding: 7px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.08); color: inherit; font: inherit; cursor: pointer; }
    .osrc-perf-btn[aria-pressed="true"] { background: var(--q-primary, #7509ce); border-color: transparent; color: #fff; }
  `;
  document.head.appendChild(style);

  const isOn = () => store.get(KEY) === '1';

  /** Turns the immersive background off through the app's own preference, remembering the old value. */
  function setImmersive(on) {
    const pref = window.__orchardStore?.immersiveBackgroundsEnabled;
    if (!pref) return false;
    if (on) {
      if (store.get(PREV_KEY) == null) store.set(PREV_KEY, pref.value ? '1' : '0');
      pref.value = false;
    } else {
      const prev = store.get(PREV_KEY);
      if (prev != null) pref.value = prev === '1';
      store.set(PREV_KEY, null);
    }
    return true;
  }

  function apply(on) {
    document.documentElement.classList.toggle('orchard-perf', on);
    store.set(KEY, on ? '1' : null);
    if (!setImmersive(on)) {
      // The app store is not exposed until the first socket call; retry shortly.
      let tries = 0;
      const timer = setInterval(() => {
        if (setImmersive(on) || ++tries > 40) clearInterval(timer);
      }, 250);
    }
    for (const button of document.querySelectorAll('[data-osrc-perf] button')) {
      button.setAttribute('aria-pressed', String(on));
      button.textContent = on ? 'On' : 'Off';
    }
  }

  function buildRow() {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.setAttribute('data-osrc-perf', '');

    const copy = document.createElement('div');
    copy.className = 'settings-row__copy';
    copy.innerHTML = '<label>Performance mode</label><p>Turns off animations, blur and the animated artwork background to lower CPU, GPU and memory use.</p>';

    const control = document.createElement('div');
    control.className = 'osrc-font-control';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'osrc-perf-btn';
    button.setAttribute('aria-label', 'Performance mode');
    button.addEventListener('click', () => apply(!isOn()));
    control.appendChild(button);

    row.append(copy, control);
    return row;
  }

  let scheduled = false;
  function pass() {
    scheduled = false;
    const section = document.getElementById('settings-appearance-title')?.closest('section');
    if (!section || section.querySelector('[data-osrc-perf]')) return;
    const anchor = section.querySelector('[data-osrc-font]') || section.querySelector('.settings-row');
    const row = buildRow();
    if (anchor) anchor.after(row); else section.appendChild(row);
    const on = isOn();
    for (const button of row.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(on));
      button.textContent = on ? 'On' : 'Off';
    }
  }
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(pass, 200);
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.documentElement.classList.toggle('orchard-perf', isOn());
  if (isOn()) apply(true);
})();

/*
 * Toast: a short confirmation with a green frame, shown above dialogs.
 * Called by the app after a successful copy (window.orchardToast('...')).
 */
(() => {
  const style = document.createElement('style');
  style.textContent = `
    .osrc-toast { position: fixed; left: 50%; bottom: 28px; z-index: 10000; display: flex; align-items: center; gap: 8px;
      padding: 10px 16px; border-radius: 10px; border: 2px solid #22c55e; background: rgba(12, 28, 18, .94);
      color: #dcfce7; font-size: 13px; font-weight: 600; box-shadow: 0 6px 22px rgba(0, 0, 0, .35);
      pointer-events: none; opacity: 0; transform: translate(-50%, 8px); transition: opacity .18s ease, transform .18s ease; }
    .osrc-toast.osrc-toast--on { opacity: 1; transform: translate(-50%, 0); }
    .osrc-toast .osrc-toast-icon { color: #22c55e; font-size: 16px; line-height: 1; }
  `;
  document.head.appendChild(style);

  let el = null;
  let timer = 0;
  window.orchardToast = (message) => {
    if (!el) {
      el = document.createElement('div');
      el.className = 'osrc-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.innerHTML = '<span class="osrc-toast-icon" aria-hidden="true">&#10003;</span><span class="osrc-toast-text"></span>';
      document.body.appendChild(el);
    }
    el.querySelector('.osrc-toast-text').textContent = String(message || '');
    el.classList.add('osrc-toast--on');
    window.clearTimeout(timer);
    timer = window.setTimeout(() => el.classList.remove('osrc-toast--on'), 2200);
  };
})();
