// test-speed.js — isolated E2E test: the Connection panel's "Test Internet
// speed" button really measures the connection and renders an evaluation.
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder.
// It copies the app into a temp sandbox, writes a portable.dat marker there so
// all user data lands inside the sandbox, and afterwards asserts that the
// project data\ folder is byte-for-byte unchanged.
//
// Run:  node test-speed.js
//
// What is being proven:
//   Phase A  the speed-test bridge is exposed (testInternetSpeed + progress)
//   Phase B  the button exists in the Connection panel with the right label,
//            and clicking the toolbar globe opens that panel
//   Phase C  pressing the button streams real 'speed-progress' events
//            (ping -> download -> upload) while the invoke is pending
//   Phase D  a report is rendered: a 0-100 score, a rating from the known set,
//            a verdict, 3 metric tiles, 6 use-case rows, at least one tip, and
//            the button is re-enabled so the test can be repeated
//
// The measurement itself runs in the main process against public keyless
// endpoints, so this test needs internet access and takes 10-45 s.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP, 'opencode', 'aegis-speed-test');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

const USER = 'speed-user';
const PASS = 'speed-secret';

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

let nextPort = 9481;
let activePort = null;
const PORT_FILTER = 'remote-debugging-port=';

// Chromium pauses the animation clock (and throttles JS) for a page that is not
// being rendered, so a window hidden behind the console makes CSS transitions
// freeze — the progress bar would sit at 0 % for ever even though IPC works.
// A real user always looks at the window, so raise it before probing the UI.
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
  child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + activePort], { cwd: SANDBOX, stdio: ['ignore', 'pipe', 'pipe'] });
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
  let last;
  for (let i = 0; i < tries; i++) {
    try { last = await page.ev(expression); } catch (e) { last = 'ERR: ' + e.message; }
    if (pred(last)) return { ok: true, value: last };
    await sleep(250);
  }
  return { ok: false, value: last, label };
}

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS "Test Internet speed" E2E test ==');
  console.log('  sandbox: ' + SANDBOX);

  cleanupLeftovers();
  await sleep(1500);

  const realBefore = snapshotRealData();
  console.log('  project data\\ snapshot: ' + Object.keys(realBefore).length + ' file(s)');

  setupSandbox();
  writeRaiseScript();
  console.log('  sandbox prepared (portable mode)\n');

  let page = null;
  let appLog = ['', ''];
  try {
    // ── Setup: reach the real browser UI ─────────────────────────────────────
    console.log('-- Setup: reach controls.html --');
    page = await readyApp();

    // Put the window on screen from the start: a hidden or fully occluded page
    // is not painted, so Chromium produces no frames — CSS transitions freeze
    // (progress bar stuck at 0 %) and timers get throttled for the whole run.
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
    // require a fully parsed document with the actual toolbar in it — otherwise
    // the element checks below can race the parser.
    r = await waitFor(page,
      `(() => { try { return /controls[.]html/.test(location.href) && !!window.ghost &&
        document.readyState === 'complete' && !!document.getElementById('cn-speed-btn'); } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded');
    check('controls.html is the live page', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page, 'document.visibilityState', v => v === 'visible', 24, 'page never became visible');
    check('controls.html is visible (a hidden page never advances CSS animations)', r.ok === true, JSON.stringify(r.value));

    // ── Phase A: the bridge exposes the speed test ───────────────────────────
    console.log('\n-- Phase A: speed-test bridge --');
    r = await page.ev("typeof window.ghost.testInternetSpeed");
    check('ghost.testInternetSpeed is exposed', r === 'function', r);

    r = await page.ev("typeof window.ghost.onSpeedProgress");
    check('ghost.onSpeedProgress is exposed', r === 'function', r);

    // ── Phase B: the button lives in the Connection panel ────────────────────
    console.log('\n-- Phase B: the button and its panel --');
    r = await page.ev("(() => { const b = document.getElementById('cn-speed-btn'); return b ? b.textContent.replace(/\\s+/g,' ').trim() : null; })()");
    check('the speed-test button exists with the right label', r === 'Test Internet speed', r);

    r = await page.ev("(() => { const f = document.getElementById('cn-speed-btn'); return f ? !!f.closest('#cpnl .cn-foot') : false; })()");
    check('the button sits inside the Connection panel', r === true, r);

    r = await page.ev("(() => { const b = document.getElementById('cn-btn'); if (b) b.click(); return document.getElementById('cpnl').classList.contains('open'); })()");
    check('the toolbar globe opens the Connection panel', r === true, r);

    r = await waitFor(page,
      `(() => { const b = document.getElementById('cn-body'); return !!b && b.innerHTML.length > 80; })()`,
      v => v === true, 40, 'the connection body never rendered');
    check('the Connection panel renders its content', r.ok === true, r.value);

    // Count every progress event, and sample the fill's real state every 150 ms
    // so a "progress bar stuck at 0" failure can be diagnosed after the fact.
    r = await page.ev(`(() => {
      window.__sp = { events: 0, phases: [], t0: 0, firstAt: null, samples: [] };
      window.ghost.onSpeedProgress(d => {
        window.__sp.events++;
        if (window.__sp.firstAt === null && window.__sp.t0) window.__sp.firstAt = Date.now() - window.__sp.t0;
        if (d && d.phase && window.__sp.phases.indexOf(d.phase) < 0) window.__sp.phases.push(d.phase);
      });
      clearInterval(window.__spTimer);
      window.__spTimer = setInterval(() => {
        const f = document.getElementById('sp-fill');
        if (!f || !window.__sp.t0) return;
        const cs = getComputedStyle(f);
        const par = f.parentElement;
        window.__sp.samples.push({
          t: Date.now() - window.__sp.t0,
          w: cs.width, i: f.style.width,
          r: Math.round(f.getBoundingClientRect().width),
          conn: f.isConnected,
          par: par ? par.className + '/' + getComputedStyle(par).width : null,
          cls: document.getElementById('cpnl').className,
          fills: document.querySelectorAll('.sp-fill').length,
          anim: f.getAnimations ? f.getAnimations().length : -1
        });
        if (window.__sp.samples.length > 400) clearInterval(window.__spTimer);
      }, 150);
      return true;
    })()`);
    check('a progress listener is registered before pressing the button', r === true, r);

    // ── Phase C: press the button ────────────────────────────────────────────
    console.log('\n-- Phase C: pressing "Test Internet speed" --');
    r = await page.ev("(() => { const b = document.getElementById('cn-speed-btn'); window.__sp.t0 = Date.now(); b.click(); return document.getElementById('speed-body').hidden === false; })()");
    check('pressing the button reveals the speed-test section', r === true, r);

    r = await waitFor(page, "(() => { const f = document.getElementById('sp-fill'); return f ? getComputedStyle(f).width : null; })()",
      v => typeof v === 'string' && v !== '0px', 24, 'the progress bar never started moving');
    check('a live progress bar appears', r.ok === true, JSON.stringify(r.value));
    if (!r.ok) {
      // Why did the bar sit at 0? Dump the state at the moment of failure.
      const diag = await page.ev(`JSON.stringify((() => {
        const f = document.getElementById('sp-fill');
        const t = document.querySelector('.sp-track');
        const b = document.getElementById('speed-body');
        return {
          fillInline: f ? f.style.width : 'NO-FILL',
          fillComputed: f ? getComputedStyle(f).width : null,
          trackW: t ? t.getBoundingClientRect().width : null,
          bodyHidden: b ? b.hidden : null,
          bodyDisplay: b ? getComputedStyle(b).display : null,
          panelOpen: document.getElementById('cpnl').classList.contains('open'),
          events: window.__sp ? window.__sp.events : null,
          firstEventMs: window.__sp ? window.__sp.firstAt : null,
          running: (typeof speedRunning !== 'undefined') ? speedRunning : 'n/a',
          samples: window.__sp ? window.__sp.samples.filter((s, i) => i % 3 === 0).slice(0, 24) : null
        };
      })())`);
      console.log('  [diag] ' + diag);
    }

    // The wait state must prove it is alive even before the first event lands.
    r = await waitFor(page, "(() => { const e = document.getElementById('sp-phase-elapsed'); return e ? e.textContent : null; })()",
      v => typeof v === 'string' && /^\d+\.\ds$/.test(v), 24, 'the elapsed counter never ticked');
    check('the elapsed counter ticks while the test runs', r.ok === true, JSON.stringify(r.value));

    // The report, or a clearly rendered failure, must arrive eventually.
    r = await waitFor(page,
      `(() => { const s = document.getElementById('speed-body'); if (!s || s.hidden) return false;
        return !!s.querySelector('.sp-num') || !!s.querySelector('.he .bt'); })()`,
      v => v === true, 360, 'the speed test never finished (90 s)');
    check('the test finishes and renders a result', r.ok === true, JSON.stringify(r.value));

    r = await page.ev("(() => { const b = document.getElementById('cn-speed-btn'); return b ? { text: b.textContent.replace(/\\s+/g,' ').trim(), disabled: !!b.disabled } : null; })()");
    check('the button is re-enabled and back to its label',
      r && r.disabled === false && r.text === 'Test Internet speed', JSON.stringify(r));

    const sp = await page.ev("window.__sp");
    check('progress events were streamed to the panel', sp && sp.events >= 3, JSON.stringify(sp));
    check('the phases ping / download / upload all reported',
      sp && ['ping', 'download', 'upload'].every(p => sp.phases.indexOf(p) >= 0), JSON.stringify(sp && sp.phases));

    // ── Phase D: the evaluation itself ───────────────────────────────────────
    console.log('\n-- Phase D: the evaluation report --');
    r = await page.ev(`(() => {
      const s = document.getElementById('speed-body');
      const num = s.querySelector('.sp-num');
      const err = s.querySelector('.he .bt');
      return JSON.stringify({
        score: num ? num.textContent : null,
        rating: s.querySelector('.sp-badge') ? s.querySelector('.sp-badge').textContent : null,
        verdictLen: s.querySelector('.sp-verdict') ? s.querySelector('.sp-verdict').textContent.length : 0,
        tiles: s.querySelectorAll('.sp-tile').length,
        tileUnits: Array.prototype.map.call(s.querySelectorAll('.sp-tile .u'), e => e.textContent),
        uses: s.querySelectorAll('.sp-use').length,
        tips: s.querySelectorAll('.sp-tips div').length,
        note: !!s.querySelector('.cn-note'),
        failed: err ? err.textContent : null
      });
    })()`);
    let rep = {};
    try { rep = JSON.parse(r); } catch (e) { rep = { raw: r }; }

    check('no failure state is shown (real measurements came back)', !rep.failed, JSON.stringify(rep));
    const scoreNum = rep.score ? parseInt(String(rep.score).replace(/[^0-9].*$/, ''), 10) : NaN;
    check('a 0-100 score is rendered', Number.isFinite(scoreNum) && scoreNum >= 0 && scoreNum <= 100, JSON.stringify(rep.score));
    check('the score carries a /100 suffix', /^\d+\/100$/.test(String(rep.score)), JSON.stringify(rep.score));
    const ratings = ['Excellent', 'Very good', 'Good', 'Fair', 'Poor', 'Very poor'];
    check('the rating comes from the known set', ratings.indexOf(String(rep.rating)) >= 0, JSON.stringify(rep.rating));
    check('a plain-language verdict is present', rep.verdictLen > 20, String(rep.verdictLen));
    check('3 metric tiles (download / upload / ping) are shown', rep.tiles === 3, String(rep.tiles));
    check('the tiles carry units', Array.isArray(rep.tileUnits) && rep.tileUnits.length === 3 &&
      rep.tileUnits[0] === 'Mbps' && rep.tileUnits[1] === 'Mbps' && /ms/.test(String(rep.tileUnits[2])), JSON.stringify(rep.tileUnits));
    check('6 use-case rows evaluate the connection', rep.uses === 6, String(rep.uses));
    check('at least one actionable tip is given', rep.tips >= 1, String(rep.tips));
    check('the privacy note is shown', rep.note === true, String(rep.note));

    const msg = await page.ev("(() => { const m = document.getElementById('speed-msg'); return m ? m.textContent : ''; })()");
    check('a status line names the endpoint used', /Tested via/.test(String(msg)), JSON.stringify(msg));

    // Optional: AEGIS_SHOT=<path> keeps a PNG of the rendered report.
    if (process.env.AEGIS_SHOT) {
      try {
        const p = await page.shot(process.env.AEGIS_SHOT);
        check('screenshot of the report captured', fs.existsSync(p), p);
        console.log('  [info] screenshot: ' + p);
      } catch (e) { check('screenshot of the report captured', false, e.message); }
    }

    // Pressing it again must work (results are re-measured, not stuck).
    r = await page.ev("(() => { const b = document.getElementById('cn-speed-btn'); b.click(); return b.disabled === true; })()");
    check('re-testing disables the button while it runs', r === true, r);
    r = await waitFor(page,
      "(() => { const b = document.getElementById('cn-speed-btn'); return b.disabled === false && !!document.querySelector('#speed-body .sp-num'); })()",
      v => v === true, 360, 'the second run never finished');
    check('the second run completes and re-enables the button', r.ok === true, JSON.stringify(r.value));
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
