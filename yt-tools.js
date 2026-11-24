// yt-tools.js — locates or provisions the video download engine used by the
// Connection-toolbar YouTube feature: yt-dlp (extracts YouTube streams) plus
// ffmpeg (merges the separate 1080p video and audio tracks into one mp4).
//
// Resolution order for each tool:
//   1. AEGIS_YTDL / AEGIS_FFMPEG environment override
//   2. the AEGIS tools folder (%LOCALAPPDATA%\AEGIS\tools)
//   3. a plain .exe found on PATH
//   4. one-time download into the tools folder (with progress callbacks)
//
// ffmpeg comes from the imageio-ffmpeg wheel on PyPI (a single statically
// linked ffmpeg.exe, ~30 MB); a raw static build on GitHub is the fallback
// source. yt-dlp comes from its official GitHub release (single .exe).
//
// This file is plain Node (no Electron) so it can be exercised standalone:
//   node yt-tools.js            # provision + print the tool paths
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';

const YT_DLP_URLS = isWin
  ? ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe']
  : ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
     'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'];
// Single statically linked ffmpeg.exe (~77 MB) — used when PyPI is unreachable.
const FFMPEG_FALLBACK_URL = isWin
  ? 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64'
  : 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64';

function toolsDir() {
  if (process.env.AEGIS_TOOLS_DIR) return process.env.AEGIS_TOOLS_DIR;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'AEGIS', 'tools');
}

function exeName(base) { return isWin ? base + '.exe' : base; }

function isInDir(p, dir) {
  try { return path.dirname(path.resolve(p)) === path.resolve(dir); } catch (e) { return false; }
}

// Bare PATH scan (PATH entries are ';'-separated on Windows). Only .exe names
// are accepted on Windows so command shims (yt-dlp.cmd from pip) are skipped —
// spawn() cannot run those without a shell.
function findInPath(base) {
  const names = isWin ? [base + '.exe'] : [base, base + '.bin'];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile()) return p; } catch (e) {}
    }
  }
  return null;
}

// .part name keyed by the ORIGINAL url so two different sources can never
// splice their bytes together (redirect targets carry signed, changing URLs).
function partPath(dest, url) {
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  return dest + '.' + h + '.part';
}

// Streaming download with Range-resume: an interrupted transfer continues from
// the .part file instead of starting over (progress must survive flaky links).
// Reports {received, total, pct} at most ~6x/second. The .part file is kept on
// failure so the next attempt picks up where this one stopped.
function downloadFile(url, dest, onProgress, opts) {
  opts = opts || {};
  if (!opts.partKey) opts = Object.assign({}, opts, { partKey: url });
  const redirects = opts.redirects != null ? opts.redirects : 5;
  const stallMs = opts.stallMs || 60000;
  return new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error('too many redirects'));
    const tmp = partPath(dest, opts.partKey);
    if (opts.partKey === url) {
      // absorb a part file written before the naming scheme had url keys
      const legacy = dest + '.part';
      if (!fs.existsSync(tmp) && fs.existsSync(legacy)) { try { fs.renameSync(legacy, tmp); } catch (e) {} }
    }
    let existing = 0;
    try { if (fs.existsSync(tmp)) existing = fs.statSync(tmp).size; } catch (e) {}
    const headers = { 'User-Agent': 'AEGIS/1.0 (setup)' };
    if (existing > 0) headers.Range = 'bytes=' + existing + '-';
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers }, (res) => {
      const st = res.statusCode || 0;
      if (st >= 300 && st < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, onProgress, Object.assign({}, opts, { redirects: redirects - 1 })));
      }
      let append = false;
      if (st === 206) {
        append = true; // server honoured the range
      } else if (st === 200) {
        append = false; // full body again — start over
      } else if (st === 416 && existing > 0) {
        res.resume(); // stale/complete .part — drop it and retry clean
        try { fs.unlinkSync(tmp); } catch (e) {}
        return resolve(downloadFile(url, dest, onProgress, Object.assign({}, opts, { redirects: 5 })));
      } else {
        res.resume();
        return reject(new Error('HTTP ' + st));
      }
      let total = 0;
      if (append) {
        const cr = /bytes\s+\d+-\d+\/(\d+)/i.exec(res.headers['content-range'] || '');
        total = cr ? Number(cr[1]) : existing + Number(res.headers['content-length'] || 0);
      } else {
        total = Number(res.headers['content-length']) || 0;
      }
      let received = append ? existing : 0;
      let out;
      try { out = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' }); } catch (e) { res.resume(); return reject(e); }
      let lastTick = 0;
      res.on('data', (c) => {
        received += c.length;
        const now = Date.now();
        if (onProgress && now - lastTick >= 150) {
          lastTick = now;
          try { onProgress({ received, total, pct: total ? Math.min(100, Math.round((received / total) * 100)) : 0 }); } catch (e) {}
        }
      });
      const fail = (err) => { try { out.destroy(); } catch (e) {} reject(err); };
      res.on('error', fail);
      res.pipe(out);
      out.on('error', fail);
      out.on('finish', () => {
        try { out.close(); } catch (e) {}
        if (total && received < total) return reject(new Error('incomplete download (' + received + '/' + total + ')'));
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          fs.renameSync(tmp, dest);
        } catch (e) { return reject(e); }
        if (onProgress) { try { onProgress({ received, total, pct: 100 }); } catch (e) {} }
        resolve(dest);
      });
    });
    req.on('error', reject);
    req.setTimeout(stallMs, () => req.destroy(new Error('download stalled')));
  });
}

// Three attempts per source; attempts 2 and 3 resume the .part file.
async function downloadWithRetry(url, dest, onProgress) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try { await downloadFile(url, dest, onProgress); return dest; }
    catch (e) {
      lastErr = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

function httpGetBuffer(url, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { 'User-Agent': 'AEGIS/1.0 (setup)' } }, (res) => {
      const st = res.statusCode || 0;
      if (st >= 300 && st < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGetBuffer(new URL(res.headers.location, url).toString(), limit));
      }
      if (st !== 200) { res.resume(); return reject(new Error('HTTP ' + st)); }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > limit) { res.destroy(); return reject(new Error('response too large')); }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request stalled')));
  });
}

// Pull one file out of a zip buffer (entries stored or deflated).
function zipExtract(buf, entryRe) {
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (i >= 0 && buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (entryRe.test(name) && !name.endsWith('/')) {
      if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip: bad local header');
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('zip: unsupported compression method ' + method);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('zip: entry not found');
}

function looksLikePE(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return b[0] === 0x4d && b[1] === 0x5a; // "MZ"
  } catch (e) { return false; }
}

// Runs the tool once; a broken copy (bad download, stale system install) must
// never break the feature — it gets dropped and re-provisioned instead.
// Asynchronous ON PURPOSE: this runs inside the Electron main process, and a
// spawnSync here freezes every window (toolbars, popovers, all IPC) for as
// long as the probe takes — on a cold session that measured ~14s, which in
// turn stalled the floating download menu's 5s return by the same amount.
function verifyTool(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 20000, windowsHide: true }, (err) => resolve(!err));
    } catch (e) { resolve(false); }
  });
}

function chmodExec(p) {
  if (isWin) return;
  try { fs.chmodSync(p, 0o755); } catch (e) {}
}

async function ffmpegWheelUrl() {
  try {
    const j = JSON.parse((await httpGetBuffer('https://pypi.org/pypi/imageio-ffmpeg/json', 4 * 1024 * 1024)).toString('utf8'));
    const files = (j.releases && j.releases[j.info.version]) || [];
    const pick = files.find((f) => /win_amd64/.test(f.filename)) || files.find((f) => /win32/.test(f.filename)) || null;
    if (pick && pick.url) return pick.url;
  } catch (e) { /* fall through to the raw static build */ }
  return FFMPEG_FALLBACK_URL;
}

let inflight = null;
let cached = null;

// Resolves {ytdlp, ffmpeg} paths, downloading whatever is missing. Parallel
// callers share one provisioning pass; progress arrives via onProgress as
// {tool, state, pct, received, total}.
async function ensureTools(opts) {
  opts = opts || {};
  if (cached && !opts.force) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const dir = opts.dir || toolsDir();
    const onP = opts.onProgress || function () {};
    const report = (o) => { try { onP(o); } catch (e) {} };
    fs.mkdirSync(dir, { recursive: true });

    // ── yt-dlp ──
    let ytdlp = null;
    const envYt = process.env.AEGIS_YTDL;
    const candidates = [];
    if (envYt) candidates.push(envYt);
    candidates.push(path.join(dir, exeName('yt-dlp')));
    const fromPath = findInPath('yt-dlp');
    if (fromPath) candidates.push(fromPath);
    for (const c of candidates) {
      let exists = false;
      try { exists = fs.statSync(c).isFile(); } catch (e) {}
      if (!exists) continue;
      if (await verifyTool(c, ['--version'])) { ytdlp = c; break; }
      if (isInDir(c, dir)) { try { fs.unlinkSync(c); } catch (e) {} } // corrupt cache: drop it
    }
    const provisioned = [];
    if (!ytdlp) {
      report({ tool: 'yt-dlp', state: 'downloading', pct: 0, received: 0, total: 0 });
      const dest = path.join(dir, exeName('yt-dlp'));
      let lastErr = null;
      for (let round = 0; round < 3 && !ytdlp; round++) {
        for (const u of YT_DLP_URLS) {
          try {
            await downloadWithRetry(u, dest, (p) => report({ tool: 'yt-dlp', state: 'downloading', pct: p.pct, received: p.received, total: p.total }));
            if (isWin && !looksLikePE(dest)) throw new Error('downloaded file is not an executable');
            chmodExec(dest);
            ytdlp = dest;
            break;
          } catch (e) {
            lastErr = e;
            try { fs.unlinkSync(dest); } catch (e2) {}
          }
        }
        if (!ytdlp && round < 2) await new Promise((r) => setTimeout(r, 1500 * (round + 1)));
      }
      if (!ytdlp) throw new Error('Could not download yt-dlp: ' + (lastErr ? lastErr.message : 'unknown error'));
      provisioned.push('yt-dlp');
      report({ tool: 'yt-dlp', state: 'installed', pct: 100, received: 0, total: 0 });
    }
    if (!(await verifyTool(ytdlp, ['--version']))) throw new Error('yt-dlp is present but will not run');

    // ── ffmpeg ──
    let ffmpeg = null;
    const envFf = process.env.AEGIS_FFMPEG;
    const ffCandidates = [];
    if (envFf) ffCandidates.push(envFf);
    ffCandidates.push(path.join(dir, exeName('ffmpeg')));
    const ffFromPath = findInPath('ffmpeg');
    if (ffFromPath) ffCandidates.push(ffFromPath);
    for (const c of ffCandidates) {
      let exists = false;
      try { exists = fs.statSync(c).isFile(); } catch (e) {}
      if (!exists) continue;
      if (await verifyTool(c, ['-version'])) { ffmpeg = c; break; }
      if (isInDir(c, dir)) { try { fs.unlinkSync(c); } catch (e) {} }
    }
    if (!ffmpeg) {
      report({ tool: 'ffmpeg', state: 'downloading', pct: 0, received: 0, total: 0 });
      const dest = path.join(dir, exeName('ffmpeg'));
      const payload = path.join(dir, 'ffmpeg.payload');
      let lastErr = null;
      for (let round = 0; round < 3 && !ffmpeg; round++) {
        for (const u of [await ffmpegWheelUrl(), FFMPEG_FALLBACK_URL]) {
          try {
            await downloadWithRetry(u, payload, (p) => report({ tool: 'ffmpeg', state: 'downloading', pct: p.pct, received: p.received, total: p.total }));
            const buf = fs.readFileSync(payload);
            if (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
              // zip (the PyPI wheel): pull the single static binary out of it
              const exe = zipExtract(buf, /imageio_ffmpeg[\\/]binaries[\\/].*\.exe$/i);
              fs.writeFileSync(dest, exe);
            } else if (buf.length > 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
              fs.writeFileSync(dest, buf); // already the executable
            } else {
              throw new Error('unexpected download content');
            }
            if (isWin && !looksLikePE(dest)) throw new Error('extracted file is not an executable');
            chmodExec(dest);
            ffmpeg = dest;
            break;
          } catch (e) {
            lastErr = e;
            try { fs.unlinkSync(dest); } catch (e2) {}
          } finally {
            try { fs.unlinkSync(payload); } catch (e2) {}
          }
        }
        if (!ffmpeg && round < 2) await new Promise((r) => setTimeout(r, 1500 * (round + 1)));
      }
      if (!ffmpeg) throw new Error('Could not download ffmpeg: ' + (lastErr ? lastErr.message : 'unknown error'));
      provisioned.push('ffmpeg');
      report({ tool: 'ffmpeg', state: 'installed', pct: 100, received: 0, total: 0 });
    }
    if (!(await verifyTool(ffmpeg, ['-version']))) throw new Error('ffmpeg is present but will not run');

    const result = { ytdlp, ffmpeg, dir, provisioned };
    if (!opts.force) cached = result;
    return result;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// YouTube URL -> 11-char video id (watch / shorts / embed / live / youtu.be).
function videoId(raw) {
  const ok = (id) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);
  let u;
  try { u = new URL(String(raw == null ? '' : raw).trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (h === 'youtu.be') return ok(u.pathname.split('/').filter(Boolean)[0]);
  if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtube-nocookie.com' || h.endsWith('.youtube-nocookie.com')) {
    if (u.pathname === '/watch') return ok(u.searchParams.get('v'));
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length >= 2 && ['shorts', 'embed', 'live', 'v'].indexOf(seg[0]) >= 0) return ok(seg[1]);
  }
  return null;
}

module.exports = { ensureTools, toolsDir, videoId, downloadFile, zipExtract };

if (require.main === module) {
  (async () => {
    let lastLine = '';
    const t = await ensureTools({
      dir: process.argv[2] || undefined,
      force: true,
      onProgress: (p) => {
        const mb = (n) => (n ? (n / 1048576).toFixed(1) + ' MB' : '?');
        const line = p.tool + ' ' + p.state + ' ' + (p.pct || 0) + '%  ' + mb(p.received) + '/' + mb(p.total);
        if (line === lastLine) return; // only print when something changes
        lastLine = line;
        process.stdout.write('\r' + line + '   ');
      },
    });
    process.stdout.write('\n');
    console.log('yt-dlp : ' + t.ytdlp);
    console.log('ffmpeg : ' + t.ffmpeg);
    console.log('new    : ' + (t.provisioned.join(', ') || '(already present)'));
  })().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
}
