// Overlay renderer: applies settings, renders the now-playing track + lyrics,
// runs the timing loop (highlight + center the active line), and drives the
// bottom transport bar (play/pause, prev/next, seek).
const api = window.lyricsAPI;
const $ = (id) => document.getElementById(id);

let settings = null;
let status = 'unauthed';
let detail = '';
let track = null;
let lyrics = null;
let playback = null;       // { progressMs, playing, fetchedAt, durationMs }
let locked = false;
let canControl = false;

let lineEls = [];
let activeIndex = -1;

let seekDragging = false;
let hintTimer = null;

const ICON = {
  lockOpen:  '<svg viewBox="0 0 24 24" class="ico"><path d="M17 8V7a5 5 0 00-9.9-1l1.9.5A3 3 0 0115 7v1H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1z"/></svg>',
  lockClosed:'<svg viewBox="0 0 24 24" class="ico"><path d="M12 2a5 5 0 00-5 5v1H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1V7a5 5 0 00-5-5zm3 6H9V7a3 3 0 016 0v1z"/></svg>',
  play:      '<svg viewBox="0 0 24 24" class="ico"><path d="M8 5v14l11-7z"/></svg>',
  pause:     '<svg viewBox="0 0 24 24" class="ico"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>'
};

// ----------------------------------------------------------------- settings --
function applySettings(s) {
  settings = s;
  const r = document.documentElement.style;
  r.setProperty('--text', s.textColor);
  r.setProperty('--active', s.activeColor);
  r.setProperty('--accent', s.accentColor);
  const backdrop = s.backdrop || 'art';
  $('bg').style.display = backdrop === 'art' ? '' : 'none';
  if (backdrop === 'clear') {
    r.setProperty('--bg', '#2b2b2b');                 // neutral grey shade
    r.setProperty('--bg-op', String(s.shadeOpacity ?? 0.12));
  } else {
    r.setProperty('--bg', s.bgColor);
    r.setProperty('--bg-op', String(s.bgOpacity));
  }
  r.setProperty('--art-blur', (s.artBlur || 0) + 'px');
  r.setProperty('--text-shadow', s.textShadow
    ? '0 1px 4px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.7)'
    : 'none');
  r.setProperty('--font', `'${s.fontFamily}', system-ui, sans-serif`);
  r.setProperty('--fsize', (s.fontSize || 24) + 'px');
  r.setProperty('--fweight', String(s.fontWeight || 700));
  r.setProperty('--lh', String(s.lineSpacing || 1.5));
  r.setProperty('--align', s.textAlign || 'center');
  r.setProperty('--ascale', String(s.activeScale || 1.06));
  r.setProperty('--radius', (s.cornerRadius ?? 16) + 'px');

  $('root').classList.toggle('glow', !!s.glow);
  $('header').style.display = (s.showHeader && !s.compact) ? 'flex' : 'none';
  $('art').style.display = s.showAlbumArt ? '' : 'none';

  const hk = (s.hotkeys && s.hotkeys.toggleLock) || 'Alt+Shift+L';
  $('lock-indicator').textContent = `🔒 Click-through on · ${hk} to unlock`;

  updateTransport();
  requestAnimationFrame(() => updateScroll(true));
}

// ------------------------------------------------------------------ render ---
function renderTrack(t) {
  track = t;
  $('title').textContent = t ? t.name : '';
  $('artist').textContent = t ? t.artists : '';
  if (t && t.artUrl) {
    $('art').src = t.artUrl;
    $('bg').style.backgroundImage = `url("${t.artUrl}")`;
  } else {
    $('art').removeAttribute('src');
    $('bg').style.backgroundImage = 'none';
  }
  updateTransport();
}

function clearLines() {
  const wrap = $('lyrics-wrap');
  wrap.innerHTML = '';
  wrap.classList.remove('plain');   // never leave an unsynced overflow behind
  lineEls = [];
  activeIndex = -1;
}

function renderLyrics(ly) {
  lyrics = ly;
  const wrap = $('lyrics-wrap');
  clearLines();

  if (!ly || ly.state === 'loading' || ly.state === 'instrumental' || ly.state === 'none') return;

  if (ly.state === 'plain') {
    wrap.classList.add('plain');
    for (const t of String(ly.plain).split('\n')) {
      const d = document.createElement('div');
      d.className = 'line';
      d.textContent = t || ' ';
      wrap.appendChild(d);
    }
    return;
  }

  wrap.classList.remove('plain');
  ly.lines.forEach((ln) => {
    const d = document.createElement('div');
    d.className = 'line';
    d.textContent = ln.text || ' ';
    wrap.appendChild(d);
    lineEls.push(d);
  });
  wrap.style.transform = 'translateY(0)';
  updateScroll(true);
}

function msgEl(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}
function showMessage(nodes) {
  const m = $('message');
  m.innerHTML = '';
  for (const n of nodes) m.appendChild(n);
  m.classList.remove('hidden');
}
function hideMessage() { $('message').classList.add('hidden'); }

function renderState() {
  if (status === 'unauthed') {
    const connect = document.createElement('button');
    connect.textContent = settings && settings.spotifyClientId ? 'Connect Spotify' : 'Set up Spotify';
    connect.onclick = async () => { const res = await api.startAuth(); if (res && !res.ok) api.openSettings(); };
    showMessage([msgEl('big', 'Spotify lyrics overlay'),
                 msgEl('sub', 'Connect your Spotify account to begin.'), connect]);
    return;
  }
  if (status === 'connecting') { showMessage([msgEl('big', 'Connecting to Spotify…')]); return; }
  if (status === 'error') { showMessage([msgEl('big', 'Spotify hiccup'), msgEl('sub', detail || 'Retrying shortly…')]); return; }
  if (status === 'idle') { showMessage([msgEl('big', 'Nothing playing'), msgEl('sub', 'Press play in Spotify.')]); return; }

  if (!lyrics || lyrics.state === 'loading') { showMessage([msgEl('big', 'Loading lyrics…')]); return; }
  if (lyrics.state === 'instrumental') { showMessage([msgEl('big', '🎵 Instrumental')]); return; }
  if (lyrics.state === 'none') {
    const again = document.createElement('button');
    again.className = 'ghost';
    again.textContent = '↻ Search again';
    again.onclick = () => api.researchLyrics();
    showMessage([msgEl('big', 'No synced lyrics found'),
                 msgEl('sub', 'LRCLIB may not have this track yet.'), again]);
    return;
  }
  hideMessage();
}

// ------------------------------------------------------------- transport ----
function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function duration() {
  return (playback && playback.durationMs) || (track && track.durationMs) || 0;
}

function rawPosition() {
  if (!playback) return 0;
  let p = playback.progressMs;
  if (playback.playing) p += (Date.now() - playback.fetchedAt);
  return Math.min(p, duration() || p);
}

function updatePlayIcon() {
  $('btn-play').innerHTML = (playback && playback.playing) ? ICON.pause : ICON.play;
  $('btn-play').title = (playback && playback.playing) ? 'Pause' : 'Play';
}

function updateTransport() {
  const showBar = !!(settings && settings.showControls && !settings.compact && status === 'ok' && track);
  $('transport').classList.toggle('hidden', !showBar);
  if (!showBar) return;
  $('transport-controls').style.display = canControl ? 'flex' : 'none';
  $('seek').style.pointerEvents = canControl ? '' : 'none';
  const hint = $('transport-hint');
  if (canControl) {
    hint.classList.add('hidden');
  } else {
    hint.innerHTML = '<button id="btn-reconnect">Reconnect to enable controls</button>';
    hint.classList.remove('hidden');
    $('btn-reconnect').onclick = () => api.startAuth();
  }
}

function flashHint(msg) {
  const hint = $('transport-hint');
  $('transport-controls').style.display = 'none';
  hint.textContent = msg;
  hint.classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateTransport, 2500);
}

function handleControlError(res) {
  if (!res) return;
  if (res.reason === 'scope' || res.reason === 'unauthed') { canControl = false; updateTransport(); }
  else if (res.reason === 'nodevice') flashHint('No active Spotify device');
  else if (res.reason === 'forbidden') flashHint('Spotify refused the request');
  else if (res.reason === 'ratelimited') flashHint('Easy — rate limited');
  else flashHint('Could not reach Spotify');
}

function updateSeek() {
  if (seekDragging) return;
  const dur = duration();
  if (!dur) { $('seek-fill').style.width = '0%'; $('seek-handle').style.left = '0%'; return; }
  const r = Math.max(0, Math.min(1, rawPosition() / dur));
  $('seek-fill').style.width = (r * 100) + '%';
  $('seek-handle').style.left = (r * 100) + '%';
  $('t-cur').textContent = fmt(rawPosition());
  $('t-tot').textContent = fmt(dur);
}

function seekRatio(e) {
  const rect = $('seek').getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}
function previewSeek(r) {
  $('seek-fill').style.width = (r * 100) + '%';
  $('seek-handle').style.left = (r * 100) + '%';
  $('t-cur').textContent = fmt(r * duration());
}

// ------------------------------------------------------------------- timing --
function estPosition() {
  return rawPosition() + (settings ? (settings.lyricOffsetMs || 0) : 0);
}

function findActive(pos) {
  const L = lyrics && lyrics.lines;
  if (!L || !L.length) return -1;
  let lo = 0, hi = L.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].timeMs <= pos) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

function setActive(idx) {
  if (lineEls[activeIndex]) lineEls[activeIndex].classList.remove('active');
  activeIndex = idx;
  if (lineEls[idx]) lineEls[idx].classList.add('active');
  for (let i = 0; i < lineEls.length; i++) {
    if (i === idx) { lineEls[i].style.opacity = ''; continue; }
    const dist = Math.abs(i - idx);
    lineEls[i].style.opacity = String(Math.max(0.16, 0.5 - dist * 0.07));
  }
  updateScroll(false);
}

function updateScroll(immediate) {
  const view = $('lyrics-view');
  const wrap = $('lyrics-wrap');
  if (!view || !wrap || wrap.classList.contains('plain')) return;
  const target = lineEls[activeIndex >= 0 ? activeIndex : 0];
  if (!target) { wrap.style.transform = 'translateY(0)'; return; }
  const y = view.clientHeight / 2 - (target.offsetTop + target.offsetHeight / 2);
  if (immediate) {
    const prev = wrap.style.transition;
    wrap.style.transition = 'none';
    wrap.style.transform = `translateY(${y}px)`;
    void wrap.offsetHeight;
    wrap.style.transition = prev;
  } else {
    wrap.style.transform = `translateY(${y}px)`;
  }
}

function applyAutoHide() {
  if (!settings) return;
  let hide = false;
  if (settings.autoHidePaused && playback && !playback.playing && status === 'ok') hide = true;
  if (settings.autoHideNoLyrics && status === 'ok' &&
      (!lyrics || (lyrics.state !== 'synced' && lyrics.state !== 'plain'))) hide = true;
  $('root').classList.toggle('hidden-content', hide);
}

function loop() {
  if (status === 'ok' && lyrics && lyrics.state === 'synced') {
    const idx = findActive(estPosition());
    if (idx !== activeIndex) setActive(idx);
  }
  updateSeek();
  applyAutoHide();
  requestAnimationFrame(loop);
}

// -------------------------------------------------------------------- lock ---
let lockHintTimer = null;
function flashLockHint() {
  const el = $('lock-indicator');
  el.classList.add('flash');
  clearTimeout(lockHintTimer);
  lockHintTimer = setTimeout(() => el.classList.remove('flash'), 2200);
}

function setLock(l) {
  const was = locked;
  locked = l;
  $('root').classList.toggle('locked', l);
  $('btn-lock').innerHTML = l ? ICON.lockClosed : ICON.lockOpen;
  $('btn-lock').title = l ? 'Unlock (make clickable)' : 'Lock (click-through)';
  if (l && !was) flashLockHint();   // brief confirmation when newly locked
}

// -------------------------------------------------------------------- init ---
function wireButtons() {
  // btn-settings is wired by settings-panel.js (opens the inline panel)
  $('btn-lock').onclick = () => api.toggleLocked();
  $('btn-research').onclick = () => api.researchLyrics();
  $('btn-min').onclick = () => api.minimize();
  $('btn-close').onclick = () => api.quit();

  $('btn-play').onclick = async () => {
    const res = await api.playbackToggle();
    if (res && !res.ok) handleControlError(res);
    else if (playback) { playback.playing = !playback.playing; playback.fetchedAt = Date.now(); updatePlayIcon(); }
  };
  $('btn-next').onclick = async () => { handleControlError(await api.playbackNext()); };
  $('btn-prev').onclick = async () => { handleControlError(await api.playbackPrev()); };

  const seek = $('seek');
  seek.addEventListener('pointerdown', (e) => {
    if (!canControl) return;
    seekDragging = true;
    seek.classList.add('dragging');
    try { seek.setPointerCapture(e.pointerId); } catch {}
    previewSeek(seekRatio(e));
  });
  seek.addEventListener('pointermove', (e) => { if (seekDragging) previewSeek(seekRatio(e)); });
  seek.addEventListener('pointerup', async (e) => {
    if (!seekDragging) return;
    seekDragging = false;
    seek.classList.remove('dragging');
    const ms = Math.floor(seekRatio(e) * duration());
    if (playback) { playback.progressMs = ms; playback.fetchedAt = Date.now(); }
    handleControlError(await api.playbackSeek(ms));
  });
}

async function init() {
  wireButtons();
  const st = await api.getState();
  applySettings(st.settings);
  setLock(st.locked);
  status = st.status; detail = st.detail || '';
  canControl = !!st.canControl;
  if (st.track) renderTrack(st.track);
  renderLyrics(st.lyrics);
  playback = st.playback;
  updatePlayIcon();
  renderState();
  updateTransport();

  api.onSettingsChanged((s) => applySettings(s));
  api.onTrack(({ track: t }) => renderTrack(t));
  api.onLyrics(({ lyrics: ly }) => { renderLyrics(ly); renderState(); });
  api.onPlayback((p) => { playback = p; updatePlayIcon(); });
  api.onStatus(({ status: s, detail: d }) => {
    status = s; detail = d || '';
    if (s === 'idle' || s === 'unauthed' || s === 'error') { renderTrack(null); lyrics = null; clearLines(); }
    renderState();
    updateTransport();
  });
  api.onLockChanged(({ locked: l }) => setLock(l));
  api.onHover(({ hovered }) => $('root').classList.toggle('hovered', hovered));
  api.onAuthChanged((info) => {
    if (info && typeof info.canControl === 'boolean') { canControl = info.canControl; updateTransport(); }
  });

  window.addEventListener('resize', () => updateScroll(true));
  requestAnimationFrame(loop);
}

init();
