// The only bridge between renderer and main. contextIsolation stays on; the
// renderer never sees ipcRenderer or Node directly, only these wrapped calls.
const { contextBridge, ipcRenderer } = require('electron');

function sub(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('lyricsAPI', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  resetKeys: (keys) => ipcRenderer.invoke('settings:resetKeys', keys),
  getDefaults: () => ipcRenderer.invoke('settings:getDefaults'),
  onSettingsChanged: (cb) => sub('settings:changed', cb),

  // auth
  startAuth: () => ipcRenderer.invoke('auth:start'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getAuthStatus: () => ipcRenderer.invoke('auth:status'),
  onAuthChanged: (cb) => sub('auth:changed', cb),

  // current state (for windows that open late)
  getState: () => ipcRenderer.invoke('app:getState'),
  onTrack: (cb) => sub('overlay:track', cb),
  onLyrics: (cb) => sub('overlay:lyrics', cb),
  onPlayback: (cb) => sub('overlay:playback', cb),
  onStatus: (cb) => sub('overlay:status', cb),
  onLockChanged: (cb) => sub('overlay:lock', cb),
  onHover: (cb) => sub('overlay:hover', cb),
  onOpenSettings: (cb) => sub('overlay:openSettings', cb),

  // actions
  researchLyrics: () => ipcRenderer.invoke('lyrics:research'),
  playbackToggle: () => ipcRenderer.invoke('playback:toggle'),
  playbackNext: () => ipcRenderer.invoke('playback:next'),
  playbackPrev: () => ipcRenderer.invoke('playback:previous'),
  playbackSeek: (ms) => ipcRenderer.invoke('playback:seek', ms),
  setLocked: (locked) => ipcRenderer.invoke('window:setLocked', locked),
  toggleLocked: () => ipcRenderer.invoke('window:toggleLocked'),
  openSettings: () => ipcRenderer.invoke('window:openSettings'),
  hideOverlay: () => ipcRenderer.invoke('window:hideOverlay'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  pauseTopmost: (p) => ipcRenderer.invoke('window:topmost-pause', p),
  quit: () => ipcRenderer.invoke('app:quit'),

  // platform info (read-only)
  fonts: () => ipcRenderer.invoke('app:fonts'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url)
});
