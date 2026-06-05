// LRCLIB lyrics: fetch by metadata, fall back to search, parse LRC, cache by track id.
// Free, no API key. https://lrclib.net/docs
const store = require('./store');

const BASE = 'https://lrclib.net/api';
let cache = null;

function ensureCache() {
  if (!cache) cache = store.loadLyricsCache() || {};
  return cache;
}

// Strip noise that hurts matching: "(feat. X)", "- Remastered 2011", "[Live]", etc.
function normalize(s) {
  if (!s) return '';
  return String(s)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s-\s.*$/i, ' ')
    .replace(/\bfeat\.?\b.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse LRC text into a sorted [{ timeMs, text }]. Handles multiple stamps per
// line and strips enhanced word-level <mm:ss.xx> markers (kept simple for v1).
function parseLRC(text) {
  const out = [];
  const stampRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of String(text).split(/\r?\n/)) {
    stampRe.lastIndex = 0;
    const stamps = [];
    let m, end = 0;
    while ((m = stampRe.exec(line))) {
      const mm = +m[1], ss = +m[2];
      const frac = m[3] ? parseFloat('0.' + m[3]) : 0;
      stamps.push((mm * 60 + ss) * 1000 + Math.round(frac * 1000));
      end = stampRe.lastIndex;
    }
    if (!stamps.length) continue; // skip metadata-only lines ([ti:], [ar:], ...)
    const lyric = line.slice(end).replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const t of stamps) out.push({ timeMs: t, text: lyric });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

function toResult(rec) {
  if (!rec) return { state: 'none', lines: [], plain: '' };
  if (rec.instrumental) return { state: 'instrumental', lines: [], plain: '' };
  if (rec.syncedLyrics) {
    const lines = parseLRC(rec.syncedLyrics);
    if (lines.length) return { state: 'synced', lines, plain: rec.plainLyrics || '' };
  }
  if (rec.plainLyrics) return { state: 'plain', lines: [], plain: rec.plainLyrics };
  return { state: 'none', lines: [], plain: '' };
}

async function apiGet(params, ua) {
  try {
    const r = await fetch(`${BASE}/get?` + new URLSearchParams(params).toString(), {
      headers: { 'User-Agent': ua }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function apiSearch(params, ua) {
  try {
    const r = await fetch(`${BASE}/search?` + new URLSearchParams(params).toString(), {
      headers: { 'User-Agent': ua }
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

// track: { id, name, artists, album, durationMs }
async function getLyrics(track, ua, opts = {}) {
  const c = ensureCache();
  if (track.id && c[track.id] && !opts.force) return c[track.id];

  const durationSec = Math.round((track.durationMs || 0) / 1000);

  // 1) Exact get by full metadata.
  let result = toResult(await apiGet({
    track_name: track.name,
    artist_name: track.artists,
    album_name: track.album || '',
    duration: String(durationSec)
  }, ua));

  // 2) Fall back to search (normalized) when there's no synced match.
  if (result.state === 'none' || result.state === 'plain') {
    const cands = await apiSearch({
      track_name: normalize(track.name),
      artist_name: normalize(track.artists)
    }, ua);
    const synced = cands.filter(x => x.syncedLyrics);
    if (synced.length) {
      synced.sort((a, b) =>
        Math.abs((a.duration || 0) - durationSec) - Math.abs((b.duration || 0) - durationSec));
      const better = toResult(synced[0]);
      if (better.state === 'synced') result = better;
    } else if (result.state === 'none') {
      const plain = cands.find(x => x.plainLyrics);
      if (plain) result = toResult(plain);
    }
  }

  if (track.id) {
    c[track.id] = result;
    // Keep the cache from growing without bound.
    const keys = Object.keys(c);
    if (keys.length > 400) delete c[keys[0]];
    store.saveLyricsCache(c);
  }
  return result;
}

module.exports = { getLyrics, parseLRC, normalize };
