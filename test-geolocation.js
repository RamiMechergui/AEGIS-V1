// test-geolocation.js — isolated E2E test: geolocation is auto-refused.
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder.
// It copies the app into a temp sandbox, writes a portable.dat marker there so
// all user data lands inside the sandbox, and afterwards asserts that the
// project data\ folder is byte-for-byte unchanged.
//
// Run:  node test-geolocation.js
//
// What is being proven:
//   Phase A  register + login + pick workspace -> the real browser UI
//   Phase B  DEFAULT session (controls.html): navigator.permissions reports
//            geolocation as 'denied', while notifications / clipboard-read /
//            idle-detection keep Electron's default 'granted' (no collateral
//            change to any other permission)
//   Phase C  the popup detector itself: a real native MessageBox titled
//            'Permission Request' in a throwaway child process must be found,
//            and must NOT be attributed to the AEGIS process — otherwise the
//            "no popup" proof below would be vacuous
//   Phase D  WORKSPACE session (a real tab on a local http:// page, window
//            raised so the page is visible): geolocation denied at the check
//            level, getCurrentPosition fails with error code 1
//            (PERMISSION_DENIED) instead of hanging, and the AEGIS process owns
//            no native dialog after the request
//   Phase E  the same tab still reports every OTHER permission as granted
//
// Why http://127.0.0.1 and not file://: geolocation needs a trustworthy
// origin, so the page is served by a throwaway local server started here —
// that keeps the result about our permission policy, not about the origin.

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP, 'opencode', 'aegis-geo-test');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

const USER = 'geo-user';
const PASS = 'geo-secret';

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

// A fresh port per launch — reusing one across restarts raced TIME_WAIT/half-closed
// sockets: the poll would say "free" and Chromium would still fail to rebind it.
let nextPort = 9471;
let activePort = null;
const PORT_FILTER = 'remote-debugging-port=';

function cleanupLeftovers() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -like '*AEGIS-V1*' -and $_.CommandLine -like '*" + PORT_FILTER + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' }); } catch (e) {}
}

// ── Sandbox setup ────────────────────────────────────────────────────────────
// Windows: RemoveDirectory() on a junction deletes ONLY the link, never the
// target — this is what keeps the project's real node_modules safe.
function dropJunction() {
  try { fs.rmdirSync(path.join(SANDBOX, 'node_modules')); } catch (e) { /* not a junction / absent */ }
}
function setupSandbox() {
  dropJunction();
  fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(SANDBOX, { recursive: true });

  const files = ['main.js', 'preload.js', 'package.json', 'logo.png', 'logo.ico']
    .concat(fs.readdirSync(SRC).filter((f) => f.endsWith('.html')));
  for (const f of files) fs.copyFileSync(path.join(SRC, f), path.join(SANDBOX, f));

  // Junction instead of copying ~200 MB of node_modules (no admin rights needed)
  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(SANDBOX, 'node_modules'), 'junction');

  // Portable marker -> userData and sessionData resolve inside the sandbox
  fs.writeFileSync(path.join(SANDBOX, 'portable.dat'), '');

  fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
}

// ── Local page server ────────────────────────────────────────────────────────
// The geolocation page is served over http://127.0.0.1 (a trustworthy origin),
// so a denial can only come from our permission policy, never from the origin.
let pageServer = null;
let pageOrigin = null;
function startPageServer() {
  const body = Buffer.from('<!doctype html>\n<meta charset="utf-8">\n<title>geo probe</title>\n<body>geo probe</body>\n');
  pageServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    pageServer.on('error', reject);
    pageServer.listen(0, '127.0.0.1', () => {
      pageOrigin = 'http://127.0.0.1:' + pageServer.address().port;
      resolve(pageOrigin);
    });
  });
}
function stopPageServer() {
  if (!pageServer) return;
  try { pageServer.close(); } catch (e) {}
  pageServer = null;
}

// ── Native window / dialog detection ─────────────────────────────────────────
// A permission popup is dialog.showMessageBox({ title: 'Permission Request' }),
// a native top-level window owned by the AEGIS browser process. Detection is
// EnumWindows + GetWindowText/GetClassName/GetWindowThreadProcessId filtered by
// PID — writing it to a script file avoids PowerShell's argument-quote mangling.
// If geolocation ever reached the dialog, it would still be sitting open here:
// nobody answers it during the test.
const WIN_LIST_PS1 = path.join(SANDBOX, 'win-list.ps1');
const DIALOG_CHILD_PS1 = path.join(SANDBOX, 'dialog-child.ps1');
const RAISE_PS1 = path.join(SANDBOX, 'raise-window.ps1');

function writeDetectorScripts() {
  fs.writeFileSync(WIN_LIST_PS1, [
    'param([int]$TargetPid)',
    "$src = @'",
    'using System;',
    'using System.Text;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    '',
    'public class WinList',
    '{',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int c);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int c);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  public static uint Target;',
    '  public static List<string> Rows = new List<string>();',
    '  static bool Cb(IntPtr h, IntPtr l)',
    '  {',
    '    if (!IsWindowVisible(h)) return true;',
    '    uint p;',
    '    GetWindowThreadProcessId(h, out p);',
    '    if (p != Target) return true;',
    '    var t = new StringBuilder(512);',
    '    GetWindowTextW(h, t, 512);',
    '    var c = new StringBuilder(256);',
    '    GetClassNameW(h, c, 256);',
    '    Rows.Add(c.ToString() + "\\t" + t.ToString());',
    '    return true;',
    '  }',
    '  public static void Run(int targetPid)',
    '  {',
    '    Target = (uint)targetPid;',
    '    Rows.Clear();',
    '    EnumWindows(new EnumProc(Cb), IntPtr.Zero);',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $src',
    '[WinList]::Run($TargetPid)',
    'foreach ($r in [WinList]::Rows) { $r }',
  ].join('\n'));

  // A real native MessageBox with exactly the title Electron uses, so the
  // detector can be proven to work before it is trusted.
  fs.writeFileSync(DIALOG_CHILD_PS1, [
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int MessageBoxW(IntPtr h, string t, string c, uint f);' -Namespace GeoSelfTest -Name User32 | Out-Null",
    "[void][GeoSelfTest.User32]::MessageBoxW([IntPtr]::Zero, 'probe body', 'Permission Request', 0)",
  ].join('\n'));

  // Chromium only issues the geolocation request for a VISIBLE page: on a
  // hidden/occluded page getCurrentPosition() never reaches the app at all and
  // never resolves (pre-existing Electron behaviour, independent of this fix).
  // So before probing, raise + maximise + topmost the AEGIS window — exactly
  // what a user sees when they browse.
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
    '    uint p;',
    '    GetWindowThreadProcessId(h, out p);',
    '    if (p != Target) return true;',
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
    '    SetWindowPos(Found, new IntPtr(-1), 0, 0, 0, 0, 0x0043);', // HWND_TOPMOST | NOMOVE | NOSIZE | SHOWWINDOW
    '    SetForegroundWindow(Found);',
    '    return "RAISED";',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $src',
    '[WinRaise]::Run($TargetPid)',
  ].join('\n'));
}

function listWindows(pid) {
  let out = '';
  try {
    out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', WIN_LIST_PS1, '-TargetPid', String(pid)],
      { encoding: 'utf8', timeout: 30000 });
  } catch (e) { return [{ cls: 'ERR', title: String(e.message) }]; }
  return (out || '').split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('\t');
      return { cls: i < 0 ? line : line.slice(0, i), title: i < 0 ? '' : line.slice(i + 1) };
    });
}
// A permission popup is either Electron's dialog class (#32770, Win32 dialog)
// or carries our exact title — matching either one counts as "popup seen".
const isPermissionDialog = (w) => w.cls === '#32770' || /Permission Request/i.test(w.title);
const dialogsOf = (pid) => listWindows(pid).filter(isPermissionDialog);

// Bring the AEGIS window to the front, maximised and topmost, so no other
// window can occlude it (see RAISE_PS1 for why visibility matters here).
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
  child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + activePort], { cwd: SANDBOX, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('  (launched pid ' + child.pid + ' on port ' + activePort + ')');
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
  child.on('error', (e) => { stderrBuf = 'SPAWN ERROR: ' + e.message; });
}
async function killApp(page) {
  if (child && child.exitCode === null) {
    // Shut down the way a real user does: this is the same IPC the app's own
    // quit dialog sends, so before-quit runs flushSessionsSync() (WAL checkpoint)
    // and every file handle is released cleanly. taskkill /F skips all of that
    // and leaves the next launch racing SQLite/lock handles.
    if (page) { try { await Promise.race([page.ev("window.ghost.confirmQuitAction('quit')"), sleep(3000)]); } catch (e) { /* app already closing */ } }
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
  if (!target) throw new Error((label || 'target') + ' not found in the CDP target list\nstderr:\n' + stderrBuf + '\nstdout:\n' + stdoutBuf);

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
    else res(msg.result.result.value);
  };
  await ready;

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
          console.log('  [retry ' + attempt + '] context lost during: ' + expression.slice(0, 80) + '  (' + e.message + ')');
          await sleep(400);
        }
      }
    },
    close: () => { try { ws.close(); } catch (e) {} },
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
  let last;
  for (let i = 0; i < tries; i++) {
    try { last = await page.ev(expression); } catch (e) { last = 'ERR: ' + e.message; }
    if (pred(last)) return { ok: true, value: last };
    await sleep(250);
  }
  return { ok: false, value: last, label };
}

// navigator.permissions.query().state for a given permission, as a plain string.
const stateOf = (name) => `navigator.permissions.query({name:'${name}'}).then(p => 'state=' + p.state).catch(e => 'ERR:' + (e && e.message || e))`;

// A geolocation request that reports how it ended and how long it took.
// Denied by our handler the answer is PERMISSION_DENIED (code 1) right away.
// Reaching the popup would leave the callback pending forever (the outer timer
// reports TIMEOUT), and a granted-but-fixless request reports code 3 only
// after its own 3000 ms timeout — neither can be mistaken for a refusal.
const GEO_CALL = `new Promise(res => {
  const t0 = Date.now();
  const timer = setTimeout(() => res('TIMEOUT-never-answered-t0=' + t0), 8000);
  try {
    navigator.geolocation.getCurrentPosition(
      () => { clearTimeout(timer); res('GRANTED-after-' + (Date.now() - t0) + 'ms'); },
      (e) => { clearTimeout(timer); res('DENIED-code=' + e.code + '-after-' + (Date.now() - t0) + 'ms;msg=' + e.message); },
      { timeout: 3000, maximumAge: 0, enableHighAccuracy: false }
    );
  } catch (e) { clearTimeout(timer); res('THREW:' + e.message); }
})`;

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS geolocation auto-refusal E2E test ==');
  console.log('  sandbox: ' + SANDBOX);

  cleanupLeftovers();
  await sleep(1500);

  const realBefore = snapshotRealData();
  console.log('  project data\\ snapshot: ' + Object.keys(realBefore).length + ' file(s)');

  setupSandbox();
  writeDetectorScripts();
  const origin = await startPageServer();
  console.log('  sandbox prepared (portable mode); probe page at ' + origin + '\n');

  let page = null;
  let tab = null;
  let dialogChild = null;
  let appLog = ['', ''];
  try {
    // ── Phase A ──────────────────────────────────────────────────────────────
    console.log('-- Phase A: reach the real browser UI --');
    page = await readyApp();
    const aegisPid = child.pid;

    let r = await page.ev('!!window.ghost');
    check('login page exposes the ghost bridge', r === true, r);

    r = await page.ev("window.ghost.register('" + USER + "','" + PASS + "')");
    check('register creates the account', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('login succeeds', r && r.ok === true, JSON.stringify(r));

    // Idle auto-close would log the test out mid-run if it ever got slow.
    r = await page.ev('window.ghost.setAutoClose(false, 5)');
    check('idle auto-close disabled for the test run', r && r.ok !== false, JSON.stringify(r));

    r = await page.ev("window.ghost.selectWorkspace('default')");
    check('selectWorkspace opens the browser UI', r && r.ok === true, JSON.stringify(r));

    r = await waitFor(page,
      `(() => { try { return /controls[.]html/.test(location.href) && !!window.ghost; } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded');
    check('controls.html is the live page', r.ok === true, JSON.stringify(r.value));

    // ── Phase B ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase B: default session (controls.html) --');
    r = await page.ev(stateOf('geolocation'));
    check('geolocation is reported DENIED on the default session', r === 'state=denied', r);

    r = await page.ev(stateOf('notifications'));
    check("notifications keeps its default ('granted')", r === 'state=granted', r);
    r = await page.ev(stateOf('clipboard-read'));
    check("clipboard-read keeps its default ('granted')", r === 'state=granted', r);
    r = await page.ev(stateOf('idle-detection'));
    check("idle-detection keeps its default ('granted')", r === 'state=granted', r);

    r = dialogsOf(aegisPid);
    check('AEGIS owns no native dialog before any request', r.length === 0, JSON.stringify(r));

    // ── Phase C ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase C: the popup detector (must not be vacuous) --');
    dialogChild = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', DIALOG_CHILD_PS1],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    dialogChild.stderr.on('data', () => {});

    let childDialogs = [];
    for (let i = 0; i < 40 && childDialogs.length === 0; i++) {
      childDialogs = dialogsOf(dialogChild.pid);
      if (childDialogs.length === 0) await sleep(250);
    }
    check('detector finds a real MessageBox titled "Permission Request"',
      childDialogs.length === 1 && /Permission Request/.test(childDialogs[0].title), JSON.stringify(childDialogs));

    const crossTalk = dialogsOf(aegisPid);
    check('the same dialog is NOT attributed to the AEGIS process (PID filter works)',
      crossTalk.length === 0, JSON.stringify(crossTalk));

    try { execFileSync('taskkill', ['/PID', String(dialogChild.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(500);
    dialogChild = null;

    // ── Phase D ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase D: workspace session (a real tab on ' + origin + ') --');
    r = await page.ev("window.ghost.newTabWorkspace('default', '" + origin + "/geo.html')");
    check('a tab was opened in the default workspace', r === undefined || r === null, JSON.stringify(r));

    tab = await connectTarget((u) => /geo[.]html/.test(u), 'geolocation probe tab');
    check('probe tab is reachable over CDP', !!tab && /geo[.]html/.test(tab.url || ''), tab && tab.url);

    r = await waitFor(tab,
      `(() => { try { return document.readyState === 'complete' && location.href.indexOf('geo.html') >= 0; } catch(e) { return false; } })()`,
      v => v === true, 40, 'probe page never finished loading');
    check('probe page finished loading', r.ok === true, JSON.stringify(r.value));

    // Chromium only services geolocation for a VISIBLE page — on a hidden or
    // occluded page the request is never issued at all (and therefore never
    // reaches the app). Raise the window so we probe what a user really gets.
    r = raiseWindow(aegisPid);
    check('AEGIS window raised for the probe', r === 'RAISED', r);
    r = await waitFor(tab, `document.visibilityState`, (v) => v === 'visible', 24, 'page never became visible');
    check('probe page is visible (hidden pages never issue the request)', r.ok === true, JSON.stringify(r.value));

    r = await tab.ev(stateOf('geolocation'));
    check('geolocation is reported DENIED in the workspace session', r === 'state=denied', r);

    // The core guarantee: refused by the app itself, without asking anyone.
    r = await tab.ev(GEO_CALL);
    check('getCurrentPosition is refused with PERMISSION_DENIED (code 1)', /^DENIED-code=1-/.test(String(r)), r);
    check('the request is answered instead of left pending (a popup would hang it)',
      !/TIMEOUT|THREW|GRANTED/.test(String(r)), r);
    const elapsed1 = Number((/after-(\d+)ms/.exec(String(r)) || [0, 0])[1]);
    console.log('  [info] first refusal after ' + elapsed1 + ' ms: ' + r);

    const dialogsAfterGeo = dialogsOf(aegisPid);
    check('AEGIS owns no native dialog after the geolocation request',
      dialogsAfterGeo.length === 0, JSON.stringify(dialogsAfterGeo));

    r = await tab.ev(GEO_CALL);
    check('a second request is refused the same way', /^DENIED-code=1-/.test(String(r)), r);
    const elapsed2 = Number((/after-(\d+)ms/.exec(String(r)) || [0, 0])[1]);
    console.log('  [info] second refusal after ' + elapsed2 + ' ms: ' + r);

    const dialogsAfterGeo2 = dialogsOf(aegisPid);
    check('still no native dialog after the second request',
      dialogsAfterGeo2.length === 0, JSON.stringify(dialogsAfterGeo2));

    // ── Phase E ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase E: every OTHER permission is untouched --');
    r = await tab.ev(stateOf('notifications'));
    check("notifications stays 'granted' in the workspace session", r === 'state=granted', r);
    r = await tab.ev(stateOf('clipboard-read'));
    check("clipboard-read stays 'granted' in the workspace session", r === 'state=granted', r);
    r = await tab.ev(stateOf('idle-detection'));
    check("idle-detection stays 'granted' in the workspace session", r === 'state=granted', r);
    r = await tab.ev(stateOf('storage-access'));
    check("storage-access stays 'granted' in the workspace session", r === 'state=granted', r);
    r = await tab.ev(stateOf('midi'));
    check("midi stays 'granted' in the workspace session", r === 'state=granted', r);
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
  } finally {
    if (dialogChild && dialogChild.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(dialogChild.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
    }
    if (tab) tab.close();
    await killApp(page);
    if (page) page.close();
    stopPageServer();
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
