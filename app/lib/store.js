// Persistence: settings JSON, encrypted refresh token, and a lyrics cache.
// Everything lives under app.getPath('userData'). Built-ins only (fs + safeStorage).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // --- Appearance ---
  theme: 'dark',            // dark | light | amoled | custom
  textColor: '#9aa0a6',     // inactive lines
  activeColor: '#ffffff',   // active line
  accentColor: '#1db954',   // accents (Spotify green)
  bgColor: '#0a0a0a',       // tint over the blurred album art
  bgOpacity: 0.55,          // 0..1 tint strength (art / solid modes)
  artBlur: 28,              // px blur of the album-art backdrop
  backdrop: 'art',          // art | solid | clear (see-through)
  shadeOpacity: 0.12,       // grey shade strength in clear mode (minimal by default)
  textShadow: true,         // readability shadow on lyric text
  fontFamily: 'Segoe UI',
  fontSize: 24,             // px, active-line baseline
  fontWeight: 700,
  lineSpacing: 1.5,
  textAlign: 'center',      // left | center
  activeScale: 1.06,        // extra scale applied to the active line
  glow: false,              // soft glow on the active line

  // --- Layout ---
  showAlbumArt: true,
  showHeader: true,         // title + artist row
  compact: false,           // hide header, lyrics-only
  cornerRadius: 16,
  showControls: true,       // bottom playback transport bar
  showInTaskbar: true,      // show a taskbar button (reliable minimize/restore)

  // --- Behavior ---
  startLocked: false,       // begin in click-through (locked) mode
  autoHidePaused: false,
  autoHideNoLyrics: false,
  lyricOffsetMs: 0,         // manual sync nudge
  alwaysOnTop: true,
  startWithWindows: false,

  // --- Window ---
  bounds: { width: 440, height: 560, x: null, y: null },

  // --- Hotkeys (Electron accelerators) ---
  hotkeys: {
    toggleLock: 'Alt+Shift+L',
    toggleShow: 'Alt+Shift+H',
    offsetMinus: 'Alt+Shift+Left',
    offsetPlus: 'Alt+Shift+Right'
  },

  // --- Account / lyrics ---
  spotifyClientId: '',
  lyricsUserAgent: 'SpotifyLyricsOverlay/1.0 (personal, no-npm build)',

  // --- User-saved presets (max 5): [{ name, values: { ...settings } }] ---
  presets: []
};

function userFile(name) {
  return path.join(app.getPath('userData'), name);
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(override || {})) {
    if (isObject(out[k]) && isObject(override[k])) out[k] = deepMerge(out[k], override[k]);
    else out[k] = override[k];
  }
  return out;
}

function getSettings() {
  try {
    const raw = fs.readFileSync(userFile('settings.json'), 'utf8');
    return deepMerge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(userFile('settings.json'), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('saveSettings failed:', e);
  }
}

// Merge a partial patch into current settings and persist.
function setSettings(partial) {
  const next = deepMerge(getSettings(), partial || {});
  saveSettings(next);
  return next;
}

// --- Refresh token (encrypted at rest via safeStorage / Windows DPAPI) ---
function saveRefreshToken(token) {
  let payload;
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    payload = { enc: true, data: safeStorage.encryptString(token).toString('base64') };
  } else {
    // Fallback: obfuscated only. Logged so the user knows encryption was unavailable.
    console.warn('safeStorage unavailable; storing refresh token without OS encryption.');
    payload = { enc: false, data: Buffer.from(token, 'utf8').toString('base64') };
  }
  try { fs.writeFileSync(userFile('tokens.json'), JSON.stringify(payload)); }
  catch (e) { console.error('saveRefreshToken failed:', e); }
}

function loadRefreshToken() {
  try {
    const p = JSON.parse(fs.readFileSync(userFile('tokens.json'), 'utf8'));
    if (p.enc) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(p.data, 'base64'));
    }
    return Buffer.from(p.data, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function clearTokens() {
  try { fs.unlinkSync(userFile('tokens.json')); } catch {}
}

// --- Lyrics cache (keyed by Spotify track id) ---
function loadLyricsCache() {
  try { return JSON.parse(fs.readFileSync(userFile('lyrics-cache.json'), 'utf8')); }
  catch { return {}; }
}

function saveLyricsCache(obj) {
  try { fs.writeFileSync(userFile('lyrics-cache.json'), JSON.stringify(obj)); }
  catch (e) { console.error('saveLyricsCache failed:', e); }
}

module.exports = {
  DEFAULTS, userFile,
  getSettings, saveSettings, setSettings,
  saveRefreshToken, loadRefreshToken, clearTokens,
  loadLyricsCache, saveLyricsCache
};
