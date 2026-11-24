// test-youtube.js — isolated E2E test: the toolbar "Download" button that
// appears on YouTube pages, its quality picker (1080p preselected), and a real
// end-to-end video download with progress, completion and cancel handling.
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder and
// NEVER writes into the user's real Downloads folder. It copies the app into a
// temp sandbox, writes a portable.dat marker there so all user data lands
// inside the sandbox, and points AEGIS_DOWNLOADS_DIR at a sandbox folder so
// the downloaded video lands there too. Afterwards it asserts that the project
// data\ folder is byte-for-byte unchanged.
//
// Run:  node test-youtube.js
// Env:  AEGIS_YT_VIDEO      video used for the download test (default: a 19 s
//                           clip that only has 144p/240p — keeps the download
//                           tiny and the test fast)
//       AEGIS_YT_VIDEO_HD   video used for the 1080p-default + cancel test
//                           (default: a well-known video that offers 1080p)
//       AEGIS_SHOT=<file>   save a PNG of the popover
//
// What is being proven:
//   Phase A  the YouTube bridge is exposed (ytVideoInfo / ytStartDownload /
//            ytCancelDownload / onYtProgress)
//   Phase B  the Download button is HIDDEN on a non-YouTube page and APPEARS
//            (label "Download") once a YouTube video page opens
//   Phase C  pressing it opens the quality popover: rows render with sizes,
//            1080p is preselected on a video that offers it, and the footer
//            button names the selected quality
//   Phase D  picking another quality updates the footer; pressing Download
//            streams live progress, the MP4 (ftyp signature) lands in the
//            sandbox downloads folder, and the entry shows up in the regular
//            Downloads panel as a completed download
//   Phase E  on a 1080p-capable video the picker defaults to 1080p and the
//            download actually requests it; canceling mid-download reports the
//            canceled state and leaves no partial-file debris behind
//   Phase F  leaving YouTube hides the button again
//
// Needs internet access (YouTube + the yt-dlp probe). First run may also
// provision yt-dlp/ffmpeg into %LOCALAPPDATA%\AEGIS\tools (resumable).

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP, 'opencode', 'aegis-youtube-test');
const DL_DIR = path.join(SANDBOX, 'downloads');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

const USER = 'yt-user';
const PASS = 'yt-secret';

// Small video (144p/240p only) for the full download; HD video (offers 1080p)
// for the default-quality + cancel checks.
const VIDEO_URL = process.env.AEGIS_YT_VIDEO || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const VIDEO_ID = (VIDEO_URL.match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1] || '';
const HD_URL = process.env.AEGIS_YT_VIDEO_HD || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const HD_ID = (HD_URL.match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1] || '';

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

let nextPort = 9491;
let activePort = null;
const PORT_FILTER = 'remote-debugging-port=';

// Chromium pauses the animation clock (and throttles JS) for a page that is not
// being rendered, so a window hidden behind the console makes CSS transitions
// freeze — and a hidden window makes Runtime.evaluate unreliable. A real user
// always looks at the window, so raise it before probing the UI.
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

  // shield.js / shield-list.txt / fp-preload.js are required at runtime by
  // main.js (Aegis Shield) — without them the sandbox app cannot start.
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
// maximise, make topmost and focus the AEGIS window so nothing occludes it.
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
    '    Found = h;',
    '    return false;',
    '  }',
    '  public static string Run(int targetPid)',
    '  {',
    '    Target = (uint)targetPid;',
    '    Found = IntPtr.Zero;',
    '    EnumWindows(new EnumProc(Cb), IntPtr.Zero);',
    '    if (Found == IntPtr.Zero) return "NO-WINDOW";',
    '    ShowWindow(Found, 3);',                                    // SW_MAXIMIZE
    '    SetWindowPos(Found, new IntPtr(-1), 0, 0, 0, 0, 0x0043);', // HWND_TOPMOST | NOMOVE | NOSIZE | SWP_SHOWWINDOW
    '    SetForegroundWindow(Found);',
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
async function connectTarget(match, label) {
  let target = null;
  for (let i = 0; i < 60; i++) {
    if (child && child.exitCode !== null) {
      throw new Error('app exited early (code ' + child.exitCode + ')\nstderr:\n' + stderrBuf + '\nstdout:\n' + stdoutBuf);
    }
    try {
      const list = await (await fetch('http://127.0.0.1:' + activePort + '/json/list')).json();
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
      // A navigation (login -> controls) can destroy the JS context mid-call — retry those.
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

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS YouTube "Download" button E2E test ==');
  console.log('  sandbox: ' + SANDBOX);
  console.log('  download video: ' + VIDEO_URL);
  console.log('  1080p video:    ' + HD_URL);

  cleanupLeftovers();
  await sleep(1500);

  const realBefore = snapshotRealData();
  console.log('  project data\\ snapshot: ' + Object.keys(realBefore).length + ' file(s)');
  const realDlBeforeV = realDownloadsWithId(VIDEO_ID);
  const realDlBeforeH = realDownloadsWithId(HD_ID);

  setupSandbox();
  writeRaiseScript();
  console.log('  sandbox prepared (portable mode, downloads -> ' + DL_DIR + ')\n');

  let page = null;
  let appLog = ['', ''];
  try {
    // ── Setup: reach the real browser UI ─────────────────────────────────────
    console.log('-- Setup: reach controls.html --');
    page = await readyApp();

    // Put the window on screen from the start: a hidden or fully occluded page
    // is not painted, so Chromium produces no frames and timers get throttled
    // for the whole run.
    let r = await raiseWindow(child.pid);
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
        document.readyState === 'complete' && !!document.getElementById('yt-btn'); } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded');
    check('controls.html is the live page', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page, 'document.visibilityState', v => v === 'visible', 24, 'page never became visible');
    check('controls.html is visible', r.ok === true, JSON.stringify(r.value));

    // The downloads dir the app will use must be the sandbox one.
    r = await page.ev('window.ghost.getDownloadDir ? window.ghost.getDownloadDir() : "n/a"');
    check('the app resolves the sandbox downloads folder',
      typeof r === 'string' && r.replace(/\//g, '\\').toLowerCase() === DL_DIR.toLowerCase(), JSON.stringify(r));

    // ── Phase A: the bridge ──────────────────────────────────────────────────
    console.log('\n-- Phase A: YouTube bridge --');
    for (const m of ['ytVideoInfo', 'ytStartDownload', 'ytCancelDownload', 'onYtProgress']) {
      r = await page.ev("typeof window.ghost." + m);
      check('ghost.' + m + ' is exposed', r === 'function', r);
    }

    // ── Phase B: button visibility follows the page ──────────────────────────
    console.log('\n-- Phase B: the button appears on YouTube --');
    r = await page.ev("(() => { const b = document.getElementById('yt-btn'); return { display: getComputedStyle(b).display, text: b.textContent.trim() }; })()");
    check('the Download button is hidden on a non-YouTube page',
      r && r.display === 'none', JSON.stringify(r));

    r = await page.ev("window.ghost.navigate(" + JSON.stringify(VIDEO_URL) + ")");
    r = await waitFor(page,
      "(() => { const b = document.getElementById('yt-btn'); return b && getComputedStyle(b).display !== 'none'; })()",
      v => v === true, 120, 'the Download button never appeared after opening YouTube');
    check('opening a YouTube video shows the Download button', r.ok === true, JSON.stringify(r.value));

    r = await page.ev("(() => { const b = document.getElementById('yt-btn'); return b.textContent.replace(/\\s+/g,' ').trim(); })()");
    check('the button is labelled "Download"', r === 'Download', r);

    // ── Phase C: the quality popover ─────────────────────────────────────────
    console.log('\n-- Phase C: quality picker --');
    r = await page.ev("(() => { document.getElementById('yt-btn').click(); return document.getElementById('ytp').classList.contains('open'); })()");
    check('pressing the button opens the quality popover', r === true, r);

    // The floating menu must fly back to its toolbar anchor ~5s later.
    const tOpen = Date.now();
    r = await waitFor(page, "!document.getElementById('ytp').classList.contains('open')",
      v => v === true, 30, 'the popover never auto-returned to the toolbar');
    const returnMs = Date.now() - tOpen;
    check('the popover auto-returns to the toolbar after ~5s',
      r.ok === true && returnMs < 9000, r.ok ? (returnMs + ' ms') : JSON.stringify(r.value));

    r = await waitFor(page, "document.querySelectorAll('.ytp-q').length",
      v => typeof v === 'number' && v >= 1, 300, 'no quality rows appeared (probe never finished)');
    check('the probe renders quality rows', r.ok === true, JSON.stringify(r.value));

    const rows = await page.ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.ytp-q'), (el) => ({
      h: parseInt(el.getAttribute('data-h'), 10),
      sel: el.classList.contains('sel'),
      size: (el.querySelector('.ytp-qs') || {}).textContent || '',
      def: !!el.querySelector('.ytp-qdef')
    })))`);
    let qrows = [];
    try { qrows = JSON.parse(rows); } catch (e) { qrows = []; }
    check('every row shows a size estimate', qrows.length > 0 && qrows.every((x) => x.size.trim().length > 0), rows);
    check('rows are ordered from highest to lowest',
      qrows.length > 1 && qrows.every((x, i) => i === 0 || qrows[i - 1].h >= x.h), rows);
    check('no quality above 1080p is offered', qrows.every((x) => x.h <= 1080), rows);
    check('exactly one row is preselected', qrows.filter((x) => x.sel).length === 1, rows);

    // On a video that offers 1080p, 1080p must be THE preselected default.
    const hdRow = qrows.find((x) => x.h === 1080);
    if (hdRow) {
      check('1080p is preselected (the always-default)', hdRow.sel === true, rows);
      check('the preselected row carries the Default badge', hdRow.def === true, rows);
    } else {
      console.log('  [info] this video does not offer 1080p — default is its highest row (' + (qrows[0] && qrows[0].h) + 'p)');
      check('the highest available row is preselected', qrows.length > 0 && qrows[0].sel === true, rows);
    }

    // ── The destination-folder row ───────────────────────────────────────────
    // The user picks where downloads go: bridge exposure, the row itself, and
    // the guarantee that automated runs never open a native folder dialog.
    r = await page.ev("(() => { const g = window.ghost || {}; return { pick: typeof g.ytPickDir, dir: typeof g.ytDownloadDir }; })()");
    check('the download-folder bridge is exposed',
      r && r.pick === 'function' && r.dir === 'function', JSON.stringify(r));

    r = await page.ev(`(() => {
      const b = document.getElementById('ytp-dir');
      if (!b) return null;
      return { title: b.title, path: ((b.querySelector('.ytp-dirp') || {}).textContent || ''),
               change: ((b.querySelector('.ytp-dirc') || {}).textContent || '').trim(),
               handler: typeof b.onclick === 'function' };
    })()`);
    check('the popover offers a download-folder row with a Change action',
      !!r && r.handler === true && /^change$/i.test(r.change), JSON.stringify(r));
    // The row must name the folder files actually land in — here the sandbox
    // folder pinned through AEGIS_DOWNLOADS_DIR (env beats any saved pick).
    check('the folder row points at the download directory',
      !!r && r.title === DL_DIR && /downloads/i.test(r.path),
      JSON.stringify(r) + ' vs ' + DL_DIR);

    r = await page.ev("window.ghost.ytDownloadDir()");
    check('ytDownloadDir() reports the pinned folder (read-only, no dialog)',
      r === DL_DIR, JSON.stringify(r));

    // yt-pick-dir short-circuits while the folder is pinned: it must resolve
    // null at once instead of opening a native dialog that would stall the run.
    r = await page.ev(`(async () => {
      const t0 = Date.now();
      let v, err = '';
      try {
        v = await Promise.race([
          window.ghost.ytPickDir(),
          new Promise((res) => setTimeout(() => res('TIMEOUT'), 4000))
        ]);
      } catch (e) { err = (e && e.message) || 'error'; }
      return { isNull: v === null, timedOut: v === 'TIMEOUT', ms: Date.now() - t0, err: err };
    })()`);
    check('the picker never opens a dialog while the folder is pinned',
      r && r.isNull === true && !r.timedOut && !r.err && r.ms < 3500, JSON.stringify(r));

    // ── AEGIS menu → Youtube Download parameters ─────────────────────────────
    // The menu entry opens its own window in main (not reachable from this
    // renderer), so exercise the bridge that window drives: read the current
    // folder, choose (draft only), Save (persist — refused while pinned) and
    // reset (back to the Parameters default — also refused while pinned).
    // Plus the Parameters window's own default-folder bridges (dlParams /
    // setDownloadDir / chooseDownloadDir is shared with Youtube parameters).
    r = await page.ev(`(() => {
      const g = window.ghost || {};
      return { ytParams: typeof g.ytDlParams, ytSet: typeof g.ytSetDownloadDir, ytReset: typeof g.ytResetDownloadDir,
               dlParams: typeof g.dlParams, dlSet: typeof g.setDownloadDir, choose: typeof g.chooseDownloadDir };
    })()`);
    check('all six download-folder bridges are exposed',
      r && r.ytParams === 'function' && r.ytSet === 'function' && r.ytReset === 'function' &&
      r.dlParams === 'function' && r.dlSet === 'function' && r.choose === 'function', JSON.stringify(r));

    r = await page.ev("window.ghost.ytDlParams()");
    check('ytDlParams() reports the pinned folder',
      !!r && r.dir === DL_DIR && r.pinned === true, JSON.stringify(r));
    check('ytDlParams() follows the default folder (no dedicated YouTube folder)',
      !!r && r.custom === false && typeof r.defaultDir === 'string' && r.defaultDir.length > 0, JSON.stringify(r));

    r = await page.ev("window.ghost.dlParams()");
    check('dlParams() reports the default download folder (pinned)',
      !!r && r.dir === DL_DIR && r.pinned === true, JSON.stringify(r));

    // Choosing must stay dialog-free while pinned — same guard as the popover.
    r = await page.ev(`(async () => {
      const t0 = Date.now();
      let v, err = '';
      try {
        v = await Promise.race([
          window.ghost.chooseDownloadDir(),
          new Promise((res) => setTimeout(() => res('TIMEOUT'), 4000))
        ]);
      } catch (e) { err = (e && e.message) || 'error'; }
      return { path: (v && v.path) || null, pinned: !!(v && v.pinned), timedOut: v === 'TIMEOUT',
               ms: Date.now() - t0, err: err };
    })()`);
    check('the shared folder chooser never opens a dialog while the folder is pinned',
      r && r.path === null && r.pinned === true && !r.timedOut && !r.err && r.ms < 3500, JSON.stringify(r));

    // Save must be refused while pinned: the guard runs before any validation
    // or persistence, so no preference file can be written by an automated run.
    r = await page.ev("window.ghost.ytSetDownloadDir('C:\\\\AEGIS-must-not-be-written')");
    check('saving a YouTube folder is refused while the folder is pinned',
      !!r && r.ok === false && r.pinned === true, JSON.stringify(r));

    r = await page.ev("window.ghost.setDownloadDir('C:\\\\AEGIS-must-not-be-written')");
    check('saving the default download folder is refused while pinned',
      !!r && r.ok === false && r.pinned === true, JSON.stringify(r));

    r = await page.ev("window.ghost.ytResetDownloadDir()");
    check('resetting the YouTube folder is refused while pinned',
      !!r && r.ok === false && r.pinned === true, JSON.stringify(r));

    // ── Ghost Mode badge: Anonymous (guest) mode only ─────────────────────────
    // This run signs in with a registered account, so the top-bar badge must
    // stay hidden (it is revealed only when get-user reports guest: true).
    r = await page.ev(`(() => {
      const b = document.getElementById('badge');
      if (!b) return null;
      const cs = getComputedStyle(b);
      return { display: cs.display, visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length) };
    })()`);
    check('the Ghost Mode badge is hidden for a registered account',
      !!r && (r.display === 'none' || r.visible === false), JSON.stringify(r));

    const goText = await page.ev("(() => { const g = document.getElementById('ytp-go'); return g ? g.textContent.trim() : null; })()");
    check('the footer button names the selected quality',
      typeof goText === 'string' && /^Download \d+p$/.test(goText), JSON.stringify(goText));

    // ── Phase D: pick a quality and download it ──────────────────────────────
    console.log('\n-- Phase D: choosing a quality and downloading --');
    // Select the lowest row explicitly — proves the choice drives the download.
    r = await page.ev(`(() => {
      const rows = document.querySelectorAll('.ytp-q');
      const last = rows[rows.length - 1];
      window.__ytPicked = parseInt(last.getAttribute('data-h'), 10);
      last.click();
      const sel = document.querySelector('.ytp-q.sel');
      return { picked: window.__ytPicked, nowSel: sel ? parseInt(sel.getAttribute('data-h'), 10) : null,
               go: (document.getElementById('ytp-go') || {}).textContent };
    })()`);
    check('clicking a quality row selects it', r && r.picked === r.nowSel, JSON.stringify(r));
    check('the footer button follows the new selection',
      r && r.go && r.go.replace(/\s+/g, ' ').trim() === 'Download ' + r.picked + 'p', JSON.stringify(r));

    // Install progress + mirror listeners before pressing the button.
    r = await page.ev(`(() => {
      window.__yt = { phases: [], events: 0, pcts: [], mirror: [], last: null };
      window.ghost.onYtProgress(d => {
        window.__yt.events++;
        window.__yt.last = d;
        if (d && d.phase && window.__yt.phases.indexOf(d.phase) < 0) window.__yt.phases.push(d.phase);
        if (d && typeof d.pct === 'number') window.__yt.pcts.push(d.pct);
      });
      window.ghost.onDownloadProgress(d => { window.__yt.mirror.push(d); });
      return true;
    })()`);
    check('progress listeners are registered before downloading', r === true, r);

    // Press Download while the popover is open.
    r = await page.ev("(() => { document.getElementById('ytp-go').click(); return true; })()");
    check('pressing Download starts the job', r === true, r);

    r = await waitFor(page,
      "(() => { const b = document.querySelector('#ytp .ytp-bar i'); return b ? b.style.width : null; })()",
      v => typeof v === 'string' && v !== '' && v !== '0%', 240, 'the progress bar never started moving');
    check('live progress is rendered in the popover', r.ok === true, JSON.stringify(r.value));

    if (process.env.AEGIS_SHOT) {
      try {
        const p = await page.shot(process.env.AEGIS_SHOT);
        check('screenshot of the working popover captured', fs.existsSync(p), p);
        console.log('  [info] screenshot: ' + p);
      } catch (e) { check('screenshot of the working popover captured', false, e.message); }
    }

    // Close the popover mid-download: the download must survive it.
    r = await page.ev("(() => { document.getElementById('ytp-x').click(); return !document.getElementById('ytp').classList.contains('open'); })()");
    check('the popover can be closed while the download continues', r === true, r);

    r = await waitFor(page, "(() => { const l = document.querySelector('#yt-btn .yt-lbl'); return l ? l.textContent : null; })()",
      v => typeof v === 'string' && /%$/.test(v), 60, 'the toolbar button never showed a live percentage');
    check('the toolbar button shows the live percentage while closed', r.ok === true, JSON.stringify(r.value));

    // The completion (or a clearly rendered failure) must arrive eventually.
    r = await waitFor(page,
      `(() => { const p = window.__yt ? window.__yt.phases : []; return p.indexOf('done') >= 0 || p.indexOf('error') >= 0 || p.indexOf('canceled') >= 0; })()`,
      v => v === true, 600, 'the download never finished (300 s)');
    check('the download reaches a terminal state', r.ok === true, JSON.stringify(r.value));

    const dstate = await page.ev("JSON.stringify(window.__yt.last)");
    let dlast = {};
    try { dlast = JSON.parse(dstate); } catch (e) {}
    check('the download completed successfully', dlast.phase === 'done', dstate);
    check('the completion names the saved file',
      dlast.phase === 'done' && typeof dlast.name === 'string' && dlast.name.indexOf('[' + VIDEO_ID + ']') >= 0, dstate);
    check('the completion reports a real size', dlast.phase === 'done' && dlast.size > 0, dstate);

    // The completion event echoes the height that was requested — it must be
    // exactly the row the user clicked, not the always-default 1080p.
    const picked = await page.ev("window.__ytPicked || null");
    check('the download used the quality the user picked',
      dlast.phase === 'done' && typeof picked === 'number' && dlast.height === picked,
      JSON.stringify({ picked, completedHeight: dlast.height }));

    // The file really is on disk, is an MP4, and lives in the SANDBOX folder.
    const landed = dlFilesFor(VIDEO_ID);
    check('the video file landed in the sandbox downloads folder', landed.length >= 1, JSON.stringify(landed));
    const landedPath = landed.length ? path.join(DL_DIR, landed[0]) : null;
    let landedSize = 0;
    if (landedPath) { try { landedSize = fs.statSync(landedPath).size; } catch (e) {} }
    check('the downloaded file has a plausible size', landedSize > 10000, String(landedSize));
    check('the downloaded file is a real MP4 (ftyp signature)', landedPath ? mp4Signature(landedPath) : false, String(landedPath));
    check('no partial-file debris is left behind',
      dlFilesFor(VIDEO_ID).every((n) => /\.(mp4|m4a|mkv|webm)$/.test(n)), JSON.stringify(dlFilesFor(VIDEO_ID)));

    // It must also appear in the regular Downloads panel as completed.
    r = await page.ev("(() => { document.getElementById('dl-btn').click(); return true; })()");
    check('the Downloads panel button responds', r === true, r);
    // The panel applies its 'open' class on the next frame — poll for it.
    r = await waitFor(page,
      "(() => { const p = document.getElementById('dlp'); return p ? p.classList.contains('open') : false; })()",
      v => v === true, 20, 'the Downloads panel never opened');
    check('the Downloads panel opens', r.ok === true, JSON.stringify(r.value));
    r = await waitFor(page,
      "(() => { const l = document.getElementById('dll'); return l ? l.innerHTML.indexOf('" + VIDEO_ID + "') >= 0 : false; })()",
      v => v === true, 40, 'the video never showed up in the Downloads panel');
    check('the video appears in the Downloads panel', r.ok === true, JSON.stringify(r.value));

    const mirror = await page.ev("JSON.stringify(window.__yt.mirror.map(d => ({ id: d.id, done: d.done, success: d.success, total: d.total, received: d.received, ws: d.ws })))");
    let mrows = [];
    try { mrows = JSON.parse(mirror); } catch (e) {}
    check('the Downloads panel received mirrored progress events', mrows.length >= 2, mirror);
    check('the mirrored entry finished successfully',
      mrows.some((d) => d.done === true && d.success === true && d.total > 0), mirror);

    // Close the panel again.
    await page.ev("(() => { const c = document.getElementById('cdl'); if (c) c.click(); return true; })()");

    // ── Phase E: 1080p default + cancel ──────────────────────────────────────
    console.log('\n-- Phase E: 1080p default and cancel --');
    await page.ev("window.ghost.navigate(" + JSON.stringify(HD_URL) + ")");
    r = await waitFor(page,
      "(() => { const b = document.getElementById('yt-btn'); return b && getComputedStyle(b).display !== 'none'; })()",
      v => v === true, 120, 'the button never appeared on the HD video page');
    check('the button is still there on another YouTube page', r.ok === true, JSON.stringify(r.value));

    // Re-open: the popover must re-probe THIS video (no stale qualities).
    const preClick = await page.ev(`(() => {
      const el = document.getElementById('ytp');
      return JSON.stringify({ phase: (typeof ytpPhase !== 'undefined') ? ytpPhase : 'n/a',
        open: (typeof ytpOpen !== 'undefined') ? ytpOpen : 'n/a',
        seen: (typeof ytpSeenUrl !== 'undefined') ? ytpSeenUrl : 'n/a',
        active: (typeof ytActiveUrl === 'function') ? ytActiveUrl() : 'n/a',
        cls: el ? el.className : null });
    })()`);
    console.log('  [info] popover state before the re-open click: ' + preClick);
    r = await page.ev("(() => { document.getElementById('yt-btn').click(); return true; })()");
    r = await waitFor(page, "document.querySelectorAll('.ytp-q').length",
      v => typeof v === 'number' && v >= 1, 300, 'the popover never re-probed the new video');
    check('the popover re-probes after switching videos', r.ok === true, JSON.stringify(r.value));
    if (!r.ok) {
      // Say WHY: a spinner means the yt-dlp probe outran the wait window, an
      // error box names the probe failure, anything else is a render problem.
      const popState = await page.ev(`(() => {
        const err = document.querySelector('.ytp-err');
        const body = document.getElementById('ytp-body');
        const el = document.getElementById('ytp');
        return JSON.stringify({ phase: (typeof ytpPhase !== 'undefined') ? ytpPhase : 'n/a',
          open: (typeof ytpOpen !== 'undefined') ? ytpOpen : 'n/a',
          seen: (typeof ytpSeenUrl !== 'undefined') ? ytpSeenUrl : 'n/a',
          active: (typeof ytActiveUrl === 'function') ? ytActiveUrl() : 'n/a',
          cls: el ? el.className : null,
          loading: !!document.querySelector('.ytp-load'),
          err: err ? err.textContent : null,
          body: body ? body.innerText.replace(/\\s+/g, ' ').slice(0, 240) : null });
      })()`);
      console.log('  [info] HD popover state at timeout: ' + popState);
    }

    const hdInfo = await page.ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.ytp-q'), (el) => ({
      h: parseInt(el.getAttribute('data-h'), 10),
      sel: el.classList.contains('sel'),
      def: !!el.querySelector('.ytp-qdef')
    })))`);
    let hdRows = [];
    try { hdRows = JSON.parse(hdInfo); } catch (e) {}
    const hd1080 = hdRows.find((x) => x.h === 1080);
    if (hd1080) {
      check('1080p is offered on this video', true);
      check('1080p is preselected with the Default badge', hd1080.sel === true && hd1080.def === true, hdInfo);
    } else {
      console.log('  [info] HD video offers no 1080p right now: ' + hdInfo);
      check('1080p is offered on this video', false, hdInfo);
    }

    const hdGo = await page.ev("(() => { const g = document.getElementById('ytp-go'); return g ? g.textContent.replace(/\\s+/g,' ').trim() : null; })()");
    check('the footer offers the 1080p download', hdGo === 'Download 1080p', JSON.stringify(hdGo));

    // Start the (large) 1080p download, then cancel it mid-flight.
    await page.ev(`(() => {
      window.__yt2 = { phases: [], events: 0, pcts: [] };
      window.ghost.onYtProgress(d => {
        window.__yt2.events++;
        if (d && d.phase && window.__yt2.phases.indexOf(d.phase) < 0) window.__yt2.phases.push(d.phase);
        if (d && typeof d.pct === 'number') window.__yt2.pcts.push(d.pct);
      });
      document.getElementById('ytp-go').click();
      return true;
    })()`);

    r = await waitFor(page, "(window.__yt2 ? window.__yt2.pcts.length : 0) > 0",
      v => v === true, 300, 'the 1080p download never started making progress');
    check('the 1080p download starts', r.ok === true, JSON.stringify(r.value));

    r = await page.ev("(() => { const c = document.getElementById('ytp-cancel'); if (c) c.click(); return !!c; })()");
    check('a Cancel button is offered while downloading', r === true, r);

    r = await waitFor(page,
      "(() => { const p = window.__yt2 ? window.__yt2.phases : []; return p.indexOf('canceled') >= 0 || p.indexOf('done') >= 0 || p.indexOf('error') >= 0; })()",
      v => v === true, 240, 'the cancel never took effect (120 s)');
    check('canceling reports the canceled state', r.ok === true, JSON.stringify(r.value));

    const cstate = await page.ev("JSON.stringify(window.__yt2.phases)");
    check('the cancel was honored (not completed)', /canceled/.test(String(cstate)), cstate);

    r = await waitFor(page, "(() => { const rows = document.querySelectorAll('.ytp-q'); return rows.length > 0; })()",
      v => v === true, 60, 'the popover never returned to the picker after cancel');
    check('the popover returns to the quality picker after cancel', r.ok === true, JSON.stringify(r.value));

    // The killed job must not leave partial files in the downloads folder.
    const hdDebris = dlFilesFor(HD_ID);
    check('no partial-file debris is left after canceling', hdDebris.length === 0, JSON.stringify(hdDebris));

    // A second download must be possible after a cancel.
    const realStillThere = realDownloadsWithId(VIDEO_ID).length === realDlBeforeV.length;
    check('the earlier completed download is untouched by the cancel',
      dlFilesFor(VIDEO_ID).length >= 1 && realStillThere, JSON.stringify(dlFilesFor(VIDEO_ID)));

    await page.ev("(() => { const x = document.getElementById('ytp-x'); if (x) x.click(); return true; })()");

    // ── Phase F: leaving YouTube hides the button ────────────────────────────
    console.log('\n-- Phase F: leaving YouTube --');
    await page.ev("window.ghost.navigate('https://example.com')");
    r = await waitFor(page,
      "(() => { const b = document.getElementById('yt-btn'); return b && getComputedStyle(b).display === 'none'; })()",
      v => v === true, 60, 'the Download button stayed visible off YouTube');
    check('the Download button disappears off YouTube', r.ok === true, JSON.stringify(r.value));
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
  } finally {
    await killApp(page);
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
  check('the real Downloads folder gained no test video',
    realDownloadsWithId(VIDEO_ID).length === realDlBeforeV.length &&
    realDownloadsWithId(HD_ID).length === realDlBeforeH.length,
    JSON.stringify({ video: realDownloadsWithId(VIDEO_ID), hd: realDownloadsWithId(HD_ID) }));

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
})();
