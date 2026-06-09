// Inline settings panel controller. Runs in the overlay renderer alongside
// overlay.js, so it is wrapped in an IIFE to avoid clashing with its globals.
(function () {
  const api = window.lyricsAPI;
  const $ = (id) => document.getElementById(id);
  let settings = null;

  // [elementId, type]  -- elementId === settings key.
  const BINDS = [
    ['textColor', 'color'], ['activeColor', 'color'], ['accentColor', 'color'], ['bgColor', 'color'],
    ['bgOpacity', 'range'], ['artBlur', 'range'], ['fontSize', 'range'], ['lineSpacing', 'range'],
    ['activeScale', 'range'], ['cornerRadius', 'range'], ['shadeOpacity', 'range'],
    ['fontFamily', 'select'], ['fontWeight', 'select'], ['textAlign', 'select'], ['backdrop', 'select'],
    ['glow', 'check'], ['textShadow', 'check'], ['showAlbumArt', 'check'], ['showHeader', 'check'],
    ['showControls', 'check'], ['compact', 'check'], ['alwaysOnTop', 'check'],
    ['startLocked', 'check'], ['autoHidePaused', 'check'], ['autoHideNoLyrics', 'check'],
    ['startWithWindows', 'check'], ['lyricOffsetMs', 'range']
  ];
  const HOTKEYS = ['toggleLock', 'toggleShow', 'offsetMinus', 'offsetPlus'];

  const SECTION_KEYS = {
    appearance: ['theme', 'backdrop', 'activeColor', 'textColor', 'accentColor', 'bgColor', 'bgOpacity',
      'shadeOpacity', 'artBlur', 'fontFamily', 'fontSize', 'fontWeight', 'lineSpacing', 'textAlign',
      'activeScale', 'cornerRadius', 'glow', 'textShadow'],
    layout: ['showAlbumArt', 'showHeader', 'showControls', 'compact', 'alwaysOnTop'],
    behavior: ['startLocked', 'autoHidePaused', 'autoHideNoLyrics', 'startWithWindows', 'lyricOffsetMs'],
    hotkeys: ['hotkeys']
  };

  const THEMES = {
    dark:   { theme: 'dark',   bgColor: '#0a0a0a', bgOpacity: 0.55, textColor: '#9aa0a6', activeColor: '#ffffff', accentColor: '#1db954' },
    light:  { theme: 'light',  bgColor: '#f2f2f2', bgOpacity: 0.72, textColor: '#5f6368', activeColor: '#0a0a0a', accentColor: '#1db954' },
    amoled: { theme: 'amoled', bgColor: '#000000', bgOpacity: 0.88, textColor: '#6b6b6b', activeColor: '#ffffff', accentColor: '#1ed760' }
  };

  const isFloat = (el) => el.hasAttribute('data-float');

  function readControl(id, type) {
    const el = $(id);
    if (type === 'check') return el.checked;
    if (type === 'range') return isFloat(el) ? parseFloat(el.value) : parseInt(el.value, 10);
    return el.value;
  }
  function writeControl(id, type, v) {
    const el = $(id);
    if (!el) return;
    if (type === 'check') el.checked = !!v;
    else el.value = v;
    const out = $(id + '-out');
    if (out) out.textContent = (type === 'range') ? String(v) : '';
  }

  async function patch(p) { settings = await api.setSettings(p); }

  function loadValues() {
    for (const [id, type] of BINDS) writeControl(id, type, settings[id]);
    for (const k of HOTKEYS) { const el = $('hk-' + k); if (el) el.value = (settings.hotkeys && settings.hotkeys[k]) || ''; }
    $('spotifyClientId').value = settings.spotifyClientId || '';
  }

  function bindAll() {
    for (const [id, type] of BINDS) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('change', () => {
        const v = readControl(id, type);
        const out = $(id + '-out'); if (out) out.textContent = String(v);
        patch({ [id]: v });
      });
      if (type === 'range') el.addEventListener('input', () => {
        const out = $(id + '-out'); if (out) out.textContent = el.value;
      });
    }
    for (const k of HOTKEYS) {
      const el = $('hk-' + k);
      el.addEventListener('change', () => patch({ hotkeys: { [k]: el.value.trim() } }));
    }
    $('spotifyClientId').addEventListener('change', (e) => patch({ spotifyClientId: e.target.value.trim() }));

    document.querySelectorAll('.preset').forEach((b) =>
      b.addEventListener('click', async () => { await patch(THEMES[b.dataset.theme]); loadValues(); }));

    document.querySelectorAll('.restore').forEach((b) =>
      b.addEventListener('click', async () => { settings = await api.resetKeys(SECTION_KEYS[b.dataset.section] || []); loadValues(); }));

    $('btn-dashboard').addEventListener('click', () => api.openExternal('https://developer.spotify.com/dashboard'));
    $('btn-connect').addEventListener('click', connect);
    $('btn-disconnect').addEventListener('click', async () => { await api.logout(); refreshAuth(); });
    $('btn-reset').addEventListener('click', async () => { settings = await api.resetSettings(); loadValues(); refreshAuth(); });

    // accordion
    document.querySelectorAll('#settings-panel .acc-head').forEach((h) =>
      h.addEventListener('click', () => h.parentElement.classList.toggle('open')));

    // panel open/close
    $('btn-settings').addEventListener('click', openPanel);
    $('settings-back').addEventListener('click', closePanel);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('settings-panel').classList.contains('open')) closePanel();
    });

    // search
    $('set-search').addEventListener('input', (e) => applySearch(e.target.value));

    // presets
    $('preset-save-btn').addEventListener('click', savePreset);
    $('preset-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePreset(); });
  }

  function openPanel() {
    $('settings-panel').classList.add('open');
    api.pauseTopmost(true);           // don't let moveTop() close native color / select popups
    setTimeout(() => $('set-search').focus(), 120);
  }
  function closePanel() {
    $('settings-panel').classList.remove('open');
    api.pauseTopmost(false);
    $('set-search').value = '';
    applySearch('');
  }

  function applySearch(q) {
    q = q.trim().toLowerCase();
    const noRes = $('set-noresults');
    if (!q) {
      document.querySelectorAll('#settings-panel .field').forEach((f) => f.classList.remove('hidden'));
      document.querySelectorAll('#settings-panel .acc').forEach((s) => {
        s.style.display = '';
        s.classList.toggle('open', s.dataset.section === 'appearance' || s.dataset.section === 'presets');
      });
      noRes.classList.add('hidden');
      return;
    }
    let any = false;
    document.querySelectorAll('#settings-panel .acc').forEach((sec) => {
      const headMatch = sec.querySelector('.acc-head').textContent.toLowerCase().includes(q);
      let secHit = headMatch;
      sec.querySelectorAll('.field').forEach((f) => {
        const match = headMatch || f.textContent.toLowerCase().includes(q);
        f.classList.toggle('hidden', !match);
        if (match) secHit = true;
      });
      sec.style.display = secHit ? '' : 'none';
      sec.classList.toggle('open', secHit);
      if (secHit) any = true;
    });
    noRes.classList.toggle('hidden', any);
  }

  async function connect() {
    $('auth-msg').textContent = '';
    const res = await api.startAuth();
    if (res && !res.ok) $('auth-msg').textContent = res.error || 'Could not connect.';
    refreshAuth();
  }

  async function refreshAuth() {
    const s = await api.getAuthStatus();
    const el = $('auth-status');
    if (s.authed) { el.textContent = s.canControl ? 'Connected' : 'Connected (reconnect for controls)'; el.className = 'status on'; }
    else if (!s.clientId) { el.textContent = 'No Client ID yet'; el.className = 'status off'; }
    else { el.textContent = 'Not connected'; el.className = 'status off'; }
  }

  async function populateFonts() {
    const fonts = await api.fonts();
    const sel = $('fontFamily');
    sel.innerHTML = '';
    for (const f of fonts) {
      const o = document.createElement('option');
      o.value = f; o.textContent = f; o.style.fontFamily = f;
      sel.appendChild(o);
    }
  }

  // ---- presets ----
  const MAX_PRESETS = 5;
  const PRESET_EXCLUDE = new Set(['spotifyClientId', 'lyricsUserAgent', 'bounds', 'presets']);

  // Snapshot everything customizable (appearance, layout, behavior, hotkeys),
  // skipping account/window/preset bookkeeping.
  function snapshotForPreset() {
    const out = {};
    for (const k of Object.keys(settings)) if (!PRESET_EXCLUDE.has(k)) out[k] = structuredClone(settings[k]);
    return out;
  }

  function renderPresets() {
    const list = $('preset-list');
    const presets = Array.isArray(settings.presets) ? settings.presets : [];
    list.innerHTML = '';
    presets.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'preset-row';
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name || `Preset ${i + 1}`;
      const apply = document.createElement('button');
      apply.className = 'apply'; apply.textContent = 'Apply';
      apply.addEventListener('click', () => applyPreset(i));
      const del = document.createElement('button');
      del.className = 'del'; del.title = 'Delete preset'; del.textContent = '✕';
      del.addEventListener('click', () => deletePreset(i));
      row.append(name, apply, del);
      list.appendChild(row);
    });
    const full = presets.length >= MAX_PRESETS;
    $('preset-count').textContent = `${presets.length} / ${MAX_PRESETS}` + (full ? '  ·  delete one to save more' : '');
    $('preset-save-btn').disabled = full;
    $('preset-name').disabled = full;
  }

  async function savePreset() {
    const presets = Array.isArray(settings.presets) ? settings.presets.slice() : [];
    if (presets.length >= MAX_PRESETS) return;
    const input = $('preset-name');
    const name = (input.value || '').trim() || `Preset ${presets.length + 1}`;
    presets.push({ name, values: snapshotForPreset() });
    settings = await api.setSettings({ presets });
    input.value = '';
    renderPresets();
  }

  async function applyPreset(i) {
    const presets = settings.presets || [];
    if (!presets[i]) return;
    settings = await api.setSettings(presets[i].values);  // re-applies every setting + side effects
    loadValues();
    renderPresets();
  }

  async function deletePreset(i) {
    const presets = (settings.presets || []).slice();
    presets.splice(i, 1);
    settings = await api.setSettings({ presets });
    renderPresets();
  }

  async function init() {
    settings = await api.getSettings();
    await populateFonts();
    bindAll();
    loadValues();
    renderPresets();
    refreshAuth();
    api.onAuthChanged(() => refreshAuth());
    api.onSettingsChanged((s) => { settings = s; loadValues(); renderPresets(); });
    api.onOpenSettings(() => openPanel());
  }

  init();
})();
