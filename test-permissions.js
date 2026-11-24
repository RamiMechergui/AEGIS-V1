// test-permissions.js — isolated E2E test: 'persistent-storage' and
// 'clipboard-sanitized-write' are approved SILENTLY (no dialog ever), while
// every other permission keeps its existing policy.
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder.
// It copies the app into a temp sandbox, writes a portable.dat marker there so
// all user data lands inside the sandbox, and afterwards asserts that the
// project data\ folder is byte-for-byte unchanged.
//
// Run:  node test-permissions.js
// Env:  needs internet for one probe (a real https:// example.com tab)
//
// What is being proven:
//   Phase A  register + login + pick workspace -> the real browser UI
//   Phase B  the popup detector itself: a real native MessageBox titled
//            'Permission Request' in a throwaway child process must be found,
//            and must NOT be attributed to the AEGIS process — otherwise every
//            "no popup" proof below would be vacuous
//   Phase C  DEFAULT session (controls.html): navigator.storage.persist() and
//            navigator.clipboard.writeText() both resolve granted — twice —
//            and AEGIS owns no native dialog at any point (a still-active
//            dialog would hang the request into the TIMEOUT branch instead)
//   Phase D  WORKSPACE session: a real tab on a local http:// page (window
//            raised so the page is visible), the same two requests granted
//            without a dialog; a SECOND tab proves the policy follows the
//            session, not one lucky tab
//   Phase D2 a brand-new WORKSPACE (created + switched to through the real
//            bridge, so it gets its own partition) and a real third-party
//            HTTPS website (https://example.com) both get the same silent
//            approval — then the original workspace is re-activated so the
//            camera probe below runs on a visible page again
//   Phase E  negative control — policy preserved: camera still raises the
//            native Allow/Deny dialog (then it is dismissed again),
//            clipboard-read and geolocation keep their existing answers
//   Phase F  restart AEGIS: both permissions are still approved silently
//
// Why http://127.0.0.1 for the workspace phases: a trustworthy origin, so the
// result is about our permission policy, never about the origin.

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP, 'opencode', 'aegis-perm-test');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

const USER = 'perm-user';
const PASS = 'perm-secret';

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
let nextPort = 9481;
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

// ── Local page server ────────────────────────────────────────────────────────
// The workspace probe page is served over http://127.0.0.1 (a trustworthy
// origin), so the outcome can only come from our permission policy.
let pageServer = null;
let pageOrigin = null;
function startPageServer() {
  const body = Buffer.from('<!doctype html>\n<meta charset="utf-8">\n<title>perm probe</title>\n<body>perm probe</body>\n');
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
// PID — writing scripts to files avoids PowerShell's argument-quote mangling.
const WIN_LIST_PS1 = path.join(SANDBOX, 'win-list.ps1');
const DIALOG_CHILD_PS1 = path.join(SANDBOX, 'dialog-child.ps1');
const RAISE_PS1 = path.join(SANDBOX, 'raise-window.ps1');
const DIALOG_TEXT_PS1 = path.join(SANDBOX, 'dialog-text.ps1');
// The combined dialog flow: wait + read body + press Deny in ONE process.
const DENY_FLOW_PS1 = path.join(SANDBOX, 'deny-flow.ps1');

// The shared C# enum body: finds visible top-level windows of one PID whose
// class is #32770 (a Win32 dialog) or whose title says 'Permission Request'.
const ENUM_SRC = [
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class WinEnum',
  '{',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int c);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int c);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  public static uint Target;',
  '  public static IntPtr Found = IntPtr.Zero;',
  '  public static string Title = "";',
  '  static bool Match(IntPtr h)',
  '  {',
  '    if (!IsWindowVisible(h)) return false;',
  '    uint p;',
  '    GetWindowThreadProcessId(h, out p);',
  '    if (p != Target) return false;',
  '    var c = new StringBuilder(256);',
  '    GetClassNameW(h, c, 256);',
  '    var t = new StringBuilder(512);',
  '    GetWindowTextW(h, t, 512);',
  '    return c.ToString() == "#32770" || t.ToString().IndexOf("Permission Request") >= 0;',
  '  }',
  '  static bool Cb(IntPtr h, IntPtr l)',
  '  {',
  '    if (!Match(h)) return true;',
  '    Found = h;',
  '    var t = new StringBuilder(512);',
  '    GetWindowTextW(h, t, 512);',
  '    Title = t.ToString();',
  '    return false;',
  '  }',
  '  public static string List(int targetPid)',
  '  {',
  '    AllRows.Clear();',
  '    Target2 = (uint)targetPid;',
  '    EnumWindows(new EnumProc(CbAll), IntPtr.Zero);',
  '    return string.Join("\\n", AllRows);',
  '  }',
  '  public static System.Collections.Generic.List<string> AllRows = new System.Collections.Generic.List<string>();',
  '  public static uint Target2;',
  '  static bool CbAll(IntPtr h, IntPtr l)',
  '  {',
  '    if (!IsWindowVisible(h)) return true;',
  '    uint p;',
  '    GetWindowThreadProcessId(h, out p);',
  '    if (p != Target2) return true;',
  '    var c = new StringBuilder(256);',
  '    GetClassNameW(h, c, 256);',
  '    var t = new StringBuilder(512);',
  '    GetWindowTextW(h, t, 512);',
  '    AllRows.Add(c.ToString() + "\\t" + t.ToString());',
  '    return true;',
  '  }',
  '  public static string Wait(int targetPid, int waitMs)',
  '  {',
  '    Target = (uint)targetPid;',
  '    var deadline = Environment.TickCount + waitMs;',
  '    while (Environment.TickCount < deadline)',
  '    {',
  '      Found = IntPtr.Zero;',
  '      EnumWindows(new EnumProc(Cb), IntPtr.Zero);',
  '      if (Found != IntPtr.Zero) return "FOUND\\t" + Title;',
  '      System.Threading.Thread.Sleep(200);',
  '    }',
  '    return "NONE";',
  '  }',
  // Finds the visible permission dialog of one process and returns its HWND —
  // the handle UI Automation needs to read the dialog's text content.
  '  public static IntPtr Find(int targetPid)',
  '  {',
  '    Target = (uint)targetPid;',
  '    Found = IntPtr.Zero;',
  '    EnumWindows(new EnumProc(Cb), IntPtr.Zero);',
  '    return Found;',
  '  }',
  '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);',
  // Presses the dialog\'s own "Deny" button (BM_CLICK). WM_CLOSE must NOT be
  // used for dismissal: in this Electron version closing the window resolves
  // the dialog as ALLOW (response 0), which would silently grant the very
  // permission the negative control proves must stay denied.
  '  static IntPtr DenyBtn = IntPtr.Zero;',
  '  static bool FindDenyCb(IntPtr h, IntPtr l)',
  '  {',
  '    var c = new StringBuilder(64);',
  '    GetClassNameW(h, c, 64);',
  // The control class is "Button" (mixed case), NOT "BUTTON" — a case-
  // sensitive compare is exactly what made the first run report
  // NO-DENY-BUTTON while the button sat right there in the dialog.
  '    if (!string.Equals(c.ToString(), "Button", StringComparison.OrdinalIgnoreCase)) return true;',
  '    var t = new StringBuilder(256);',
  '    GetWindowTextW(h, t, 256);',
  '    if (t.ToString() == "Deny") { DenyBtn = h; return false; }',
  '    return true;',
  '  }',
  '  public static string ClickDeny(int targetPid)',
  '  {',
  '    Target = (uint)targetPid;',
  '    Found = IntPtr.Zero;',
  '    EnumWindows(new EnumProc(Cb), IntPtr.Zero);',
  '    if (Found == IntPtr.Zero) return "NO-DIALOG";',
  '    DenyBtn = IntPtr.Zero;',
  '    EnumChildWindows(Found, new EnumProc(FindDenyCb), IntPtr.Zero);',
  '    if (DenyBtn == IntPtr.Zero) return "NO-DENY-BUTTON";',
  '    // BM_CLICK = 0x00F5: the button processes the click synchronously.',
  '    SendMessageW(DenyBtn, 0x00F5, IntPtr.Zero, IntPtr.Zero);',
  '    return "DENIED";',
  '  }',
  '}',
];

function writeDetectorScripts() {
  fs.writeFileSync(WIN_LIST_PS1, [
    'param([int]$TargetPid)',
    "$src = @'",
    ...ENUM_SRC,
    "'@",
    'Add-Type -TypeDefinition $src',
    '[WinEnum]::List($TargetPid)',
  ].join('\n'));

  // Reading the dialog body needs UI Automation: Electron's permission dialog
  // is a Win32 TaskDialog whose message is NOT a STATIC child window (the
  // child list holds only DirectUIHWND/SysLink/Button) — Win32 GetWindowText
  // finds nothing, which is why the first run logged an empty body. UIA
  // exposes the message as a Text element, so: Win32 to find the HWND, UIA to
  // read the text. This is what attributes a popup to an exact permission
  // string ("The site is requesting permission for: <perm>").
  fs.writeFileSync(DIALOG_TEXT_PS1, [
    'param([int]$TargetPid)',
    "$src = @'",
    ...ENUM_SRC,
    "'@",
    'Add-Type -TypeDefinition $src',
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    '$h = [WinEnum]::Find($TargetPid)',
    "if ($h -eq [IntPtr]::Zero) { Write-Output 'NO-DIALOG'; exit 0 }",
    '$el = [System.Windows.Automation.AutomationElement]::FromHandle($h)',
    "$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)",
    '$texts = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)',
    '$rows = @()',
    'foreach ($t in $texts) { if ($t.Current.Name) { $rows += $t.Current.Name } }',
    "Write-Output ($rows -join ' ||| ')",
  ].join('\n'));

  // The combined dialog flow in ONE process: READY handshake → wait for the
  // dialog → read its body (UIA) → press Deny. Run #4 of the E2E lost the
  // camera dialog between the body read and the Deny click because each
  // PowerShell step was a fresh process paying its own Add-Type compile,
  // leaving a multi-second window for the live-app context to close it
  // (closing resolves as Allow). Here the whole flow after READY takes
  // ~300ms, and the caller starts it BEFORE firing the camera request.
  // Output protocol: READY / FOUND\t<title> / BODY\t<text> / DENIED|NO-*|NONE.
  fs.writeFileSync(DENY_FLOW_PS1, [
    'param([int]$TargetPid, [int]$WaitMs)',
    "$src = @'",
    ...ENUM_SRC,
    "'@",
    'Add-Type -TypeDefinition $src',
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    "Write-Output 'READY'",
    '$w = [WinEnum]::Wait($TargetPid, $WaitMs)',
    'if (-not $w.StartsWith("FOUND")) { Write-Output $w; exit 0 }',
    'Write-Output $w',
    '$h = [WinEnum]::Find($TargetPid)',
    "if ($h -eq [IntPtr]::Zero) { Write-Output 'NO-DIALOG'; exit 0 }",
    '$el = [System.Windows.Automation.AutomationElement]::FromHandle($h)',
    "$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)",
    '$texts = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)',
    '$rows = @()',
    'foreach ($t in $texts) { if ($t.Current.Name) { $rows += $t.Current.Name } }',
    "Write-Output ('BODY' + [char]9 + ($rows -join ' ||| '))",
    'Write-Output ([WinEnum]::ClickDeny($TargetPid))',
  ].join('\n'));

  // A real native MessageBox with exactly the title Electron uses, so the
  // detector can be proven to work before it is trusted.
  fs.writeFileSync(DIALOG_CHILD_PS1, [
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int MessageBoxW(IntPtr h, string t, string c, uint f);' -Namespace PermSelfTest -Name User32 | Out-Null",
    "[void][PermSelfTest.User32]::MessageBoxW([IntPtr]::Zero, 'probe body', 'Permission Request', 0)",
  ].join('\n'));

  // Chromium only issues permission requests for a VISIBLE page: on a hidden
  // page the request never reaches the app at all. So before probing, raise +
  // maximise + topmost the AEGIS window — exactly what a user sees when they
  // browse.
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

function runPs1(file, args) {
  const argv = ['-NoProfile', '-NonInteractive', '-File', file];
  for (const k of Object.keys(args || {})) argv.push('-' + k, String(args[k]));
  try {
    return execFileSync('powershell.exe', argv, { encoding: 'utf8', timeout: 30000 });
  } catch (e) { return 'ERR:' + e.message; }
}

function listWindows(pid) {
  const out = runPs1(WIN_LIST_PS1, { TargetPid: pid });
  if (typeof out !== 'string' || out.startsWith('ERR:')) return [{ cls: 'ERR', title: String(out) }];
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
function dialogsOf(pid) {
  const all = listWindows(pid);
  const err = all.find((w) => w.cls === 'ERR');
  // A failed listing must abort the run — never count as "no dialog".
  if (err) throw new Error('window listing failed: ' + err.title);
  return all.filter(isPermissionDialog);
}

// ONE PowerShell process owns the whole dialog flow: it compiles, prints
// READY, then polls for the dialog, reads its body (UIA) and presses Deny —
// all in-process, so the dialog lives ~300ms instead of the multi-second
// gap separate spawns used to leave open (that gap is where the live-app
// context could close it as Allow before the click landed). The caller
// starts this BEFORE firing the request and awaits `ready`; `done` resolves
// with { lines, status, body, click } when the flow finishes.
function startDenyFlow(pid, waitMs) {
  const ps = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', DENY_FLOW_PS1,
     '-TargetPid', String(pid), '-WaitMs', String(waitMs)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { lines: [], status: null, body: null, click: null };
  let resolveReady, resolveDone;
  const ready = new Promise((res) => { resolveReady = res; });
  const done = new Promise((res) => { resolveDone = res; });
  let readySettled = false, doneSettled = false;
  const settleReady = (v) => { if (!readySettled) { readySettled = true; resolveReady(v); } };
  const settleDone = () => { if (!doneSettled) { doneSettled = true; resolveDone(state); } };
  let buf = '';
  const onLine = (line) => {
    state.lines.push(line);
    if (line === 'READY') settleReady(true);
    else if (line === 'NONE' || line.startsWith('FOUND\t')) state.status = line;
    else if (line.startsWith('BODY\t')) state.body = line.slice(5);
    else if (/^(DENIED|NO-DIALOG|NO-DENY-BUTTON)$/.test(line)) { state.click = line; settleDone(); }
  };
  ps.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
  });
  ps.stderr.on('data', (d) => { state.lines.push('STDERR ' + String(d).trim()); });
  ps.on('error', (e) => { state.lines.push('SPAWN-ERROR ' + e.message); settleReady(false); settleDone(); });
  ps.on('close', (code) => {
    if (buf.trim()) onLine(buf.trim());
    settleReady(false);   // no READY line seen → compile/spawn failure
    state.lines.push('EXIT ' + code);
    settleDone();
  });
  return {
    ready, done, state,
    kill() { try { ps.kill(); } catch (e) {} },
  };
}

// Reads the body text of the currently open permission dialog — this is how
// an unexpected popup is attributed to an exact permission string.
function dialogText(pid) {
  return String(runPs1(DIALOG_TEXT_PS1, { TargetPid: pid }) || '').trim();
}

// Dismisses an open dialog by pressing its own "Deny" button — WM_CLOSE must
// never be used here: closing resolves as Allow (response 0) in this Electron
// version, which would grant the permission under test. Runs the combined
// flow script (the dialog is already open, so the wait returns immediately)
// and extracts its verdict line.
function denyDialog(pid) {
  const out = String(runPs1(DENY_FLOW_PS1, { TargetPid: pid, WaitMs: 5000 }) || '');
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.find((l) => /^(DENIED|NO-DIALOG|NO-DENY-BUTTON|NONE)$/.test(l)) || 'UNPARSEABLE:' + JSON.stringify(out.trim());
}

// Bring the AEGIS window to the front, maximised and topmost, so no other
// window can occlude it (see RAISE_PS1 for why visibility matters here).
function raiseWindow(pid) {
  return String(runPs1(RAISE_PS1, { TargetPid: pid }) || '').trim();
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
    else res(msg.result && msg.result.result ? msg.result.result.value : msg.result);
  };
  await ready;

  return {
    url: target.url,
    // Raw CDP command (Page.bringToFront, Input.dispatchMouseEvent, ...).
    cmd: (method, params) => new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); rej(new Error('cdp timeout: ' + method)); }
      }, 15000);
    }),
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

// ── The two auto-approved probes ─────────────────────────────────────────────
// Both wrap a 7s watchdog: if the request still needed the Allow/Deny dialog,
// nobody would answer it and the probe would report TIMEOUT instead of OK —
// so "resolved granted" and "no dialog" are proven by the SAME observation.
const STORAGE_CALL = `Promise.race([
  (async () => {
    const t0 = Date.now();
    try {
      const was = await navigator.storage.persisted();
      const ok = await navigator.storage.persist();
      const now = await navigator.storage.persisted();
      return 'OK-after-' + (Date.now() - t0) + 'ms;was=' + was + ';persist=' + ok + ';persisted=' + now;
    } catch (e) {
      // Snapshot the document at failure time: 'navigator.storage' missing
      // means the page was NOT a secure context (a chrome-error:// page or a
      // pre-commit document), which is a load problem, not a permission one.
      let ctx = '';
      try { ctx = ';href=' + location.href + ';sec=' + isSecureContext + ';ready=' + document.readyState + ';title=' + document.title; } catch (e2) { ctx = ';ctx-unavailable'; }
      return 'ERR-after-' + (Date.now() - t0) + 'ms;' + ((e && e.name) || '') + ':' + ((e && e.message) || e) + ctx;
    }
  })(),
  new Promise((r) => setTimeout(() => r('TIMEOUT-persist-never-answered'), 7000))
])`;

// The clipboard probe MUST run from a genuine user gesture. Chromium maps a
// bare navigator.clipboard.writeText() call (no user activation) to the
// 'clipboard-read' permission — which is deliberately NOT on the allow-list,
// so it would raise the dialog — while a click-driven write requests
// 'clipboard-sanitized-write', the permission this feature auto-approves.
// (Verified against Electron 35: the two strings are distinct in the session
// permission handler.) So the probe installs a button and clicks it through
// CDP input events, exactly the way a real site triggers a clipboard write.
const CLIP_INSTALL = `(() => {
  window.__clip = undefined;
  if (window.__clipBtn) return 'installed';
  const b = document.createElement('button');
  b.id = 'aegis-clip-btn';
  b.textContent = 'COPY';
  b.style.cssText = 'position:fixed;left:8px;top:8px;font-size:18px;padding:12px 18px;z-index:2147483647;';
  b.addEventListener('click', () => {
    const t0 = Date.now();
    window.__clip = 'PENDING';
    navigator.clipboard.writeText('aegis-clip-probe-' + t0).then(
      () => { window.__clip = 'WRITE-OK-after-' + (Date.now() - t0) + 'ms;focus=' + document.hasFocus(); },
      (e) => { window.__clip = 'WRITE-ERR-after-' + (Date.now() - t0) + 'ms;' + ((e && e.name) || '') + ':' + ((e && e.message) || ''); });
  });
  document.body.appendChild(b);
  window.__clipBtn = true;
  return 'installed';
})()`;

const CLIP_POS = `(() => { const el = document.getElementById('aegis-clip-btn');
  if (!el) return 'NO-BUTTON';
  const r = el.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`;

// Fires a camera request WITHOUT awaiting it: while the dialog is open the
// main process runs its modal loop, so every CDP call must stay out of the way
// until the dialog has been seen and dismissed.
const CAM_FIRE = `(window.__cam = navigator.mediaDevices.getUserMedia({ video: true })
  .then((s) => { s.getTracks().forEach((t) => t.stop()); return 'GRANTED'; },
        (e) => 'ERR:' + ((e && e.name) || e)), 'fired')`;

// Chromium refuses a clipboard write on an UNFOCUSED document with
// NotAllowedError before any permission request is even issued — so focus is
// a precondition of the probe, not part of what is being tested. AEGIS's
// window hosts WebContentsView children on top of controls.html, which can
// take native focus away from the base page: try real focus first, then fall
// back to CDP focus emulation (a renderer-side test flag; it does not touch
// the app or bypass any permission check).
async function ensureFocus(target, pid) {
  try { raiseWindow(pid); } catch (e) { /* best effort */ }
  try { await target.cmd('Page.bringToFront'); } catch (e) { /* best effort */ }
  await sleep(250);
  if (await target.ev('document.hasFocus()') === true) return 'native';
  try { await target.ev('window.focus()'); } catch (e) { /* best effort */ }
  await sleep(250);
  if (await target.ev('document.hasFocus()') === true) return 'native';
  try { await target.cmd('Emulation.setFocusEmulationEnabled', { enabled: true }); }
  catch (e) { return 'failed: ' + e.message; }
  await sleep(250);
  return await target.ev('document.hasFocus()') === true ? 'emulated' : 'failed: focus still false';
}

// Runs both auto-approved probes against one page target and asserts the
// full contract: granted, fast, and no AEGIS-owned dialog at any point.
async function probeBoth(target, label, pid) {
  let r = await target.ev(STORAGE_CALL);
  check(label + ': navigator.storage.persist() granted without hanging',
    /^OK-/.test(String(r)) && /persist=true/.test(String(r)) && /persisted=true/.test(String(r)), r);
  console.log('  [info] ' + label + ' storage: ' + r);
  r = dialogsOf(pid);
  // On a stray dialog, include its body text — that names the exact permission
  // string that reached the handler, which is what a fix would need.
  check(label + ': AEGIS owns no dialog for persistent-storage', r.length === 0,
    r.length ? JSON.stringify(r) + '  body=' + dialogText(pid) : '[]');

  const focus = await ensureFocus(target, pid);
  check(label + ': document focused before the clipboard probe', focus === 'native' || focus === 'emulated', focus);
  console.log('  [info] ' + label + ' focus: ' + focus);

  // Real user gesture: install the copy button, then click it through CDP
  // input events (the same path a real site takes, which is what makes
  // Chromium ask for clipboard-sanitized-write instead of clipboard-read).
  r = await target.ev(CLIP_INSTALL);
  check(label + ': clipboard copy button installed', r === 'installed', r);
  const posRaw = await target.ev(CLIP_POS);
  let clip = 'NO-POSITION ' + JSON.stringify(posRaw);
  if (posRaw && posRaw !== 'NO-BUTTON') {
    const pos = JSON.parse(String(posRaw));
    try {
      await target.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none', clickCount: 0 });
      await target.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await target.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      // 7s watchdog: if the request still needed the Allow/Deny dialog, the
      // write would hang and this would report TIMEOUT instead of WRITE-OK.
      const w = await waitFor(target, 'window.__clip',
        (v) => typeof v === 'string' && v !== 'PENDING', 28, 'clipboard write never settled');
      clip = w.ok ? w.value : 'TIMEOUT-write-never-answered;last=' + JSON.stringify(w.value);
    } catch (e) { clip = 'CLICK-ERR:' + e.message; }
  }
  check(label + ': navigator.clipboard.writeText() succeeds from a real click', /^WRITE-OK/.test(String(clip)), clip);
  console.log('  [info] ' + label + ' clipboard: ' + clip);
  r = dialogsOf(pid);
  check(label + ': AEGIS owns no dialog for clipboard-sanitized-write', r.length === 0,
    r.length ? JSON.stringify(r) + '  body=' + dialogText(pid) : '[]');

  // Never leak a stray dialog into the next phase (already recorded above).
  const stray = dialogsOf(pid);
  if (stray.length) {
    console.log('  [info] ' + label + ' dismissing stray dialog: ' + dialogText(pid));
    denyDialog(pid);
    await sleep(600);
  }
}

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS silent permission approval E2E test ==');
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
  let tab2 = null;
  let tab3 = null;      // probe tab in the SECOND workspace
  let siteTab = null;   // a real third-party HTTPS website
  let dialogChild = null;
  let appLog = ['', ''];
  try {
    // ── Phase A ──────────────────────────────────────────────────────────────
    console.log('-- Phase A: reach the real browser UI --');
    page = await readyApp();
    let aegisPid = child.pid;

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

    r = dialogsOf(aegisPid);
    check('AEGIS owns no native dialog at startup', r.length === 0, JSON.stringify(r));

    // ── Phase B ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase B: the popup detector (must not be vacuous) --');
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

    // ── Phase C ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase C: default session (controls.html) --');
    r = raiseWindow(aegisPid);
    check('AEGIS window raised for the probes', r === 'RAISED', r);
    r = await waitFor(page, `document.visibilityState`, (v) => v === 'visible', 24, 'page never became visible');
    check('controls.html is visible', r.ok === true, JSON.stringify(r.value));

    await probeBoth(page, 'default session, round 1', aegisPid);
    await probeBoth(page, 'default session, round 2', aegisPid);

    // ── Phase D ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase D: workspace session (a real tab on ' + origin + ') --');
    r = await page.ev("window.ghost.newTabWorkspace('default', '" + origin + "/perm.html')");
    check('a tab was opened in the default workspace', r === undefined || r === null, JSON.stringify(r));

    tab = await connectTarget((u) => /perm[.]html/.test(u), 'permission probe tab');
    check('probe tab is reachable over CDP', !!tab && /perm[.]html/.test(tab.url || ''), tab && tab.url);

    r = await waitFor(tab,
      `(() => { try { return document.readyState === 'complete' && location.href.indexOf('perm.html') >= 0; } catch(e) { return false; } })()`,
      v => v === true, 40, 'probe page never finished loading');
    check('probe page finished loading', r.ok === true, JSON.stringify(r.value));

    r = raiseWindow(aegisPid);
    check('AEGIS window raised for the tab probe', r === 'RAISED', r);
    r = await waitFor(tab, `document.visibilityState`, (v) => v === 'visible', 24, 'page never became visible');
    check('probe page is visible (hidden pages never issue the request)', r.ok === true, JSON.stringify(r.value));

    await probeBoth(tab, 'workspace tab', aegisPid);

    // A second tab on the same workspace: the policy belongs to the SESSION,
    // so a freshly opened tab must behave exactly the same.
    r = await page.ev("window.ghost.newTabWorkspace('default', '" + origin + "/perm2.html')");
    check('a second tab was opened', r === undefined || r === null, JSON.stringify(r));
    tab2 = await connectTarget((u) => /perm2[.]html/.test(u), 'second probe tab');
    r = await waitFor(tab2,
      `(() => { try { return document.readyState === 'complete'; } catch(e) { return false; } })()`,
      v => v === true, 40, 'second probe page never finished loading');
    check('second probe page finished loading', r.ok === true, JSON.stringify(r.value));

    r = await tab2.ev(STORAGE_CALL);
    check('second tab: storage granted without a dialog',
      /^OK-/.test(String(r)) && /persist=true/.test(String(r)), r);
    r = dialogsOf(aegisPid);
    check('second tab: AEGIS owns no native dialog', r.length === 0,
      r.length ? JSON.stringify(r) + '  body=' + dialogText(aegisPid) : '[]');

    // ── Phase D2: a SECOND workspace + a real third-party website ───────────
    // The policy lives on the per-session handler, so a brand-new workspace
    // (its own partition, reached through the same setupSession path) and a
    // real live HTTPS origin must behave exactly like the probes above.
    console.log('\n-- Phase D2: a second workspace and a real website --');
    r = await page.ev("window.ghost.createWorkspace('perm-ws2')");
    check('a second workspace was created', r && r.ok === true && !!r.id, JSON.stringify(r));
    const ws2 = (r && r.id) || '';
    r = await page.ev('window.ghost.switchWorkspace(' + JSON.stringify(ws2) + ')');
    check('the second workspace was opened', r && r.ok === true, JSON.stringify(r));
    // switchWorkspace only swaps child views — controls.html itself survives,
    // which is what keeps the CDP handle on `page` alive for the calls below.
    // getActiveWorkspace() answers with { id, name, color, ghost }.
    r = await waitFor(page, 'window.ghost.getActiveWorkspace()',
      (v) => v && v.id === ws2, 60, 'the second workspace never became active');
    check('the second workspace is now active', r.ok === true, JSON.stringify(r.value));

    r = await page.ev('window.ghost.newTabWorkspace(' + JSON.stringify(ws2) + ', '
      + JSON.stringify(origin + '/perm3.html') + ')');
    check('a probe tab was opened in the second workspace', r === undefined || r === null, JSON.stringify(r));
    tab3 = await connectTarget((u) => /perm3[.]html/.test(u), 'second-workspace probe tab');
    check('second-workspace probe tab is reachable over CDP', !!tab3 && /perm3[.]html/.test(tab3.url || ''), tab3 && tab3.url);
    r = await waitFor(tab3,
      `(() => { try { return document.readyState === 'complete' && location.href.indexOf('perm3.html') >= 0; } catch(e) { return false; } })()`,
      v => v === true, 40, 'second-workspace probe page never finished loading');
    check('second-workspace probe page finished loading', r.ok === true, JSON.stringify(r.value));
    r = await raiseWindow(aegisPid);
    check('AEGIS window raised for the second-workspace probe', r === 'RAISED', r);
    r = await waitFor(tab3, `document.visibilityState`, (v) => v === 'visible', 24, 'probe page never became visible');
    check('second-workspace probe page is visible', r.ok === true, JSON.stringify(r.value));
    await probeBoth(tab3, 'second workspace tab', aegisPid);

    // A real third-party HTTPS origin — a secure context like any live site,
    // reached over the network rather than from our own local probe server.
    r = await page.ev("window.ghost.newTabWorkspace(" + JSON.stringify(ws2) + ", 'https://example.com')");
    check('a real website tab was opened', r === undefined || r === null, JSON.stringify(r));
    siteTab = await connectTarget((u) => /^https:\/\/example[.]com\//.test(u), 'real website tab');
    check('real website tab is reachable over CDP', !!siteTab && /^https:/.test(siteTab.url || ''), siteTab && siteTab.url);
    r = await waitFor(siteTab,
      `(() => { try { return document.readyState === 'complete'; } catch(e) { return false; } })()`,
      v => v === true, 60, 'the real website never finished loading');
    check('the real website finished loading', r.ok === true, JSON.stringify(r.value));
    r = await raiseWindow(aegisPid);
    check('AEGIS window raised for the website probe', r === 'RAISED', r);
    r = await waitFor(siteTab, `document.visibilityState`, (v) => v === 'visible', 24, 'website page never became visible');
    check('the real website is visible', r.ok === true, JSON.stringify(r.value));
    const siteCtx = await siteTab.ev(`({href: location.href, sec: isSecureContext, storage: typeof navigator.storage, clip: typeof navigator.clipboard, ready: document.readyState, title: document.title})`);
    console.log('  [info] website document context: ' + JSON.stringify(siteCtx));
    await probeBoth(siteTab, 'real website (https://example.com)', aegisPid);

    // Back to the ORIGINAL workspace: Phase E's camera probe needs a VISIBLE
    // page (Chromium never issues a permission request from a hidden one) and
    // `tab` lives in 'default', which D2 just left.
    r = await page.ev("window.ghost.switchWorkspace('default')");
    check('switched back to the original workspace', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(page, 'window.ghost.getActiveWorkspace()',
      (v) => v && v.id === 'default', 60, 'never switched back to the default workspace');
    check('the original workspace is active again', r.ok === true, JSON.stringify(r.value));
    r = await waitFor(tab, `document.visibilityState`, (v) => v === 'visible', 24,
      'the original probe tab never became visible again');
    check('the original probe tab is visible again for Phase E', r.ok === true, JSON.stringify(r.value));

    // ── Phase E ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase E: policy preserved for everything else --');
    r = await tab.ev(stateOf('clipboard-read'));
    check("clipboard READ keeps its existing policy ('granted')", r === 'state=granted', r);
    r = await tab.ev(stateOf('geolocation'));
    check("geolocation stays 'denied'", r === 'state=denied', r);
    r = await tab.ev(stateOf('notifications'));
    check("notifications keeps its existing policy ('granted')", r === 'state=granted', r);

    // Camera is NOT on the allow-list: it must still raise the native dialog.
    // (Any stray dialog from an earlier probe is dismissed by probeBoth, so
    // the dialog found here is the camera's own.)
    const beforeCam = dialogsOf(aegisPid);
    check('no leftover dialog before the camera probe', beforeCam.length === 0, JSON.stringify(beforeCam));

    // ONE process owns the whole dialog flow, started BEFORE the request: by
    // the time the dialog exists it is already compiled and polling, so the
    // wait → body read → Deny click lands within ~300ms of the dialog
    // appearing. Separate PowerShell spawns used to leave a multi-second gap
    // between those steps (each pays its own Add-Type compile) — wide enough
    // for the live-app context to close the dialog as Allow first (run #4).
    const flow = startDenyFlow(aegisPid, 15000);
    let readyTimer = null;
    const flowReady = await Promise.race([
      flow.ready,
      new Promise((res) => { readyTimer = setTimeout(() => res(false), 30000); }),
    ]);
    clearTimeout(readyTimer);
    check('dialog flow compiled and polling before the camera request', flowReady === true,
      JSON.stringify(flow.state.lines));
    if (flowReady !== true) flow.kill();

    r = await tab.ev(CAM_FIRE);
    check('camera request was issued', r === 'fired', r);

    let doneTimer = null;
    const flowState = await Promise.race([
      flow.done,
      new Promise((res) => { doneTimer = setTimeout(() => { flow.kill(); res(flow.state); }, 25000); }),
    ]);
    clearTimeout(doneTimer);
    console.log('  [info] camera dialog flow: ' + JSON.stringify(flowState.lines));

    // The status line proves the dialog appeared; the body must name the
    // exact permission string the handler received — that proves the dialog
    // we dismissed is the camera request itself, not a stray popup. Electron
    // maps getUserMedia to 'media' (content_converter.cc), NOT 'camera' — an
    // earlier assertion failed on exactly that naming detail while the dialog
    // text read "The site is requesting permission for: media".
    const camFound = typeof flowState.status === 'string' && flowState.status.startsWith('FOUND');
    check('camera STILL raises the Allow/Deny dialog (policy preserved)', camFound, flowState.status);
    if (camFound) {
      const camBody = flowState.body == null ? '' : flowState.body;
      console.log('  [info] camera dialog body: ' + camBody);
      check('camera dialog body names the media permission (getUserMedia)',
        /permission for:\s*media\s*$/i.test(camBody.trim()), camBody);

      // Press the dialog's OWN Deny button — never WM_CLOSE, which resolves
      // as Allow (response 0) in this Electron version and would grant the
      // permission the policy says must stay denied. If the watcher somehow
      // did not get to click, fall back to the synchronous deny so no dialog
      // can leak into the next phase.
      let denied = flowState.click;
      if (denied !== 'DENIED') {
        denied = denyDialog(aegisPid);
        console.log('  [info] watcher click was ' + JSON.stringify(flowState.click) + ', fallback: ' + denied);
      }
      check('the camera dialog is answered with its Deny button', denied === 'DENIED', denied);
      let stillOpen = dialogsOf(aegisPid);
      for (let i = 0; i < 20 && stillOpen.length > 0; i++) { await sleep(500); stillOpen = dialogsOf(aegisPid); }
      check('no dialog is left behind after dismissing', stillOpen.length === 0, JSON.stringify(stillOpen));
      const camResult = await waitFor(tab, 'window.__cam', (v) => typeof v === 'string', 12, 'camera request never settled');
      check('camera request was DENIED (policy preserved)',
        typeof camResult.value === 'string' && /^ERR:(NotAllowedError|NotAllowed)/.test(camResult.value),
        JSON.stringify(camResult.value));
      console.log('  [info] camera request outcome after Deny: ' + JSON.stringify(camResult.value));
    } else {
      // No dialog at all: capture the outcome for the failure report (a
      // silent grant here would be a policy leak; a hang means it never
      // issued). No new assertion — the FOUND check above already failed.
      const camResult = await waitFor(tab, 'window.__cam', (v) => typeof v === 'string', 8, 'camera request never settled');
      console.log('  [info] camera outcome with no dialog: ' + JSON.stringify(camResult.value));
    }

    // ── Phase F ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase F: restart AEGIS — behaviour must not change --');
    tab2.close(); tab2 = null;
    tab.close(); tab = null;
    if (tab3) { try { tab3.close(); } catch (e) {} tab3 = null; }
    if (siteTab) { try { siteTab.close(); } catch (e) {} siteTab = null; }
    await killApp(page);
    page.close();
    page = null;

    page = await readyApp();
    aegisPid = child.pid;
    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('login succeeds after the restart', r && r.ok === true, JSON.stringify(r));
    r = await page.ev('window.ghost.setAutoClose(false, 5)');
    check('idle auto-close disabled again', r && r.ok !== false, JSON.stringify(r));
    r = await page.ev("window.ghost.selectWorkspace('default')");
    check('browser UI opens after the restart', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(page,
      `(() => { try { return /controls[.]html/.test(location.href) && !!window.ghost; } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded after restart');
    check('controls.html is live after the restart', r.ok === true, JSON.stringify(r.value));

    r = raiseWindow(aegisPid);
    check('AEGIS window raised after the restart', r === 'RAISED', r);
    await probeBoth(page, 'after restart', aegisPid);
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
  } finally {
    if (dialogChild && dialogChild.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(dialogChild.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
    }
    if (tab2) { try { tab2.close(); } catch (e) {} }
    if (tab) { try { tab.close(); } catch (e) {} }
    if (tab3) { try { tab3.close(); } catch (e) {} }
    if (siteTab) { try { siteTab.close(); } catch (e) {} }
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
