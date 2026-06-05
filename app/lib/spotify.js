// Spotify Web API controller: PKCE auth (no client secret), token refresh,
// and reading the currently-playing track. All network is in the main process.
const http = require('http');
const { shell } = require('electron');
const pkce = require('./pkce');

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

function html(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#121212;color:#fff;margin:0;height:100vh;display:flex;align-items:center;justify-content:center">
<div style="text-align:center"><h2 style="color:#1db954">${title}</h2><p>${body}</p></div></body></html>`;
}

class SpotifyController {
  constructor({ clientId = '', refreshToken = null } = {}) {
    this.clientId = clientId;
    this.refreshToken = refreshToken;
    this.accessToken = null;
    this.expiresAt = 0;
    this.grantedScopes = null;
    this._server = null;
    // Called with the new refresh token whenever it changes, so main can persist it.
    this.onRefreshToken = null;
  }

  setClientId(id) { this.clientId = id || ''; }
  isAuthed() { return !!this.refreshToken; }
  hasScope(scope) { return !!this.grantedScopes && this.grantedScopes.split(' ').includes(scope); }

  logout() {
    this.refreshToken = null;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  // Full interactive auth: open browser, capture the loopback redirect, exchange code.
  async beginAuth() {
    if (!this.clientId) throw new Error('Set your Spotify Client ID first.');
    const verifier = pkce.createVerifier();
    const challenge = pkce.challengeFromVerifier(verifier);
    const state = pkce.randomState();
    const url = `${AUTH_URL}?` + new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state
    }).toString();

    const code = await this._waitForCode(url, state);
    await this._exchangeCode(code, verifier);
    return true;
  }

  _waitForCode(authUrl, expectedState) {
    return new Promise((resolve, reject) => {
      if (this._server) { try { this._server.close(); } catch {} this._server = null; }

      const server = http.createServer((req, res) => {
        let u;
        try { u = new URL(req.url, REDIRECT_URI); } catch { res.writeHead(400); return res.end(); }
        if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }

        const error = u.searchParams.get('error');
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(error
          ? html('Authorization failed', 'You can close this tab and try again in the app.')
          : html('Connected to Spotify', 'You can close this tab and return to the app.'));

        cleanup();
        if (error) return reject(new Error('Spotify returned: ' + error));
        if (state !== expectedState) return reject(new Error('State mismatch (possible CSRF).'));
        if (!code) return reject(new Error('No authorization code returned.'));
        resolve(code);
      });

      const cleanup = () => {
        clearTimeout(timer);
        if (this._server === server) this._server = null;
        try { server.close(); } catch {}
      };

      server.on('error', (e) => {
        this._server = null;
        if (e && e.code === 'EADDRINUSE') {
          reject(new Error(`Port ${REDIRECT_PORT} is in use. Close whatever is using it and retry.`));
        } else reject(e);
      });

      server.listen(REDIRECT_PORT, '127.0.0.1', () => { shell.openExternal(authUrl); });
      this._server = server;
      const timer = setTimeout(() => { cleanup(); reject(new Error('Authorization timed out.')); }, 5 * 60 * 1000);
    });
  }

  async _exchangeCode(code, verifier) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: this.clientId,
      code_verifier: verifier
    });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!r.ok) throw new Error('Token exchange failed: ' + r.status + ' ' + (await r.text()));
    this._applyToken(await r.json());
  }

  async _refresh() {
    if (!this.refreshToken) throw new Error('No refresh token.');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId
    });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!r.ok) {
      // 400 usually means the refresh token was revoked; force re-auth.
      if (r.status === 400) this.logout();
      throw new Error('Token refresh failed: ' + r.status);
    }
    this._applyToken(await r.json());
  }

  _applyToken(j) {
    this.accessToken = j.access_token;
    this.expiresAt = Date.now() + ((j.expires_in || 3600) * 1000) - 60000; // refresh 1 min early
    if (j.scope) this.grantedScopes = j.scope;
    if (j.refresh_token) {
      this.refreshToken = j.refresh_token;
      if (typeof this.onRefreshToken === 'function') this.onRefreshToken(j.refresh_token);
    }
  }

  async _ensureToken() {
    if (this.accessToken && Date.now() < this.expiresAt) return;
    await this._refresh();
  }

  // Returns a normalized status object. Never throws for expected conditions.
  // states: 'unauthed' | 'idle' | 'ok' | 'ratelimited' | 'retry' | 'error'
  async getNowPlaying() {
    if (!this.isAuthed()) return { state: 'unauthed' };
    try { await this._ensureToken(); }
    catch (e) { return { state: this.isAuthed() ? 'error' : 'unauthed', error: String(e.message || e) }; }

    let r;
    try {
      r = await fetch(`${API}/me/player/currently-playing`, {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
    } catch (e) {
      return { state: 'error', error: 'Network: ' + String(e.message || e) };
    }

    if (r.status === 204) return { state: 'idle' };       // nothing playing
    if (r.status === 401) { try { await this._refresh(); } catch {} return { state: 'retry' }; }
    if (r.status === 429) {
      const ra = parseInt(r.headers.get('retry-after') || '1', 10);
      return { state: 'ratelimited', retryAfter: Number.isFinite(ra) ? ra : 1 };
    }
    if (!r.ok) return { state: 'error', error: 'HTTP ' + r.status };

    let j;
    try { j = await r.json(); } catch { return { state: 'idle' }; }
    if (!j || !j.item) return { state: 'idle' };
    if (j.currently_playing_type && j.currently_playing_type !== 'track') {
      return { state: 'idle', nonTrack: j.currently_playing_type };
    }

    const it = j.item;
    const images = (it.album && it.album.images) || [];
    return {
      state: 'ok',
      playing: !!j.is_playing,
      progressMs: j.progress_ms || 0,
      fetchedAt: Date.now(),
      track: {
        id: it.id,
        name: it.name,
        artists: (it.artists || []).map(a => a.name).join(', '),
        album: it.album ? it.album.name : '',
        durationMs: it.duration_ms || 0,
        artUrl: images.length ? images[0].url : null,
        artUrlSmall: images.length ? (images[images.length - 1].url) : null
      }
    };
  }

  // --- Playback control (requires user-modify-playback-state) ---
  async _send(method, path) {
    if (!this.isAuthed()) return { ok: false, reason: 'unauthed' };
    try { await this._ensureToken(); }
    catch { return { ok: false, reason: 'auth' }; }
    if (!this.hasScope('user-modify-playback-state')) return { ok: false, reason: 'scope' };

    const call = () => fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${this.accessToken}` } });
    let r;
    try { r = await call(); } catch { return { ok: false, reason: 'network' }; }
    if (r.status === 401) { try { await this._refresh(); r = await call(); } catch {} }
    if (r.status === 404) return { ok: false, reason: 'nodevice' };   // no active device
    if (r.status === 403) return { ok: false, reason: 'forbidden' };
    if (r.status === 429) {
      const ra = parseInt(r.headers.get('retry-after') || '1', 10);
      return { ok: false, reason: 'ratelimited', retryAfter: Number.isFinite(ra) ? ra : 1 };
    }
    if (!r.ok) return { ok: false, reason: 'http_' + r.status };
    return { ok: true };
  }

  pause()    { return this._send('PUT',  '/me/player/pause'); }
  resume()   { return this._send('PUT',  '/me/player/play'); }
  next()     { return this._send('POST', '/me/player/next'); }
  previous() { return this._send('POST', '/me/player/previous'); }
  seek(ms)   { return this._send('PUT',  `/me/player/seek?position_ms=${Math.max(0, Math.floor(ms))}`); }
}

module.exports = { SpotifyController, REDIRECT_URI, REDIRECT_PORT, SCOPES };
