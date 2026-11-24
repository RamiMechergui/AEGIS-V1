// test-playlist-e2e.js — isolated E2E test for the "Download Full Playlist"
// feature: the toolbar button, the playlist.html selection window (thumbnails,
// titles, durations, availability, select all / deselect all, counts) and the
// ONE-video-at-a-time queue (pause/resume/cancel/remove) driving real yt-dlp
// downloads through the shared engine.
//
// SAFETY FIRST: same guards as test-youtube.js — the project's real data\
// folder is snapshotted and must stay byte-for-byte unchanged, a portable.dat
// marker keeps all user data inside the temp sandbox, AEGIS_DOWNLOADS_DIR
// pins every downloaded file into the sandbox downloads folder, and the
// user's real Downloads folder must gain no test videos.
//
// Run:  node test-playlist-e2e.js
// Env:  AEGIS_YT_PLAYLIST   playlist page to test (default: a 12-video
//                           playlist with a ~5 min shortest video)
//       AEGIS_SHOT=<file>   save a PNG of the selection window
//       AEGIS_SHOT2=<file>  save a PNG of the queue window
//
// What is being proven:
//   Phase A  the playlist bridge is exposed (ytPlaylistWindow/Videos/Start/
//            State/Control, onPlaylistVideos/Progress/WindowOpen) and no
//            queue exists before anything is opened
//   Phase B  the button is HIDDEN on non-YouTube pages, HIDDEN on ordinary
//            video pages (also watch?v=…&list=…) and APPEARS — labelled
//            exactly "Download Full Playlist" — only on a complete
//            youtube.com/playlist?list=… page (mutually exclusive with the
//            single-video Download button)
//   Phase C  pressing it opens the dedicated playlist.html window; the
//            window reads back the playlist URL through yt-playlist-state
//   Phase D  videos stream in: rows with thumbnails, durations, availability
//            badges, checkboxes preselected, correct selected count, select
//            all / deselect all / filter all work
//   Phase E  starting the queue downloads the selected videos strictly ONE
//            AT A TIME in playlist order: pause stops the next video from
//            starting (current one finishes), resume continues, closing the
//            playlist window does NOT stop the queue, reopening shows live
//            state, every video completes, MP4 files land in the sandbox
//            folder in completion order, and the regular Downloads panel
//            receives them (shared engine, no regression)
//   Phase F  a second queue is refused while one runs; after finishing, a
//            new selection can remove a waiting video and cancel the queue
//            (nothing else ever starts, no partial-file debris)
//   Phase G  leaving the playlist page hides the button again
//
// Needs internet access (YouTube + yt-dlp). First run may provision
// yt-dlp/ffmpeg into %LOCALAPPDATA%\AEGIS\tools (resumable).

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP, 'opencode', 'aegis-playlist-test');
const DL_DIR = path.join(SANDBOX, 'downloads');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

const USER = 'pl-user';
const PASS = 'pl-secret';

const PLAYLIST_URL = process.env.AEGIS_YT_PLAYLIST || 'https://www.youtube.com/playlist?list=PLJFfueMLIN0Y';
const VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const VIDEO_LIST_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLJFfueMLIN0Y';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  [ OK ] ' + name);
  else { failures++; console.log('  [FAIL] ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
};

// ── Safety guards ────────────────────────────────────────────────────────────
if (SANDBOX.toLowerCase().startsWith(SRC.toLowerCase())) {
  console.error('FATAL: sandbox would live inside the project folder. Aborting.');
  process.exit(1);
}
const REAL_DATA = path.join(SRC, 'data');
function snapshotRealData() {
  const out = {};
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else { try { out[r] = fs.statSync(p).size; } catch (err) { out[r] = 'gone'; } }
    }
  };
  walk(REAL_DATA, '');
  return out;
}
// The user's real Downloads folder must not gain our test videos.
function realDownloadsWithId(id) {
  if (!id) return [];
  try { return fs.readdirSync(require('os').homedir() + path.sep + 'Downloads', { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.indexOf('[' + id + ']') >= 0).map((e) => e.name); }
  catch (e) { return []; }
}

let nextPort = 9591;
let activePort = null;
const PORT_FILTER = 'remote-debugging-port=';

// Chromium pauses the animation clock (and throttles JS) for a page that is
// not being rendered — raise every AEGIS window (main AND playlist) before
// probing the UI so nothing is occluded or timer-throttled.
const RAISE_PS1 = path.join(SANDBOX, 'raise-window.ps1');

function cleanupLeftovers() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -like '*AEGIS-V1*' -and $_.CommandLine -like '*" + PORT_FILTER + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' }); } catch (e) {}
}

// ── Sandbox setup ────────────────────────────────────────────────────────────
function dropJunction() {
  try { fs.rmdirSync(path.join(SANDBOX, 'node_modules')); } catch (e) { /* not a junction / absent */ }
}
function setupSandbox() {
  dropJunction();
  fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(DL_DIR, { recursive: true });

  // shield.js / shield-list.txt / fp-preload.js / playlist-queue.js are
  // required at runtime by main.js — without them the sandbox cannot start.
  const files = ['main.js', 'preload.js', 'yt-tools.js', 'shield.js', 'shield-list.txt', 'vault.js', 'oauth.js', 'playlist-queue.js',
    'fp-preload.js', 'package.json', 'logo.png', 'logo.ico']
    .concat(fs.readdirSync(SRC).filter((f) => f.endsWith('.html')));
  for (const f of files) fs.copyFileSync(path.join(SRC, f), path.join(SANDBOX, f));

  // Junction instead of copying ~200 MB of node_modules (no admin rights needed)
  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(SANDBOX, 'node_modules'), 'junction');

  // Portable marker -> userData and sessionData resolve inside the sandbox
  fs.writeFileSync(path.join(SANDBOX, 'portable.dat'), '');
  fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
}

// EnumWindows + ShowWindow/SetWindowPos/SetForegroundWindow filtered by PID:
// raise EVERY visible window of the app (main window + playlist window) so
// neither is occluded or timer-throttled during the run.
function writeRaiseScript() {
  fs.writeFileSync(RAISE_PS1, [
    'param([int]$TargetPid)',
    "$src = @'",
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    '',
    'public class WinRaise',
    '{',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  public static uint Target;',
    '  public static IntPtr Found;',
    '  static bool Cb(IntPtr h, IntPtr l)',
    '  {',
    '    if (!IsWindowVisible(h)) return true;',
    '    uint pid;',
    '    GetWindowThreadProcessId(h, out pid);',
    '    if (pid != Target) return true;',
    '    ShowWindow(h, 3);',                                    // SW_MAXIMIZE
    '    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0043);', // HWND_TOPMOST | NOMOVE | NOSIZE | SWP_SHOWWINDOW
    '    SetForegroundWindow(h);',
    '    Found = h;',
    '    return true;',                                         // keep going: raise ALL app windows
    '  }',
    '  public static string Run(int targetPid)',
    '  {',
    '    Target = (uint)targetPid;',
    '    Found = IntPtr.Zero;',
    '    EnumWindows(new EnumProc(Cb), IntPtr.Zero);',
    '    if (Found == IntPtr.Zero) return "NO-WINDOW";',
    '    return "RAISED";',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $src',
    '[WinRaise]::Run($TargetPid)',
  ].join('\n'));
}

function raiseWindow(pid) {
  try {
    return execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', RAISE_PS1, '-TargetPid', String(pid)],
      { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) { return 'ERR:' + e.message; }
}

// ── App lifecycle ────────────────────────────────────────────────────────────
let child = null;
let stderrBuf = '';
let stdoutBuf = '';
function launch() {
  activePort = nextPort++;
  child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + activePort], {
    cwd: SANDBOX,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Downloads go to the sandbox folder — never the user's real Downloads.
    env: Object.assign({}, process.env, { AEGIS_DOWNLOADS_DIR: DL_DIR }),
  });
  console.log('  (launched pid ' + child.pid + ' on port ' + activePort + ')');
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
  child.on('error', (e) => { stderrBuf = 'SPAWN ERROR: ' + e.message; });
}
async function killApp(page) {
  if (child && child.exitCode === null) {
    // Shut down the way a real user does, so before-quit flushes SQLite cleanly.
    if (page) { try { await Promise.race([page.ev("window.ghost.confirmQuitAction('quit')"), sleep(3000)]); } catch (e) { /* closing */ } }
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
    if (child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
      for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
    }
  }
  child = null;
  if (!activePort) return;
  const port = activePort;
  for (let i = 0; i < 60; i++) {
    const busy = await new Promise((res) => {
      const s = net.connect({ port: port, host: '127.0.0.1' });
      s.setTimeout(400);
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
      s.on('timeout', () => { s.destroy(); res(true); });
    });
    if (!busy) return;
    await sleep(500);
  }
  throw new Error('debug port ' + activePort + ' never released');
}

// ── Chrome DevTools Protocol driver ──────────────────────────────────────────
async function listTargets() {
  try { return await (await fetch('http://127.0.0.1:' + activePort + '/json/list')).json(); }
  catch (e) { return []; }
}

async function connectTarget(match, label) {
  let target = null;
  for (let i = 0; i < 60; i++) {
    if (child && child.exitCode !== null) {
      throw new Error('app exited early (code ' + child.exitCode + ')\nstderr:\n' + stderrBuf + '\nstdout:\n' + stdoutBuf);
    }
    try {
      const list = await listTargets();
      target = list.find((t) => t.type === 'page' && match(t.url));
      if (target) break;
    } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  if (!target) throw new Error((label || 'target') + ' not found in the CDP target list\nstderr:\n' + stderrBuf);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('CDP websocket failed to connect'));
    setTimeout(() => reject(new Error('CDP websocket timeout')), 15000);
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(msg.error.message));
    else if (msg.result && msg.result.exceptionDetails) rej(new Error('page exception: ' + JSON.stringify(msg.result.exceptionDetails)));
    // Runtime.evaluate nests the value under result.result; raw commands such as
    // Page.captureScreenshot return their payload at result.* — unwrap both.
    else res(msg.result && msg.result.result ? msg.result.result.value : msg.result);
  };
  await ready;

  const sendRaw = (method, params) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('raw timeout: ' + method)); } }, 30000);
  });

  return {
    url: target.url,
    ev: async (expression) => {
      const once = () => new Promise((res, rej) => {
        const id = ++nextId;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); rej(new Error('evaluate timeout: ' + expression)); }
        }, 30000);
      });
      // A navigation can destroy the JS context mid-call — retry those.
      for (let attempt = 1; attempt <= 12; attempt++) {
        try { return await once(); }
        catch (e) {
          if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(e.message)) throw e;
          if (attempt === 12) throw e;
          await sleep(400);
        }
      }
    },
    close: () => { try { ws.close(); } catch (e) {} },
    // Optional visual proof: AEGIS_SHOT=<file> saves a PNG of the window.
    shot: async (file) => {
      const r = await sendRaw('Page.captureScreenshot', { format: 'png' });
      if (!r || !r.data) throw new Error('captureScreenshot returned no data');
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
  };
}

async function startApp() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await sleep(3000);
    launch();
    try { return await connectTarget((u) => /login[.]html/.test(u), 'login.html CDP target'); }
    catch (e) {
      lastErr = e;
      const detail = (e.message + '\n' + stderrBuf).split('\n').filter((l) =>
        /Lock file|http server|disk I\/O|SqliteError|exited early/.test(l)).join(' | ');
      if (!detail) throw e;
      console.log('  (previous instance not fully released — retry ' + attempt + '/5: ' + detail.slice(0, 300) + ')');
      await killApp();
    }
  }
  throw lastErr;
}

async function readyApp() {
  const page = await startApp();
  for (let i = 0; i < 40; i++) {
    try { if (await page.ev('!!window.ghost') === true) return page; } catch (e) { /* not ready */ }
    await sleep(250);
  }
  return page;
}

// Poll an expression until pred(value) holds (async expressions supported).
async function waitFor(page, expression, pred, tries = 48, label = '') {
  let last, timeouts = 0;
  const started = Date.now();
  for (let i = 0; i < tries; i++) {
    try {
      last = await page.ev(expression);
      timeouts = 0; // a live evaluate resets the strike counter
    } catch (e) {
      last = 'ERR: ' + e.message;
      // Each evaluate timeout costs 30 s; silently looping those would burn
      // hours. Three in a row means the page (or the CDP link) is dead — stop
      // immediately and say so instead of going quiet.
      if (/evaluate timeout|raw timeout|websocket|closed/i.test(e.message)) {
        timeouts++;
        if (timeouts >= 3) {
          throw new Error('page unresponsive (' + (label || 'wait') + '): '
            + e.message.split('\n')[0].slice(0, 200)
            + ' [app exitCode=' + (child ? child.exitCode : 'gone') + ']');
        }
      }
    }
    if (pred(last)) return { ok: true, value: last };
    // Heartbeat so a long wait is visible in the log instead of silent.
    if (i > 0 && i % 10 === 0) {
      console.log('  (waiting ' + Math.round((Date.now() - started) / 1000) + 's, try '
        + (i + 1) + '/' + tries + (label ? ' — ' + label : '') + ')');
    }
    await sleep(500);
  }
  return { ok: false, value: last, label };
}

// MP4 files carry 'ftyp' at byte offset 4 — proof the download is a real video.
function mp4Signature(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    return b.toString('latin1', 4, 8) === 'ftyp';
  } catch (e) { return false; }
}
function dlFilesFor(id) {
  try { return fs.readdirSync(DL_DIR).filter((n) => n.indexOf('[' + id + ']') >= 0); }
  catch (e) { return []; }
}
function dlMtimeFor(id) {
  const f = dlFilesFor(id);
  if (!f.length) return 0;
  try { return fs.statSync(path.join(DL_DIR, f[0])).mtimeMs; } catch (e) { return 0; }
}
// "5:15" / "1:02:03" → seconds (0 for the "—:—" placeholder).
function durToSec(s) {
  const p = String(s || '').trim().split(':').map((x) => parseInt(x, 10));
  if (!p.length || p.some((x) => !isFinite(x))) return 0;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return 0;
}

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS "Download Full Playlist" E2E test ==');
  console.log('  sandbox:  ' + SANDBOX);
  console.log('  playlist: ' + PLAYLIST_URL);

  cleanupLeftovers();
  await sleep(1500);

  const realBefore = snapshotRealData();
  console.log('  project data\\ snapshot: ' + Object.keys(realBefore).length + ' file(s)');

  setupSandbox();
  writeRaiseScript();
  console.log('  sandbox prepared (portable mode, downloads -> ' + DL_DIR + ')\n');

  let page = null;      // controls.html (main window)
  let plPage = null;    // playlist.html (dedicated window)
  let r = null;         // scratch result for the current check
  let appLog = ['', ''];
  // Every video id observed actually entering the "downloading" state, in
  // order — assembled from live state reads across both window lifetimes.
  const observedOrder = [];
  // Filled in Phase D (before any download starts) for the safety proof.
  const testVids = [];            // every video id this run may download
  const realDlBefore = {};        // vid -> files in the REAL Downloads folder
  let q1 = [];                    // queue 1 videos (3 shortest, playlist order)
  let q2 = [];                    // queue 2 videos (2 longest, playlist order)
  // Live sampling of the "never more than one downloading" invariant.
  let maxDlDom = 0;               // max concurrent .qrow[data-status=downloading]
  const STATE_EV = `(async () => {
    const st = await window.ghost.ytPlaylistState();
    const q = (st && st.queue) || {};
    const rec = window.__plrec || { order: [] };
    return {
      open: (st && st.open) || null,
      phase: q.phase || null,
      totals: q.totals || null,
      order: rec.order,
      current: q.current ? (q.current.url || '') : '',
      dlDom: document.querySelectorAll('.qrow[data-status="downloading"]').length,
      viewQueue: !document.getElementById('view-queue').hidden,
      phaseTxt: ((document.getElementById('q-phase') || {}).textContent || '').trim(),
      pauseTxt: ((document.getElementById('q-pause') || {}).textContent || '').trim(),
      stats: ((document.getElementById('q-stats') || {}).textContent || '').replace(/\\s+/g, ' ').trim(),
      now: ((document.getElementById('q-now') || {}).textContent || '').trim()
    };
  })()`;
  // Records the order in which videos entered the "downloading" state.
  const REC_EV = `(() => {
    window.__plrec = { order: [] };
    window.ghost.onPlaylistProgress((d) => {
      if (!d || d.type !== 'snapshot' || !d.state) return;
      for (const it of (d.state.items || [])) {
        if (it.status === 'downloading' && window.__plrec.order.indexOf(it.vid) < 0) window.__plrec.order.push(it.vid);
      }
    });
    return true;
  })()`;

  try {
    // ── Setup: reach the real browser UI ─────────────────────────────────────
    console.log('-- Setup: reach controls.html --');
    page = await readyApp();

    r = await raiseWindow(child.pid);
    check('AEGIS window raised for the test run', r === 'RAISED', r);

    r = await page.ev("window.ghost.register('" + USER + "','" + PASS + "')");
    check('register creates the account', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('login succeeds', r && r.ok === true, JSON.stringify(r));

    r = await page.ev('window.ghost.setAutoClose(false, 5)');
    check('idle auto-close disabled for the test run', r && r.ok !== false, JSON.stringify(r));

    r = await page.ev("window.ghost.selectWorkspace('default')");
    check('selectWorkspace opens the browser UI', r && r.ok === true, JSON.stringify(r));

    // The preload bridge is exposed before the parser reaches the body, so
    // require a fully parsed document with the actual toolbar in it.
    r = await waitFor(page,
      `(() => { try { return /controls[.]html/.test(location.href) && !!window.ghost &&
        document.readyState === 'complete' && !!document.getElementById('yt-btn') &&
        !!document.getElementById('ytpb-btn'); } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded');
    check('controls.html is the live page (both buttons in the DOM)', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page, 'document.visibilityState', v => v === 'visible', 24, 'page never became visible');
    check('controls.html is visible', r.ok === true, JSON.stringify(r.value));

    r = await page.ev('window.ghost.getDownloadDir ? window.ghost.getDownloadDir() : "n/a"');
    check('the app resolves the sandbox downloads folder',
      typeof r === 'string' && r.replace(/\//g, '\\').toLowerCase() === DL_DIR.toLowerCase(), JSON.stringify(r));

    // ── Phase A: the bridge ──────────────────────────────────────────────────
    console.log('\n-- Phase A: playlist bridge --');
    for (const m of ['ytPlaylistWindow', 'ytPlaylistVideos', 'ytPlaylistVideosCancel', 'ytPlaylistStart',
                     'ytPlaylistState', 'ytPlaylistControl', 'onPlaylistVideos', 'onPlaylistProgress',
                     'onPlaylistWindowOpen']) {
      r = await page.ev('typeof window.ghost.' + m);
      check('ghost.' + m + ' is exposed', r === 'function', r);
    }

    r = await page.ev('window.ghost.ytPlaylistState()');
    check('no playlist window/queue exists before anything is opened',
      r && !r.open && !r.queue, JSON.stringify(r));

    // Negative guards: non-playlist URLs must be refused without side effects,
    // and an unknown queue action must never reach the engine.
    r = await page.ev("window.ghost.ytPlaylistWindow({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' })");
    check('opening the playlist window for a video URL is refused',
      r && r.ok === false, JSON.stringify(r));
    r = await page.ev("window.ghost.ytPlaylistVideos('https://example.com')");
    check('listing a non-playlist URL is refused', r && r.ok === false, JSON.stringify(r));
    r = await page.ev("window.ghost.ytPlaylistControl({ action: 'explode' })");
    check('an unknown queue action is refused', r && r.ok === false, JSON.stringify(r));

    // Completion heights of every playlist download (proves the chosen
    // quality drives the shared engine). Registered before any download.
    await page.ev(`(() => {
      window.__plh = [];
      window.ghost.onYtProgress((d) => {
        if (d && d.phase === 'done' && typeof d.height === 'number') window.__plh.push(d.height);
      });
      return true;
    })()`);

    // ── Phase B: button visibility follows the page ──────────────────────────
    console.log('\n-- Phase B: button visibility matrix --');
    r = await page.ev(`(() => {
      const y = document.getElementById('yt-btn'), p = document.getElementById('ytpb-btn');
      return { yt: getComputedStyle(y).display, pb: getComputedStyle(p).display };
    })()`);
    check('both buttons start hidden on a non-YouTube page',
      r && r.yt === 'none' && r.pb === 'none', JSON.stringify(r));

    // Ordinary video page → single-video button only.
    await page.ev('window.ghost.navigate(' + JSON.stringify(VIDEO_URL) + ')');
    r = await waitFor(page,
      "(() => { const b = document.getElementById('yt-btn'); return b && getComputedStyle(b).display !== 'none'; })()",
      v => v === true, 120, 'the Download button never appeared on the video page');
    check('a YouTube video page shows the Download button', r.ok === true, JSON.stringify(r.value));
    r = await page.ev("getComputedStyle(document.getElementById('ytpb-btn')).display");
    check('the playlist button stays hidden on a video page', r === 'none', r);
    r = await page.ev("(() => { const b = document.getElementById('yt-btn'); return b.textContent.replace(/\\s+/g,' ').trim(); })()");
    check('the single-video button is labelled "Download"', r === 'Download', r);

    // Complete playlist page → playlist button ONLY, exact label.
    await page.ev('window.ghost.navigate(' + JSON.stringify(PLAYLIST_URL) + ')');
    r = await waitFor(page,
      "(() => { const b = document.getElementById('ytpb-btn'); return b && getComputedStyle(b).display !== 'none'; })()",
      v => v === true, 120, 'the Download Full Playlist button never appeared on the playlist page');
    check('the playlist page shows the Download Full Playlist button', r.ok === true, JSON.stringify(r.value));
    r = await page.ev(`(() => {
      const b = document.getElementById('ytpb-btn');
      const y = document.getElementById('yt-btn');
      return { text: b.textContent.replace(/\\s+/g,' ').trim(), title: b.title,
               yt: getComputedStyle(y).display };
    })()`);
    check('the button is labelled exactly "Download Full Playlist"',
      r && r.text === 'Download Full Playlist', JSON.stringify(r));
    check('its tooltip says the same', r && r.title === 'Download Full Playlist', JSON.stringify(r));
    check('the single-video button is hidden on a playlist page', r && r.yt === 'none', JSON.stringify(r));

    // watch?v=…&list=… is still an ORDINARY video page — no playlist button.
    await page.ev('window.ghost.navigate(' + JSON.stringify(VIDEO_LIST_URL) + ')');
    r = await waitFor(page,
      "(() => { const p = document.getElementById('ytpb-btn'); return p && getComputedStyle(p).display === 'none'; })()",
      v => v === true, 120, 'the playlist button never disappeared on the watch+list page');
    check('watch?v=…&list=… does NOT show the playlist button', r.ok === true, JSON.stringify(r.value));
    r = await page.ev("getComputedStyle(document.getElementById('yt-btn')).display");
    check('watch?v=…&list=… still shows the single-video button', r === 'flex', r);

    // Back to the playlist page so the next check has a visible button to
    // hide (a hidden→hidden transition would prove nothing).
    await page.ev('window.ghost.navigate(' + JSON.stringify(PLAYLIST_URL) + ')');
    r = await waitFor(page,
      "(() => { const b = document.getElementById('ytpb-btn'); return b && getComputedStyle(b).display !== 'none'; })()",
      v => v === true, 120, 'the playlist button never reappeared');
    check('the playlist button returns on the playlist page', r.ok === true, JSON.stringify(r.value));

    // /playlist without a list id is not a valid playlist either (visible →
    // hidden is the real signal here).
    await page.ev("window.ghost.navigate('https://www.youtube.com/playlist')");
    r = await waitFor(page,
      "(() => { const p = document.getElementById('ytpb-btn'); return p && getComputedStyle(p).display === 'none'; })()",
      v => v === true, 60, 'the playlist button did not hide for /playlist without list');
    check('/playlist without a list id hides the button', r.ok === true, JSON.stringify(r.value));

    // Back to the real playlist page for the rest of the test.
    await page.ev('window.ghost.navigate(' + JSON.stringify(PLAYLIST_URL) + ')');
    r = await waitFor(page,
      "(() => { const b = document.getElementById('ytpb-btn'); return b && getComputedStyle(b).display !== 'none'; })()",
      v => v === true, 120, 'the playlist button never reappeared');
    check('the playlist button is back on the playlist page', r.ok === true, JSON.stringify(r.value));

    // ── Phase C: the dedicated playlist window ───────────────────────────────
    console.log('\n-- Phase C: the playlist window --');
    r = await page.ev("(() => { document.getElementById('ytpb-btn').click(); return true; })()");
    check('pressing the button responds', r === true, r);

    plPage = await connectTarget((u) => /playlist[.]html/.test(u), 'playlist.html window');
    check('the dedicated playlist window opened', !!plPage && /playlist[.]html/.test(plPage.url), plPage && plPage.url);

    r = await raiseWindow(child.pid);
    check('both app windows raised', r === 'RAISED', r);

    r = await waitFor(plPage, 'document.readyState', v => v === 'complete', 40, 'playlist.html never finished loading');
    check('playlist.html finished loading', r.ok === true, JSON.stringify(r.value));

    r = await plPage.ev('window.ghost.ytPlaylistState()');
    check('the window reads back the playlist URL it was opened with',
      !!(r && r.open && /list=/.test(String(r.open.url))), JSON.stringify(r && r.open));
    r = await plPage.ev(`(() => {
      const q = document.getElementById('quit-btn');
      return { quit: !!q && q.textContent.trim() === 'QUIT', title: document.title };
    })()`);
    check('the window follows the frameless AEGIS chrome (QUIT, titled)',
      r && r.quit === true && /Download Full Playlist/.test(r.title), JSON.stringify(r));

    // ── Phase D: the selection interface (streamed listing) ──────────────────
    console.log('\n-- Phase D: selection interface --');
    r = await waitFor(plPage,
      `(() => {
        const sub = document.getElementById('pl-sub');
        const spin = sub ? sub.querySelector('.spin') : null;
        const empty = document.getElementById('pl-empty');
        return { done: !!sub && !spin && /\\d+ videos?/.test(sub.textContent),
                 empty: !!empty && !empty.hidden,
                 emptyText: empty ? empty.textContent.trim().slice(0, 160) : '',
                 sub: sub ? sub.textContent.replace(/\\s+/g, ' ').trim() : '' };
      })()`,
      v => v && (v.done || v.empty), 400, 'the playlist listing never finished');
    check('the listing finished streaming', r.ok === true, JSON.stringify(r.value));
    if (r.value && r.value.empty) {
      check('the playlist produced downloadable rows', false, 'window said: ' + r.value.emptyText);
      throw new Error('listing failed: ' + r.value.emptyText);
    }

    // Playlist meta (title/pill) arrived with the stream.
    r = await plPage.ev(`(() => ({
      title: document.getElementById('pl-title').textContent.trim(),
      pill: !document.getElementById('pl-pill').hidden,
      sub: document.getElementById('pl-sub').textContent.replace(/\\s+/g, ' ').trim()
    }))()`);
    check('the playlist title rendered (meta streamed)', !!r && r.title.length > 0 && r.pill, JSON.stringify(r));
    check('the header counts the videos', /\d+ videos?/.test(r.sub), JSON.stringify(r));

    // Every row: thumbnail, duration, availability badge, checkbox.
    r = await plPage.ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('#pl-rows .row'), (el, i) => ({
      i: i,
      vid: el.getAttribute('data-vid'),
      dur: ((el.querySelector('.dur') || {}).textContent || '').trim(),
      checked: !!(el.querySelector('.cb') || {}).checked,
      on: el.classList.contains('on'),
      thumb: (el.querySelector('.thumb') || {}).src || '',
      badge: ((el.querySelector('.av') || {}).textContent || '').trim(),
      title: ((el.querySelector('.rtitle') || {}).textContent || '').trim()
    })))`);
    let rows = [];
    try { rows = JSON.parse(r); } catch (e) { rows = []; }
    check('the playlist lists its videos as rows', rows.length >= 3, 'rows=' + rows.length);
    check('every row carries a video id', rows.length > 0 && rows.every((x) => /^[A-Za-z0-9_-]{11}$/.test(x.vid)), r);
    check('every row shows a title', rows.length > 0 && rows.every((x) => x.title.length > 0), r);
    check('every row shows a thumbnail URL', rows.length > 0 && rows.every((x) => /^https:\/\//.test(x.thumb)), r);
    check('every row shows a duration', rows.length > 0 && rows.every((x) => durToSec(x.dur) > 0), r);
    check('every row shows an availability badge', rows.length > 0 && rows.every((x) => x.badge.length > 0), r);
    check('all videos start selected (count matches)',
      rows.length > 0 && rows.every((x) => x.checked && x.on), r);

    // At least one thumbnail really decoded (rendered, not just a URL).
    r = await waitFor(plPage,
      "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('#pl-rows .row .thumb'), (img) => ({ ok: img.complete && img.naturalWidth > 0 })))",
      (v) => { try { return JSON.parse(v).some((x) => x.ok); } catch (e) { return false; } }, 60,
      'no thumbnail ever decoded');
    check('thumbnails decode and render', r.ok === true, JSON.stringify(r.value));

    r = await plPage.ev("document.getElementById('pl-count').textContent.trim()");
    check('the selected count shows every video', r === rows.length + ' selected', JSON.stringify(r));
    r = await plPage.ev("document.getElementById('pl-go').disabled");
    check('the download button is enabled with a selection', r === false, r);

    // Deselect all / select all / filter.
    await plPage.ev("(() => { document.getElementById('pl-none').click(); return true; })()");
    r = await waitFor(plPage, "document.getElementById('pl-count').textContent.trim()",
      (v) => v === '0 selected', 20, 'count never dropped to 0');
    check('Deselect all clears every video', r.ok === true, JSON.stringify(r.value));
    r = await plPage.ev(`(() => ({
      on: document.querySelectorAll('#pl-rows .row.on').length,
      checked: document.querySelectorAll('#pl-rows .row .cb:checked').length,
      disabled: document.getElementById('pl-go').disabled
    }))()`);
    check('no row stays highlighted after deselecting',
      r && r.on === 0 && r.checked === 0 && r.disabled === true, JSON.stringify(r));

    await plPage.ev("(() => { document.getElementById('pl-all').click(); return true; })()");
    r = await waitFor(plPage, "document.getElementById('pl-count').textContent.trim()",
      (v) => v === rows.length + ' selected', 20, 'count never returned to full');
    check('Select all re-selects every video', r.ok === true, JSON.stringify(r.value));
    r = await plPage.ev(`(() => ({
      on: document.querySelectorAll('#pl-rows .row.on').length,
      checked: document.querySelectorAll('#pl-rows .row .cb:checked').length,
      disabled: document.getElementById('pl-go').disabled
    }))()`);
    check('every row is highlighted after select all',
      r && r.on === rows.length && r.checked === rows.length && r.disabled === false, JSON.stringify(r));

    // Filter: no match empties the list, a real substring keeps its row.
    await plPage.ev(`(() => { const f = document.getElementById('pl-filter'); f.value = 'zzz-no-such-video-zzz'; f.dispatchEvent(new Event('input')); return true; })()`);
    r = await waitFor(plPage, "document.querySelectorAll('#pl-rows .row').length",
      (v) => v === 0, 40, 'filter never emptied the list');
    check('a filter with no matches shows no rows', r.ok === true, JSON.stringify(r.value));

    const probe = (rows[0] && rows[0].title || '').slice(0, 8).toLowerCase();
    await plPage.ev(`(() => { const f = document.getElementById('pl-filter'); f.value = ${JSON.stringify(probe)}; f.dispatchEvent(new Event('input')); return true; })()`);
    r = await waitFor(plPage, "document.querySelectorAll('#pl-rows .row').length",
      (v) => typeof v === 'number' && v >= 1 && v <= rows.length, 40, 'filter never matched its own title');
    check('a matching filter shows the matching rows', r.ok === true, JSON.stringify(r.value));

    await plPage.ev(`(() => { const f = document.getElementById('pl-filter'); f.value = ''; f.dispatchEvent(new Event('input')); return true; })()`);
    r = await waitFor(plPage, "document.querySelectorAll('#pl-rows .row').length",
      (v) => v === rows.length, 40, 'clearing the filter never restored the rows');
    check('clearing the filter restores every row', r.ok === true, JSON.stringify(r.value));

    if (process.env.AEGIS_SHOT) {
      try {
        const p = await plPage.shot(process.env.AEGIS_SHOT);
        check('screenshot of the selection window captured', fs.existsSync(p), p);
        console.log('  [info] screenshot: ' + p);
      } catch (e) { check('screenshot of the selection window captured', false, e.message); }
    }

    // ── Choose the videos for the queues ─────────────────────────────────────
    // Queue 1 = the 3 shortest videos (fast, small at 360p) in PLAYLIST order.
    // Queue 2 (Phase F) = the 2 longest, distinct from queue 1.
    const withDur = rows.filter((x) => durToSec(x.dur) > 0);
    check('at least 3 videos have a usable duration', withDur.length >= 3, 'withDur=' + withDur.length);
    q1 = withDur.slice().sort((a, b) => durToSec(a.dur) - durToSec(b.dur)).slice(0, 3)
      .sort((a, b) => a.i - b.i);                       // execution order = playlist order
    const q1Vids = q1.map((x) => x.vid);
    q2 = withDur.slice().sort((a, b) => durToSec(b.dur) - durToSec(a.dur)).slice(0, 2)
      .filter((x) => q1Vids.indexOf(x.vid) < 0)
      .sort((a, b) => a.i - b.i);
    check('two more distinct videos exist for the cancel test', q2.length === 2, JSON.stringify(q2.map((x) => x.vid)));
    console.log('  (queue 1: ' + q1.map((x) => x.vid + ' [' + x.dur + ']').join(', ') + ')');
    console.log('  (queue 2: ' + q2.map((x) => x.vid + ' [' + x.dur + ']').join(', ') + ')');
    testVids.push(...q1Vids, ...q2.map((x) => x.vid));
    for (const id of testVids) realDlBefore[id] = realDownloadsWithId(id).join('|');
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
  }

  // ── Phase E: the ONE-video-at-a-time queue with real downloads ────────────
  try {
    if (q1.length !== 3) throw new Error('selection phase failed — skipping the queue run');
    console.log('\n-- Phase E: sequential queue (pause / resume / window close) --');

    // Sample the concurrency invariant from every state read we make.
    const sampleDl = (v) => {
      if (!v) return;
      if (typeof v.dlDom === 'number' && v.dlDom > maxDlDom) maxDlDom = v.dlDom;
      if (v.totals && typeof v.totals.downloading === 'number' && v.totals.downloading > maxDlDom) {
        maxDlDom = v.totals.downloading;
      }
    };

    // Record downloading-order + install progress recorder BEFORE starting.
    r = await plPage.ev(REC_EV);
    check('the queue recorder is installed before starting', r === true, r);

    // 360p keeps the test videos small; the choice must reach the engine.
    r = await plPage.ev(`(() => { const s = document.getElementById('pl-quality'); s.value = '360'; return s.value; })()`);
    check('the quality selector accepts 360p', r === '360', r);

    // Select exactly the 3 chosen videos through the real UI.
    await plPage.ev("(() => { document.getElementById('pl-none').click(); return true; })()");
    await waitFor(plPage, "document.getElementById('pl-count').textContent.trim()",
      (v) => v === '0 selected', 20, 'deselect all before picking');
    for (const vid of q1.map((x) => x.vid)) {
      await plPage.ev(`(() => { const cb = document.querySelector('#pl-rows .row[data-vid="${vid}"] .cb'); if (cb) cb.click(); return true; })()`);
    }
    r = await waitFor(plPage, "document.getElementById('pl-count').textContent.trim()",
      (v) => v === '3 selected', 20, 'the 3 chosen videos never got selected');
    check('exactly the 3 chosen videos are selected', r.ok === true, JSON.stringify(r.value));
    r = await plPage.ev(`JSON.stringify(Array.prototype.map.call(
      document.querySelectorAll('#pl-rows .row.on'), (el) => el.getAttribute('data-vid')))`);
    let onVids = [];
    try { onVids = JSON.parse(r); } catch (e) {}
    check('only the chosen rows are highlighted',
      onVids.length === 3 && q1.every((x) => onVids.indexOf(x.vid) >= 0), JSON.stringify(onVids));

    // Press the real button.
    r = await plPage.ev("(() => { document.getElementById('pl-go').click(); return true; })()");
    check('pressing Download Selected Videos responds', r === true, r);

    r = await waitFor(plPage, STATE_EV,
      (v) => { sampleDl(v); return v && v.phase === 'running' && v.totals && v.totals.downloading === 1 && v.totals.waiting === 2 && v.order.length >= 1; },
      240, 'the queue never started its first video');
    sampleDl(r.value);
    check('the queue starts with exactly ONE video downloading', r.ok === true, JSON.stringify(r.value));
    check('the other two videos are waiting', r.ok === true && r.value.totals.waiting === 2, JSON.stringify(r.value && r.value.totals));
    check('the queue view replaced the selection view', r.ok === true && r.value.viewQueue === true, JSON.stringify(r.value));
    check('the first downloading video is the first in playlist order',
      r.ok === true && r.value.order[0] === q1[0].vid, JSON.stringify(r.value && r.value.order));
    check('the waiting count is shown in the stats',
      r.ok === true && /Waiting\s*2/.test(r.value.stats), r.value && r.value.stats);
    if (r.ok && r.value.order[0]) observedOrder.push(r.value.order[0]);

    r = await plPage.ev(`(() => {
      const msg = document.getElementById('pl-msg').textContent;
      const skip = document.getElementById('q-skip');
      return { msg: msg.trim(), skipDisabled: skip.disabled, cancelDisabled: document.getElementById('q-cancel').disabled };
    })()`);
    check('the start message names the queued count', /3 videos waiting/.test(r.msg), JSON.stringify(r));
    check('Skip and Cancel are offered while downloading',
      r && r.skipDisabled === false && r.cancelDisabled === false, JSON.stringify(r));

    // A second queue must be refused while this one owns the download slot.
    r = await plPage.ev(`(async () => await window.ghost.ytPlaylistStart({
      url: ${JSON.stringify(PLAYLIST_URL)},
      videos: [{ vid: 'AAAAAAAAAAA', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', title: 'x' }],
      height: 360, ws: 'default'
    }))()`);
    check('a second playlist queue is refused while one is running',
      r && r.ok === false && /already running/i.test(String(r.error || '')), JSON.stringify(r));

    // ── Pause: the current video finishes, NOTHING new starts ────────────────
    r = await plPage.ev("(() => { document.getElementById('q-pause').click(); return true; })()");
    check('pressing Pause responds', r === true, r);

    r = await waitFor(plPage, STATE_EV,
      (v) => { sampleDl(v); return v && v.phase === 'paused' && v.totals && v.totals.downloading === 0; },
      360, 'the queue never paused after the current video finished');
    sampleDl(r.value);
    check('pause lets the current video finish, then stops', r.ok === true, JSON.stringify(r.value));
    const paused = r.value || {};
    check('exactly one video completed during the pause',
      paused.totals && paused.totals.completed === 1, JSON.stringify(paused.totals));
    check('the remaining videos stay waiting while paused',
      paused.totals && paused.totals.waiting === 2, JSON.stringify(paused.totals));
    check('NO second video started while paused',
      Array.isArray(paused.order) && paused.order.length === 1, JSON.stringify(paused.order));
    check('no row shows as downloading while paused', paused.dlDom === 0, String(paused.dlDom));
    check('the phase chip reads Paused', paused.phaseTxt === 'Paused', paused.phaseTxt);
    check('the pause button turned into Resume', paused.pauseTxt === 'Resume', paused.pauseTxt);
    check('the stats show the waiting count while paused', /Waiting\s*2/.test(paused.stats), paused.stats);

    // ── Resume continues exactly where it stopped ────────────────────────────
    r = await plPage.ev("(() => { document.getElementById('q-pause').click(); return true; })()");
    check('pressing Resume responds', r === true, r);

    r = await waitFor(plPage, STATE_EV,
      (v) => { sampleDl(v); return v && v.phase === 'running' && v.totals && v.totals.downloading === 1 && v.order.length >= 2; },
      120, 'resume never started the second video');
    sampleDl(r.value);
    check('resume starts the NEXT video (no restart of the first)', r.ok === true, JSON.stringify(r.value));
    check('the second video is the second in playlist order',
      r.ok === true && r.value.order[1] === q1[1].vid, JSON.stringify(r.value && r.value.order));
    if (r.ok && r.value.order[1]) observedOrder.push(r.value.order[1]);

    // ── Closing the playlist window must NOT stop the queue ──────────────────
    r = await plPage.ev("(() => { setTimeout(() => { try { window.close(); } catch (e) {} }, 30); return true; })()");
    check('closing the playlist window is scheduled', r === true, r);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      const list = await listTargets();
      gone = !list.some((t) => t.type === 'page' && /playlist[.]html/.test(t.url));
      if (!gone) await sleep(400);
    }
    check('the playlist window really closed', gone);
    try { if (plPage) plPage.close(); } catch (e) {}
    plPage = null;

    // The queue keeps downloading with NO window open: video 2 completes.
    const CTRL_EV = `(async () => {
      const st = await window.ghost.ytPlaylistState();
      const q = (st && st.queue) || null;
      return q ? { phase: q.phase, totals: q.totals } : null;
    })()`;
    r = await waitFor(page, CTRL_EV,
      (v) => v && v.totals && (v.totals.completed >= 2 || v.totals.failed >= 1),
      400, 'the queue stopped when the window closed');
    check('the queue keeps running with the playlist window closed', r.ok === true, JSON.stringify(r.value));
    check('the queue is still alive (not canceled/idle)',
      r.ok === true && (r.value.phase === 'running' || r.value.phase === 'paused' || r.value.phase === 'done'),
      JSON.stringify(r.value));

    // ── Reopen: the window reads the live queue state back ───────────────────
    r = await page.ev("(() => { document.getElementById('ytpb-btn').click(); return true; })()");
    check('pressing the toolbar button again responds', r === true, r);
    plPage = await connectTarget((u) => /playlist[.]html/.test(u), 'playlist.html window (reopened)');
    check('the playlist window reopened', !!plPage, plPage && plPage.url);
    await raiseWindow(child.pid);

    r = await waitFor(plPage, 'document.readyState', v => v === 'complete', 40, 'playlist.html never reloaded');
    check('the reopened window finished loading', r.ok === true, JSON.stringify(r.value));
    r = await plPage.ev(REC_EV);
    check('the recorder is installed on the reopened window', r === true, r);

    r = await waitFor(plPage, STATE_EV,
      (v) => { sampleDl(v); return v && v.viewQueue === true && v.phase; },
      60, 'the reopened window never showed the queue');
    check('the reopened window shows the RUNNING queue view', r.ok === true, JSON.stringify(r.value));
    check('the phase chip shows live progress',
      r.ok === true && ['Downloading playlist', 'Paused', 'Finished'].indexOf(r.value.phaseTxt) >= 0, r.value && r.value.phaseTxt);

    if (process.env.AEGIS_SHOT2) {
      try {
        const p = await plPage.shot(process.env.AEGIS_SHOT2);
        check('screenshot of the queue window captured', fs.existsSync(p), p);
        console.log('  [info] screenshot: ' + p);
      } catch (e) { check('screenshot of the queue window captured', false, e.message); }
    }

    // ── Wait for completion (sampling concurrency the whole way) ─────────────
    let finalState = null;
    const vidFromUrl = (u) => (String(u || '').match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1] || '';
    for (let i = 0; i < 600; i++) {
      let s = null;
      try { s = await plPage.ev(STATE_EV); } catch (e) { s = null; }
      sampleDl(s);
      if (s && s.current) {
        const cv = vidFromUrl(s.current);
        if (cv && observedOrder[observedOrder.length - 1] !== cv) observedOrder.push(cv);
      }
      if (s && s.phase === 'done') { finalState = s; break; }
      if (i > 0 && i % 40 === 0) {
        console.log('  (waiting ' + Math.round(i / 2) + 's for the queue to finish — '
          + (s && s.totals ? s.totals.completed + ' done' : 'no state') + ')');
      }
      await sleep(500);
    }
    check('the queue reaches the done state', !!finalState, JSON.stringify(finalState));
    check('NEVER more than one video downloading at once (whole run)',
      maxDlDom <= 1, 'max concurrent = ' + maxDlDom);
    if (finalState) {
      check('all 3 selected videos completed',
        finalState.totals.completed === 3 && finalState.totals.failed === 0 && finalState.totals.remaining === 0,
        JSON.stringify(finalState.totals));
      check('the queue view shows the Finished phase', finalState.phaseTxt === 'Finished', finalState.phaseTxt);
      check('the overall bar is full',
        /Completed\s*3/.test(finalState.stats) && /Remaining\s*0/.test(finalState.stats), finalState.stats);
      check('the header names all done', /All done/.test(finalState.now), finalState.now);
      const rowsNow = await plPage.ev(`JSON.stringify(Array.prototype.map.call(
        document.querySelectorAll('#q-rows .qrow'), (el) => el.getAttribute('data-status')))`);
      let sts = [];
      try { sts = JSON.parse(rowsNow); } catch (e) {}
      check('every queue row shows completed',
        sts.length === 3 && sts.every((x) => x === 'completed'), rowsNow);
      const btns = await plPage.ev(`(() => ({
        retry: document.getElementById('q-retry').hidden,
        pause: document.getElementById('q-pause').disabled,
        cancel: document.getElementById('q-cancel').disabled,
        neu: !document.getElementById('q-new').hidden
      }))()`);
      check('with 0 failures the Retry button stays hidden', btns && btns.retry === true, JSON.stringify(btns));
      check('Pause/Cancel are disabled once finished',
        btns && btns.pause === true && btns.cancel === true, JSON.stringify(btns));
      check('New selection is offered after finishing', btns && btns.neu === true, JSON.stringify(btns));
    }

    // ── Execution order (live observations + recoders) + file mtimes ─────────
    // observedOrder was assembled from live state reads across both window
    // lifetimes; the reopened window's recorder adds whatever it saw. Both
    // must be ever-advancing subsequences of the playlist order.
    let merged = [];
    try {
      const rec2 = await plPage.ev('JSON.stringify((window.__plrec || { order: [] }).order)');
      merged = JSON.parse(rec2) || [];
    } catch (e) { merged = []; }
    const isSubseq = (arr) => {
      let p = -1;
      for (const vid of arr) {
        const idx = q1.findIndex((x) => x.vid === vid);
        if (idx < 0 || idx <= p) return false;
        p = idx;
      }
      return arr.length > 0;
    };
    check('observed download order follows the playlist order',
      observedOrder.length > 0 && isSubseq(observedOrder), JSON.stringify(observedOrder));
    if (merged.length) {
      check('the reopened window recorder agrees with the order', isSubseq(merged), JSON.stringify(merged));
    } else {
      console.log('  [info] the reopened window saw no new download starts (covered by live reads + mtimes)');
    }
    if (observedOrder.length === 3) {
      check('all three videos were observed as downloading in order',
        isSubseq(observedOrder), JSON.stringify(observedOrder));
    } else {
      // Video 3 can finish between two polls on a fast link — the mtime
      // ordering below still proves it ran after video 2.
      console.log('  [info] observed ' + observedOrder.length + '/3 downloads live (fast link) — mtimes cover the order');
      check('at least the first two videos were observed in order',
        observedOrder.length >= 2 && isSubseq(observedOrder), JSON.stringify(observedOrder));
    }

    const mtimes = q1.map((x) => dlMtimeFor(x.vid));
    check('all 3 video files landed in the sandbox folder', mtimes.every((m) => m > 0), JSON.stringify(mtimes));
    check('files completed strictly one after another (mtimes ascend)',
      mtimes[0] > 0 && mtimes[0] <= mtimes[1] && mtimes[1] <= mtimes[2],
      JSON.stringify(mtimes.map((m) => new Date(m).toISOString())));

    // Every file is a real MP4 with a plausible size — shared-engine proof.
    for (const x of q1) {
      const f = dlFilesFor(x.vid);
      const pth = f.length ? path.join(DL_DIR, f[0]) : null;
      let size = 0;
      if (pth) { try { size = fs.statSync(pth).size; } catch (e) {} }
      check('video ' + x.vid + ' is a real MP4 in the sandbox folder',
        f.length >= 1 && size > 10000 && mp4Signature(pth),
        JSON.stringify({ files: f, size: size }));
      check('no partial-file debris for ' + x.vid,
        dlFilesFor(x.vid).every((n) => /\.(mp4|m4a|mkv|webm)$/.test(n)), JSON.stringify(dlFilesFor(x.vid)));
    }

    // The chosen quality reached the engine (360p completion events).
    const heights = await page.ev('JSON.stringify(window.__plh || [])');
    let hl = [];
    try { hl = JSON.parse(heights); } catch (e) {}
    check('every playlist download completed at the chosen 360p',
      hl.length >= 3 && hl.slice(0, 3).every((h) => h === 360), heights);

    // ── The regular Downloads panel received the playlist downloads ──────────
    r = await page.ev("(() => { document.getElementById('dl-btn').click(); return true; })()");
    check('the Downloads panel button responds', r === true, r);
    r = await waitFor(page,
      "(() => { const p = document.getElementById('dlp'); return p ? p.classList.contains('open') : false; })()",
      v => v === true, 20, 'the Downloads panel never opened');
    check('the Downloads panel opens', r.ok === true, JSON.stringify(r.value));
    r = await waitFor(page,
      "(() => { const l = document.getElementById('dll'); return l ? l.innerHTML.indexOf('" + q1[0].vid + "') >= 0 : false; })()",
      v => v === true, 60, 'the playlist video never showed up in the Downloads panel');
    check('playlist downloads appear in the regular Downloads panel', r.ok === true, JSON.stringify(r.value));
    await page.ev("(() => { const c = document.getElementById('cdl'); if (c) c.click(); return true; })()");
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
  }

  // ── Phase F: new selection — remove a waiting video, then cancel ──────────
  try {
    if (q2.length !== 2 || !plPage) throw new Error('queue 1 failed or window lost — skipping the cancel test');
    console.log('\n-- Phase F: remove + cancel --');

    // Back to the selection view ("New selection"). The window re-lists the
    // playlist for a fresh pick.
    r = await plPage.ev("(() => { document.getElementById('q-new').click(); return true; })()");
    check('New selection responds', r === true, r);
    r = await waitFor(plPage,
      `(() => ({ sel: !document.getElementById('view-select').hidden,
                 q: !document.getElementById('view-queue').hidden }))()`,
      (v) => v && v.sel === true && v.q === false, 30, 'never returned to the selection view');
    check('the selection view is back', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(plPage,
      `(() => {
        const sub = document.getElementById('pl-sub');
        return { rows: document.querySelectorAll('#pl-rows .row').length,
                 done: !!sub && !sub.querySelector('.spin') && /\\d+ videos?/.test(sub.textContent) };
      })()`,
      (v) => v && v.done && v.rows >= 2, 400, 'the playlist never re-listed');
    check('the playlist re-listed for the new selection', r.ok === true, JSON.stringify(r.value));

    // Select the 2 long videos through the UI (deselect first — re-list
    // preselects everything).
    await plPage.ev("(() => { document.getElementById('pl-none').click(); return true; })()");
    await waitFor(plPage, "document.getElementById('pl-count').textContent.trim()",
      (v) => v === '0 selected', 20, 'deselect all for queue 2');
    for (const vid of q2.map((x) => x.vid)) {
      await plPage.ev(`(() => { const cb = document.querySelector('#pl-rows .row[data-vid="${vid}"] .cb'); if (cb) cb.click(); return true; })()`);
    }
    r = await waitFor(plPage, "document.getElementById('pl-count').textContent.trim()",
      (v) => v === '2 selected', 20, 'the 2 cancel-test videos never got selected');
    check('exactly the 2 chosen videos are selected', r.ok === true, JSON.stringify(r.value));

    r = await plPage.ev("(() => { document.getElementById('pl-quality').value = '360'; document.getElementById('pl-go').click(); return true; })()");
    check('starting the second queue responds', r === true, r);

    r = await waitFor(plPage, STATE_EV,
      (v) => { if (v && typeof v.dlDom === 'number' && v.dlDom > maxDlDom) maxDlDom = v.dlDom;
               return v && v.phase === 'running' && v.totals && v.totals.downloading === 1 && v.totals.total === 2; },
      240, 'the second queue never started');
    check('the second queue runs with exactly one video downloading', r.ok === true, JSON.stringify(r.value));
    check('the first video of queue 2 is its first in playlist order',
      r.ok === true && r.value.order[0] === q2[0].vid, JSON.stringify(r.value && r.value.order));

    // Remove the waiting video: it must never download.
    r = await plPage.ev(`(() => {
      const row = document.querySelector('#q-rows .qrow[data-status="waiting"]');
      if (!row) return null;
      const btn = row.querySelector('button[data-act="remove"]');
      if (!btn) return null;
      btn.click();
      return row.getAttribute('data-id');
    })()`);
    check('a waiting video offers a Remove action', r !== null, r);

    r = await waitFor(plPage, STATE_EV,
      (v) => v && v.totals && v.totals.removed === 1, 30, 'the waiting video was never removed');
    check('the waiting video shows as removed', r.ok === true, JSON.stringify(r.value && r.value.totals));
    r = await plPage.ev(`(() => ({
      waiting: document.querySelectorAll('#q-rows .qrow[data-status="waiting"]').length,
      removed: document.querySelectorAll('#q-rows .qrow[data-status="removed"]').length
    }))()`);
    check('the row updates in place (removed, no waiting rows left)',
      r && r.waiting === 0 && r.removed === 1, JSON.stringify(r));

    // Cancel the whole queue: the active video dies, nothing else ever starts.
    r = await plPage.ev("(() => { document.getElementById('q-cancel').click(); return true; })()");
    check('pressing Cancel queue responds', r === true, r);

    r = await waitFor(plPage, STATE_EV,
      (v) => { if (v && typeof v.dlDom === 'number' && v.dlDom > maxDlDom) maxDlDom = v.dlDom;
               return v && v.phase === 'canceled' && v.totals && v.totals.downloading === 0; },
      120, 'the queue never canceled');
    check('cancel stops the queue (phase Canceled, nothing downloading)',
      r.ok === true, JSON.stringify(r.value));
    const can = r.value || {};
    check('the canceled video is recorded as canceled',
      can.totals && can.totals.canceled === 1, JSON.stringify(can.totals));
    check('the removed video stays removed (not resurrected)',
      can.totals && can.totals.removed === 1, JSON.stringify(can.totals));
    check('nothing completed in the canceled queue',
      can.totals && can.totals.completed === 0, JSON.stringify(can.totals));
    check('the phase chip reads Canceled', can.phaseTxt === 'Canceled', can.phaseTxt);

    // Nothing may ever start after a cancel — watch for a few seconds.
    const after = await plPage.ev(STATE_EV);
    await sleep(6000);
    const later = await plPage.ev(STATE_EV);
    check('no download starts after the cancel (stable for 6s)',
      later && later.phase === 'canceled' && later.totals.downloading === 0 &&
      later.totals.completed === 0 && later.order.length === (after ? after.order.length : -1),
      JSON.stringify({ after: after && after.totals, later: later && later.totals }));

    // The killed job leaves no partial files behind.
    for (const x of q2) {
      check('no partial-file debris for the canceled video ' + x.vid,
        dlFilesFor(x.vid).length === 0, JSON.stringify(dlFilesFor(x.vid)));
    }

    const fin = await plPage.ev(`(() => ({
      cancel: document.getElementById('q-cancel').disabled,
      neu: !document.getElementById('q-new').hidden
    }))()`);
    check('after canceling: Cancel disabled, New selection offered',
      fin && fin.cancel === true && fin.neu === true, JSON.stringify(fin));
    check('never more than one video downloading at once (both queues)',
      maxDlDom <= 1, 'max concurrent = ' + maxDlDom);
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
  }

  // ── Phase G: leaving the playlist hides the button again ──────────────────
  try {
    console.log('\n-- Phase G: leaving the playlist page --');
    await page.ev('window.ghost.navigate(' + JSON.stringify(VIDEO_URL) + ')');
    r = await waitFor(page,
      "(() => { const p = document.getElementById('ytpb-btn'); return p && getComputedStyle(p).display === 'none'; })()",
      v => v === true, 120, 'the playlist button never disappeared on a video page');
    check('the playlist button disappears when leaving the playlist', r.ok === true, JSON.stringify(r.value));
    r = await page.ev("(() => { const y = document.getElementById('yt-btn'); return { yt: getComputedStyle(y).display, pb: getComputedStyle(document.getElementById('ytpb-btn')).display }; })()");
    check('the single-video Download button is back (mutual exclusion)',
      r && r.yt === 'flex' && r.pb === 'none', JSON.stringify(r));

    await page.ev("window.ghost.navigate('https://example.com')");
    r = await waitFor(page,
      "(() => { const y = document.getElementById('yt-btn'); return y && getComputedStyle(y).display === 'none'; })()",
      v => v === true, 60, 'the Download button stayed visible off YouTube');
    check('the single-video button disappears off YouTube', r.ok === true, JSON.stringify(r.value));
    r = await page.ev("(() => ({ yt: getComputedStyle(document.getElementById('yt-btn')).display, pb: getComputedStyle(document.getElementById('ytpb-btn')).display }))()");
    check('both buttons are hidden off YouTube',
      r && r.yt === 'none' && r.pb === 'none', JSON.stringify(r));
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
  } finally {
    await killApp(page);
    if (plPage) { try { plPage.close(); } catch (e) {} }
    if (page) page.close();
    appLog = [stdoutBuf, stderrBuf];
  }

  // ── Safety proof: the real project data folder must be untouched ───────────
  const realAfter = snapshotRealData();
  const changed = [];
  const keys = new Set(Object.keys(realBefore).concat(Object.keys(realAfter)));
  for (const k of keys) if (realBefore[k] !== realAfter[k]) changed.push(k + ' (' + realBefore[k] + ' -> ' + realAfter[k] + ')');
  check('project data\\ folder untouched by the test', changed.length === 0, changed.join(', '));
  check('project node_modules untouched by the test',
    fs.existsSync(path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe')) &&
    fs.existsSync(path.join(SRC, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')));
  const leaked = [];
  for (const id of testVids) {
    const afterList = realDownloadsWithId(id);
    const beforeList = (realDlBefore[id] || '').split('|').filter(Boolean);
    if (afterList.length !== beforeList.length) leaked.push(id + ': ' + beforeList.length + ' -> ' + afterList.length);
  }
  check('the real Downloads folder gained no test video', leaked.length === 0, leaked.join(', '));

  if (failures !== 0) {
    if (appLog[0] && appLog[0].trim()) console.log('  --- app stdout ---\n' + appLog[0].trim());
    if (appLog[1] && appLog[1].trim()) console.log('  --- app stderr ---\n' + appLog[1].trim());
  }

  if (failures === 0) {
    dropJunction();                                   // unlink first — never let rmSync follow it
    try { fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
      console.log('  [info] sandbox cleanup incomplete: ' + e.message);
    }
    console.log('\n== RESULT: ALL CHECKS PASSED ==  (sandbox removed)');
  } else {
    console.log('\n== RESULT: ' + failures + ' FAILURE(S) ==  (sandbox kept for inspection: ' + SANDBOX + ')');
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
