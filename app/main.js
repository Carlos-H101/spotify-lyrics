// Spotify Synced-Lyrics Overlay — main process.
// Owns windows, tray, hotkeys, the Spotify poll loop, lyric fetching, and IPC.
// Zero third-party packages: Electron + Node built-ins only.
const { app, BrowserWindow, ipcMain, globalShortcut, nativeImage, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./lib/store');
const lyricsLib = require('./lib/lyrics');
const { SpotifyController } = require('./lib/spotify');
const { makeIcon } = require('./lib/icon');

// Transparent windows + GPU compositing leave stale paint rectangles on Windows
// (e.g. after the settings panel opens/closes). Software compositing is plenty
// for a lyrics overlay and removes the artifacts. Must run before app is ready.
app.disableHardwareAcceleration();

let overlayWin = null;
let tray = null;
let spotify = null;
let settings = store.getSettings();

let pollTimer = null;
let saveBoundsTimer = null;
let topmostTimer = null;
let hoverTimer = null;
let lastHover = null;
let topmostPaused = false;   // suspend the re-assert while a native picker/dialog is open

// Cached "current" state so windows opening late can fetch it.
const state = {
  status: 'unauthed',   // unauthed | connecting | idle | ok | error
  detail: '',
  locked: !!settings.startLocked,
  track: null,
  lyrics: null,
  playback: null        // { progressMs, playing, fetchedAt, durationMs }
};

const COMMON_FONTS = [
  'Segoe UI', 'Segoe UI Variable', 'Arial', 'Calibri', 'Cambria', 'Candara',
  'Consolas', 'Constantia', 'Corbel', 'Franklin Gothic', 'Gabriola', 'Georgia',
  'Lucida Sans', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  'Comic Sans MS', 'Impact', 'Courier New'
];

// Use the user's logo (app/assets/logo.png) if present, else the generated icon.
function appIconImage(size) {
  try {
    const p = path.join(__dirname, 'assets', 'logo.png');
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img.resize({ width: size, height: size, quality: 'best' });
    }
  } catch {}
  return nativeImage.createFromBuffer(makeIcon(size, settings.accentColor || '#1db954'));
}

// ---------------------------------------------------------------- windows ----

function createOverlay() {
  const b = settings.bounds || {};
  overlayWin = new BrowserWindow({
    width: b.width || 440,
    height: b.height || 560,
    x: (b.x ?? undefined),
    y: (b.y ?? undefined),
    minWidth: 260,
    minHeight: 200,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: false,           // taskbar-only build: always keep the taskbar button (no tray)
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: !!settings.alwaysOnTop,
    show: false,
    icon: appIconImage(256),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (settings.alwaysOnTop) overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));

  // Hardening: the UI is local-only, so deny popups and block navigation away from it.
  overlayWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWin.webContents.on('will-navigate', (e) => e.preventDefault());

  overlayWin.once('ready-to-show', () => {
    overlayWin.show();
    applyLocked(state.locked, true);
  });

  const queueSaveBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!overlayWin || overlayWin.isDestroyed()) return;
      const nb = overlayWin.getBounds();
      settings = store.setSettings({ bounds: { width: nb.width, height: nb.height, x: nb.x, y: nb.y } });
    }, 500);
  };
  overlayWin.on('move', queueSaveBounds);
  overlayWin.on('resize', queueSaveBounds);
  overlayWin.on('blur', reassertTopmost);
  overlayWin.on('closed', () => { overlayWin = null; });
}

// Settings now live inside the overlay; this just reveals the overlay and tells
// the renderer to slide its settings panel open.
function openSettingsPanel() {
  if (!overlayWin) createOverlay();
  if (overlayWin.isMinimized()) overlayWin.restore();
  overlayWin.show();
  overlayWin.focus();
  overlayWin.webContents.send('overlay:openSettings');
}

// --------------------------------------------------------------- helpers -----

function sendAll(channel, payload) {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, payload);
}

function applyLocked(locked, silent) {
  state.locked = locked;
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(locked, { forward: true });
  }
  if (!silent) sendAll('overlay:lock', { locked });
  buildTray();
}

function applyOverlaySettings() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setAlwaysOnTop(!!settings.alwaysOnTop, settings.alwaysOnTop ? 'screen-saver' : 'normal');
  }
}

// Re-assert top-most so games and other apps can't bury the overlay. Exclusive
// fullscreen still wins (it bypasses the compositor), but borderless and
// fullscreen-optimized games stay covered.
function reassertTopmost() {
  if (!overlayWin || overlayWin.isDestroyed() || !settings.alwaysOnTop || topmostPaused) return;
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.moveTop();
}

function applyLoginItem() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.startWithWindows,
      path: process.execPath,
      args: [app.getAppPath()]
    });
  } catch (e) { console.error('setLoginItemSettings failed:', e); }
}

// ------------------------------------------------------------- hotkeys -------

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = settings.hotkeys || {};
  const tryReg = (accel, fn) => {
    if (!accel) return;
    try { if (!globalShortcut.register(accel, fn)) console.warn('Hotkey unavailable:', accel); }
    catch (e) { console.warn('Hotkey failed:', accel, e.message); }
  };
  tryReg(hk.toggleLock, () => applyLocked(!state.locked));
  tryReg(hk.toggleShow, toggleOverlayVisible);
  tryReg(hk.offsetMinus, () => nudgeOffset(-250));
  tryReg(hk.offsetPlus, () => nudgeOffset(250));
}

function nudgeOffset(delta) {
  const next = (settings.lyricOffsetMs || 0) + delta;
  settings = store.setSettings({ lyricOffsetMs: next });
  sendAll('settings:changed', settings);
}

function toggleOverlayVisible() {
  if (!overlayWin) return createOverlay();
  if (overlayWin.isVisible()) overlayWin.hide();
  else overlayWin.show();
}

// --------------------------------------------------------------- tray --------
// Taskbar-only build: no system-tray icon. Every action (settings, lock, quit)
// lives on the overlay itself, so this is intentionally a no-op.
function buildTray() {}

// Reveal the controls only when the cursor is actually over the window. CSS
// :hover can get stuck "on" for transparent always-on-top windows (the
// mouse-leave event doesn't fire when you move to another app), so we drive a
// `.hovered` class from the real cursor position instead.
function pollHover() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = overlayWin.getBounds();
  const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (inside !== lastHover) {
    lastHover = inside;
    sendAll('overlay:hover', { hovered: inside });
  }
}

// ------------------------------------------------------------ poll loop ------

function pollSoon(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollOnce, ms);
}

function currentCanControl() {
  return spotify.isAuthed() && spotify.hasScope('user-modify-playback-state');
}

let lastCanControl = null;

function scheduleNext(np) {
  let delay = 3000;
  if (np && np.state === 'ratelimited') delay = ((np.retryAfter || 1) * 1000) + 250;
  else if (np && (np.state === 'unauthed' || np.state === 'idle' || np.state === 'error')) delay = 4000;
  else if (np && np.state === 'retry') delay = 600;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollOnce, delay);
}

async function pollOnce() {
  let np;
  try { np = await spotify.getNowPlaying(); }
  catch (e) { np = { state: 'error', error: String(e.message || e) }; }
  scheduleNext(np);
  await handleNowPlaying(np);

  const cc = currentCanControl();
  if (cc !== lastCanControl) {
    lastCanControl = cc;
    sendAll('auth:changed', { authed: spotify.isAuthed(), canControl: cc });
  }
}

async function handleNowPlaying(np) {
  if (np.state === 'ok') {
    const changed = !state.track || state.track.id !== np.track.id;
    if (state.status !== 'ok') { state.status = 'ok'; sendAll('overlay:status', { status: 'ok' }); }

    if (changed) {
      state.track = np.track;
      state.lyrics = { state: 'loading' };
      sendAll('overlay:track', { track: np.track });
      sendAll('overlay:lyrics', { trackId: np.track.id, lyrics: state.lyrics });

      const lyr = await lyricsLib.getLyrics(np.track, settings.lyricsUserAgent).catch(() => ({ state: 'none', lines: [] }));
      // Only apply if the track hasn't changed again while we were fetching.
      if (state.track && state.track.id === np.track.id) {
        state.lyrics = lyr;
        sendAll('overlay:lyrics', { trackId: np.track.id, lyrics: lyr });
      }
    }

    state.playback = {
      progressMs: np.progressMs,
      playing: np.playing,
      fetchedAt: np.fetchedAt,
      durationMs: np.track.durationMs
    };
    sendAll('overlay:playback', state.playback);
  } else if (np.state === 'retry' || np.state === 'ratelimited') {
    // transient; keep showing whatever we have
  } else {
    if (state.status !== np.state) {
      state.status = np.state;
      state.detail = np.error || '';
      state.track = null;
      state.lyrics = null;
      state.playback = null;
      sendAll('overlay:status', { status: np.state, detail: state.detail });
    }
  }
}

// --------------------------------------------------------------- auth --------

async function startAuth() {
  if (!settings.spotifyClientId) {
    openSettingsPanel();
    throw new Error('Set your Spotify Client ID in Settings first.');
  }
  state.status = 'connecting';
  sendAll('overlay:status', { status: 'connecting' });
  sendAll('auth:changed', { authed: false, connecting: true });
  spotify.setClientId(settings.spotifyClientId);
  await spotify.beginAuth();
  if (spotify.refreshToken) store.saveRefreshToken(spotify.refreshToken);
  sendAll('auth:changed', { authed: true, connecting: false });
  buildTray();
  clearTimeout(pollTimer);
  pollOnce();
}

// --------------------------------------------------------------- ipc ---------

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:set', (_e, patch) => {
    settings = store.setSettings(patch || {});
    if (patch && 'spotifyClientId' in patch) spotify.setClientId(settings.spotifyClientId);
    if (patch && 'alwaysOnTop' in patch) applyOverlaySettings();
    if (patch && 'startWithWindows' in patch) applyLoginItem();
    if (patch && 'hotkeys' in patch) registerHotkeys();
    if (patch && 'accentColor' in patch && tray) tray.setImage(appIconImage(32));
    sendAll('settings:changed', settings);
    return settings;
  });

  ipcMain.handle('settings:reset', () => {
    settings = structuredClone(store.DEFAULTS);
    settings.spotifyClientId = store.getSettings().spotifyClientId; // keep client id
    store.saveSettings(settings);
    applyOverlaySettings(); registerHotkeys();
    sendAll('settings:changed', settings);
    return settings;
  });

  ipcMain.handle('settings:resetKeys', (_e, keys) => {
    if (Array.isArray(keys)) {
      const patch = {};
      for (const k of keys) if (k in store.DEFAULTS) patch[k] = structuredClone(store.DEFAULTS[k]);
      settings = store.setSettings(patch);
      if ('alwaysOnTop' in patch) applyOverlaySettings();
      if ('startWithWindows' in patch) applyLoginItem();
      if ('hotkeys' in patch) registerHotkeys();
      if ('accentColor' in patch && tray) tray.setImage(appIconImage(32));
      sendAll('settings:changed', settings);
    }
    return settings;
  });

  ipcMain.handle('settings:getDefaults', () => store.DEFAULTS);

  ipcMain.handle('auth:start', async () => {
    try { await startAuth(); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  ipcMain.handle('auth:logout', () => {
    spotify.logout();
    store.clearTokens();
    state.status = 'unauthed'; state.track = null; state.lyrics = null; state.playback = null;
    sendAll('auth:changed', { authed: false, connecting: false });
    sendAll('overlay:status', { status: 'unauthed' });
    buildTray();
    return { ok: true };
  });

  ipcMain.handle('auth:status', () => ({ authed: spotify.isAuthed(), clientId: !!settings.spotifyClientId, canControl: currentCanControl() }));

  ipcMain.handle('app:getState', () => ({
    status: state.status, detail: state.detail, locked: state.locked,
    track: state.track, lyrics: state.lyrics, playback: state.playback,
    authed: spotify.isAuthed(), canControl: currentCanControl(), settings
  }));

  ipcMain.handle('lyrics:research', async () => {
    if (!state.track) return { ok: false };
    const lyr = await lyricsLib.getLyrics(state.track, settings.lyricsUserAgent, { force: true })
      .catch(() => ({ state: 'none', lines: [] }));
    state.lyrics = lyr;
    sendAll('overlay:lyrics', { trackId: state.track.id, lyrics: lyr });
    return { ok: true, state: lyr.state };
  });

  ipcMain.handle('playback:toggle', async () => {
    const playing = !!(state.playback && state.playback.playing);
    const res = playing ? await spotify.pause() : await spotify.resume();
    if (res.ok && state.playback) {
      state.playback.playing = !playing;            // optimistic
      state.playback.fetchedAt = Date.now();
      sendAll('overlay:playback', state.playback);
    }
    pollSoon(350);
    return res;
  });
  ipcMain.handle('playback:next', async () => { const r = await spotify.next(); pollSoon(450); return r; });
  ipcMain.handle('playback:previous', async () => { const r = await spotify.previous(); pollSoon(450); return r; });
  ipcMain.handle('playback:seek', async (_e, ms) => {
    const r = await spotify.seek(ms);
    if (r.ok && state.playback) {
      state.playback.progressMs = Math.max(0, Math.floor(ms));
      state.playback.fetchedAt = Date.now();
      sendAll('overlay:playback', state.playback);
    }
    pollSoon(350);
    return r;
  });

  ipcMain.handle('window:setLocked', (_e, locked) => { applyLocked(!!locked); return state.locked; });
  ipcMain.handle('window:toggleLocked', () => { applyLocked(!state.locked); return state.locked; });
  ipcMain.handle('window:openSettings', () => { openSettingsPanel(); });
  ipcMain.handle('window:hideOverlay', () => { if (overlayWin) overlayWin.hide(); buildTray(); });
  ipcMain.handle('window:minimize', () => { if (overlayWin) overlayWin.minimize(); });
  // Pause the top-most re-assert while settings is open, so native color / select
  // popups aren't yanked closed by moveTop().
  ipcMain.handle('window:topmost-pause', (_e, paused) => {
    topmostPaused = !!paused;
    if (!topmostPaused) reassertTopmost();
  });
  ipcMain.handle('app:quit', () => { app.quit(); });
  ipcMain.handle('app:fonts', () => COMMON_FONTS);
  ipcMain.handle('app:openExternal', (_e, url) => {
    const ok = typeof url === 'string' && /^https:\/\//i.test(url);
    if (ok) shell.openExternal(url);
    return ok;
  });
}

// ------------------------------------------------------------ lifecycle ------

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!overlayWin) return;
    if (overlayWin.isMinimized()) overlayWin.restore();
    overlayWin.show();
    overlayWin.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.carlosh101.spotifylyrics'); // one clean taskbar identity

    spotify = new SpotifyController({
      clientId: settings.spotifyClientId,
      refreshToken: store.loadRefreshToken()
    });
    spotify.onRefreshToken = (t) => store.saveRefreshToken(t);

    registerIpc();
    createOverlay();
    registerHotkeys();
    applyLoginItem();
    topmostTimer = setInterval(reassertTopmost, 1500);
    hoverTimer = setInterval(pollHover, 150);

    state.status = spotify.isAuthed() ? 'idle' : 'unauthed';
    pollOnce();

    app.on('activate', () => { if (!overlayWin) createOverlay(); });
  });

  // Taskbar-only: there is no tray to live in, so closing the window quits the app.
  app.on('window-all-closed', () => app.quit());

  app.on('will-quit', () => { clearInterval(topmostTimer); clearInterval(hoverTimer); globalShortcut.unregisterAll(); });
}
