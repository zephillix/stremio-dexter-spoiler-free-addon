'use strict';
/*
 * Dexter spoiler-free thumbnails - Stremio metadata addon
 *
 * It answers Stremio's "meta" request for the Dexter shows by taking Cinemeta's normal metadata
 * and swapping every episode thumbnail for the spoiler-free TMDB still you picked.
 * Which still that is gets worked out by comparing TMDB's stills with the small fingerprints in
 * fingerprints.json (made from your screenshots). Results are saved in matches.json.
 *
 * Episodes that are covered but not matched yet get NO thumbnail (never the spoiler one).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 7000;
let TMDB_KEY = process.env.TMDB_KEY || '';
if (!TMDB_KEY) { try { TMDB_KEY = fs.readFileSync(path.join(__dirname, 'tmdb_key.txt'), 'utf8').trim(); } catch (e) { /* none */ } }
const CINEMETA = 'https://v3-cinemeta.strem.io';
const MATCH_FILE = process.env.MATCH_FILE || path.join(__dirname, 'matches.json');
const IMG = 'https://image.tmdb.org/t/p/';

// tmdbId -> season -> episode -> [base64 32x18 greyscale, validCols, skippedTopRows]
const FP = JSON.parse(fs.readFileSync(path.join(__dirname, 'fingerprints.json'), 'utf8'));

// IMDb ids we know up front (the rest are looked up from TMDB at start-up)
const imdbToTmdb = new Map([['tt0773262', '1405'], ['tt14164730', '131927']]);

const OWN_PREFIX = 'dxs:';   // ids like dxs:tt0773262 are only ever answered by this addon
const GW = 32, GH = 18, MIN_R = 0.55, GOOD_R = 0.92, MAX_CANDIDATES = 60;

let matches = {};
try { matches = JSON.parse(fs.readFileSync(MATCH_FILE, 'utf8')); } catch (e) { matches = {}; }
const saveMatches = () => { try { fs.writeFileSync(MATCH_FILE, JSON.stringify(matches)); } catch (e) { console.warn('could not save matches:', e.message); } };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- TMDB ----------
const tmdb = async p => {
  try {
    const r = await fetch(`https://api.themoviedb.org/3${p}${p.includes('?') ? '&' : '?'}api_key=${TMDB_KEY}`);
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
};

const resolveImdbIds = async () => {
  for (const tmdbId of Object.keys(FP)) {
    const d = await tmdb(`/tv/${tmdbId}/external_ids`);
    if (d && d.imdb_id) imdbToTmdb.set(d.imdb_id, tmdbId);
  }
  log('serving metadata for', [...imdbToTmdb.entries()].map(([i, t]) => `${i} (tmdb ${t})`).join(', '));
};

// ---------- fingerprint matching ----------
const decode = b64 => Float32Array.from(Buffer.from(b64, 'base64'));

const maskFor = (cols, rows) => {
  const m = new Uint8Array(GW * GH).fill(1);
  const clear = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * GW + x] = 0; };
  clear(0, 6, 0, 3); clear(26, 32, 0, 4); clear(24, 32, 13, 18); clear(0, 32, 17, 18);
  clear(cols, 32, 0, 18); clear(0, 32, 0, rows);
  return m;
};

const corr = (a, b, m) => {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) { n++; sa += a[i]; sb += b[i]; }
  if (!n) return 0;
  sa /= n; sb /= n;
  let saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) { const x = a[i] - sa, y = b[i] - sb; saa += x * x; sbb += y * y; sab += x * y; }
  const d = Math.sqrt(saa * sbb);
  return d > 0 ? sab / d : 0;
};

let jpeg = null;
const jpegFingerprint = buf => {
  if (!jpeg) jpeg = require('jpeg-js');
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 });
  const A = 290 / 160;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (sw / sh < A) { sh = sw / A; sy = (img.height - sh) / 2; } else { sw = sh * A; sx = (img.width - sw) / 2; }
  const out = new Float32Array(GW * GH), N = 8;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let s = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const px = Math.min(img.width - 1, Math.floor(sx + (x + (i + 0.5) / N) * sw / GW));
      const py = Math.min(img.height - 1, Math.floor(sy + (y + (j + 0.5) / N) * sh / GH));
      const p = (py * img.width + px) * 4;
      s += 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
    }
    out[y * GW + x] = s / (N * N);
  }
  return out;
};

const stillFingerprint = async file => {
  try {
    const r = await fetch(`${IMG}w300${file}`);
    if (!r.ok) return null;
    return jpegFingerprint(Buffer.from(await r.arrayBuffer()));
  } catch (e) { return null; }
};

const matchEpisode = async (show, season, ep) => {
  const ref = FP[show][season][ep];
  const refFp = decode(ref[0]), mask = maskFor(ref[1], ref[2]);
  const base = `/tv/${show}/season/${season}/episode/${ep}`;
  const imgs = await tmdb(`${base}/images?include_image_language=null,en`);
  let files = ((imgs && imgs.stills) || []).map(s => s.file_path);
  if (!files.length) { const d = await tmdb(base); if (d && d.still_path) files = [d.still_path]; }
  files = [...new Set(files)].slice(0, MAX_CANDIDATES);
  let best = { r: -1, file: null };
  for (let i = 0; i < files.length; i += 6) {
    const chunk = files.slice(i, i + 6);
    const fps = await Promise.all(chunk.map(stillFingerprint));
    fps.forEach((f, j) => { if (f) { const r = corr(refFp, f, mask); if (r > best.r) best = { r, file: chunk[j] }; } });
    if (best.r >= GOOD_R) break;
  }
  return best.file && best.r >= MIN_R ? best : null;
};

const recent = [];
let warming = null;
const warmUp = () => {
  if (warming) return warming;
  warming = (async () => {
    try { require('jpeg-js'); } catch (e) { log('jpeg-js is not installed - run "npm install". Matching is disabled.'); return; }
    let done = 0, failed = 0;
    for (const show of Object.keys(FP)) for (const season of Object.keys(FP[show])) for (const ep of Object.keys(FP[show][season])) {
      const k = `${show}_${season}_${ep}`;
      if (matches[k]) continue;
      const hit = await matchEpisode(show, season, ep);
      if (hit) { matches[k] = hit.file; done++; saveMatches(); } else { failed++; log('no confident match for', k); }
    }
    log(`matching finished: ${done} new, ${failed} not found`);
  })().finally(() => { warming = null; });
  return warming;
};

// ---------- Cinemeta + patching ----------
const metaCache = new Map();
const cinemeta = async id => {
  const c = metaCache.get(id);
  if (c && Date.now() - c.t < 6 * 3600e3) return c.meta;
  const r = await fetch(`${CINEMETA}/meta/series/${id}.json`);
  if (!r.ok) return null;
  const meta = (await r.json()).meta;
  if (meta) metaCache.set(id, { t: Date.now(), meta });
  return meta;
};

const patch = (meta, tmdbId) => {
  const copy = JSON.parse(JSON.stringify(meta));
  let pending = 0;
  (copy.videos || []).forEach(v => {
    const covered = FP[tmdbId] && FP[tmdbId][v.season] && FP[tmdbId][v.season][v.episode];
    if (!covered) return;                                   // not in your list: leave as Cinemeta has it
    const file = matches[`${tmdbId}_${v.season}_${v.episode}`];
    if (file) v.thumbnail = `${IMG}w500${file}`;
    else { delete v.thumbnail; pending++; }                 // never fall back to the spoiler image
  });
  return { meta: copy, pending };
};

// ---------- HTTP ----------
const send = (res, code, body, extra = {}) => {
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*'
  }, extra));
  res.end(JSON.stringify(body));
};

const manifest = () => ({
  id: 'community.dexter.spoilerfree',
  version: '1.2.0',
  name: 'Dexter Spoiler-Free Thumbnails',
  description: 'Replaces spoiler-ish episode thumbnails for Dexter, New Blood, Original Sin and Resurrection. Open them from the "Dexter (Spoiler-Free)" catalog. This product uses the TMDB API but is not endorsed or certified by TMDB.',
  resources: ['catalog', 'meta'],
  types: ['series'],
  idPrefixes: [...imdbToTmdb.keys(), OWN_PREFIX],
  catalogs: [{ type: 'series', id: 'dexter-spoilerfree', name: 'Dexter (Spoiler-Free)', extra: [{ name: 'search', isRequired: false }] }]
});

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    if (p === '/health') return send(res, 200, { ok: true });
    if (p === '/manifest.json') return send(res, 200, manifest());

    if (p === '/') {
      const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
      const proto = req.headers['x-forwarded-proto'] || (/^(127\.|localhost)/.test(host) ? 'http' : 'https');
      const manifestUrl = `${proto}://${host}/manifest.json`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dexter Spoiler-Free Thumbnails - Stremio addon</title>
<style>body{font-family:system-ui,sans-serif;background:#141211;color:#eee;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.55}
a.btn{display:inline-block;margin:6px 8px 6px 0;padding:11px 18px;border-radius:10px;background:#3ecf8e;color:#06281a;font-weight:700;text-decoration:none}
a.btn.alt{background:#2b2826;color:#fff}code{background:#2b2826;padding:2px 6px;border-radius:5px}small{color:#a8a29e}</style></head><body>
<h1>Dexter Spoiler-Free Thumbnails</h1>
<p>A Stremio addon that replaces the spoiler-ish episode thumbnails for Dexter, Dexter: New Blood, Dexter: Original Sin and Dexter: Resurrection.</p>
<p><a class="btn" href="stremio://${host}/manifest.json">Install in Stremio</a>
<a class="btn alt" href="https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}">Install in Stremio Web</a></p>
<p>Or paste this into Stremio's Addons page:<br><code>${manifestUrl}</code></p>
<h3>Where to find the shows</h3>
<ul><li><b>Search:</b> type <code>dexter</code> (or <code>new blood</code>, <code>original sin</code>, <code>resurrection</code>) and use the <b>Dexter (Spoiler-Free)</b> results.</li>
<li><b>Discover:</b> Series, then the <b>Dexter (Spoiler-Free)</b> catalog.</li>
<li><b>Board:</b> the <b>Dexter (Spoiler-Free)</b> row, if your Stremio shows third-party catalogs there.</li></ul>
<p>Open the show from one of those, not from the normal Dexter entry. Episodes play from your own stream addons.</p>
<p><small>This product uses the TMDB API but is not endorsed or certified by TMDB.</small></p></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (p === '/status') {
      const total = Object.values(FP).reduce((n, s) => n + Object.values(s).reduce((m, e) => m + Object.keys(e).length, 0), 0);
      return send(res, 200, { matched: Object.keys(matches).length, total, matching: !!warming, shows: Object.fromEntries(imdbToTmdb), lastMetaRequests: recent });
    }

    const cat = p.match(/^\/catalog\/series\/dexter-spoilerfree(?:\/(.*))?\.json$/);
    if (cat) {
      const extra = {};
      String(cat[1] || '').split('&').forEach(kv => { const [k, ...v] = kv.split('='); if (k) extra[k] = v.join('='); });
      const tokens = String(extra.search || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const metas = [];
      for (const imdb of imdbToTmdb.keys()) {
        const cm = await cinemeta(imdb).catch(() => null);
        if (!cm) continue;
        const hay = `${cm.name} ${cm.releaseInfo || ''}`.toLowerCase();
        if (tokens.length && !tokens.every(tk => hay.includes(tk))) continue;     // search: every word must appear
        metas.push({ id: OWN_PREFIX + imdb, type: 'series', name: cm.name, poster: cm.poster, background: cm.background, releaseInfo: cm.releaseInfo });
      }
      return send(res, 200, { metas }, { 'Cache-Control': 'max-age=300' });
    }

    const m = p.match(/^\/meta\/series\/(.+)\.json$/);
    if (m) {
      const own = m[1].startsWith(OWN_PREFIX);
      const imdb = own ? m[1].slice(OWN_PREFIX.length) : m[1];
      const tmdbId = imdbToTmdb.get(imdb);
      if (!tmdbId) return send(res, 404, { err: 'not handled by this addon' });
      const meta = await cinemeta(imdb);
      if (!meta) return send(res, 404, { err: 'metadata not found' });
      const out = patch(meta, tmdbId);
      if (own) out.meta.id = OWN_PREFIX + imdb;   // episodes keep their normal tt ids, so streams still work
      const swapped = (out.meta.videos || []).filter(v => v.thumbnail && String(v.thumbnail).startsWith(IMG)).length;
      log(`meta request ${m[1]}: ${swapped} thumbnails swapped, ${out.pending} hidden (not matched yet)`);
      recent.unshift({ at: new Date().toISOString(), id: m[1], swapped, hidden: out.pending });
      recent.length = Math.min(recent.length, 10);
      return send(res, 200, { meta: out.meta }, { 'Cache-Control': out.pending ? 'max-age=60' : 'max-age=21600' });
    }
    send(res, 404, { err: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { err: 'server error' });
  }
});

if (require.main === module) {
  if (!TMDB_KEY) {
    console.error('No TMDB API key found. Set the TMDB_KEY environment variable, or put the key in a file named tmdb_key.txt next to index.js.');
    process.exit(1);
  }
  server.listen(PORT, async () => {
    log(`Addon running: http://127.0.0.1:${PORT}/manifest.json`);
    await resolveImdbIds();
    warmUp();
  });
}

module.exports = { jpegFingerprint, corr, maskFor, decode, FP };
