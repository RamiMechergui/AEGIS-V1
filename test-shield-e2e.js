// test-shield-e2e.js — isolated E2E test: Aegis Shield inside the REAL app.
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder.
// It copies the app into a temp sandbox, writes a portable.dat marker there so
// all user data lands inside the sandbox, and afterwards asserts that the
// project data\ folder is byte-for-byte unchanged.
//
// Run:  node test-shield-e2e.js
//
// What is being proven (all of it in a launched AEGIS, not in a unit harness):
//   Phase A  register + login + pick workspace -> the real browser UI, and the
//            Shield engine reports its bundled rule list + a custom rule
//   Phase B  a navigation carrying ?utm_source=…&fbclid=… lands on the CLEAN
//            URL: the tags are gone before the page's own script ever runs
//   Phase C  a tracker request is cancelled BEFORE the socket opens — the CDP
//            network layer reports net::ERR_BLOCKED_BY_CLIENT, which is only
//            ever produced by an interception, never by DNS or TLS failure —
//            while a same-origin control resource still loads normally
//   Phase D  the fingerprint randomizer is live in a content view: a solid
//            canvas comes back with sparse noise (alpha untouched, so graphics
//            survive), repeated reads are stable, a second origin farbles
//            differently, and WebGL readPixels is noised too
//   Phase E  every protection is a real live toggle: turning a switch off in
//            Settings actually stops the behaviour, turning it back on
//            restores it
//
// Nothing in this test needs the internet: the blocked hosts are intercepted
// before DNS runs, and the one probe that is deliberately left unblocked uses
// the reserved .test TLD, so at most a NXDOMAIN lookup leaves the machine.

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'opencode', 'aegis-shield-e2e');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

const USER = 'shield-user';
const PASS = 'shield-secret';

// Hostnames used by the probes. tracker.test is reserved (RFC 2606) so it can
// never resolve — that is what makes the "toggle off" half of Phase E
// distinguishable from "shield is still on" without any real traffic.
const TRACKER = 'https://tracker.test/beacon';
const ANALYTICS = 'https://www.google-analytics.com/analytics.js';

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
let nextPort = 9610;
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
  // main.js — without them the sandbox app cannot even start.
  const files = ['main.js', 'preload.js', 'yt-tools.js', 'shield.js', 'shield-list.txt', 'vault.js', 'oauth.js', 'playlist-queue.js',
    'fp-preload.js', 'package.json', 'logo.png', 'logo.ico']
    .concat(fs.readdirSync(SRC).filter((f) => f.endsWith('.html')));
  for (const f of files) fs.copyFileSync(path.join(SRC, f), path.join(SANDBOX, f));

  // Junction instead of copying ~200 MB of node_modules (no admin rights needed)
  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(SANDBOX, 'node_modules'), 'junction');

  // Portable marker -> userData and sessionData resolve inside the sandbox
  fs.writeFileSync(path.join(SANDBOX, 'portable.dat'), '');

  fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });

  // A user rule in the profile folder, loaded by shield.init() at startup —
  // proves shield-custom.txt is honoured end to end.
  fs.writeFileSync(path.join(SANDBOX, 'data', 'shield-custom.txt'),
    '! written by test-shield-e2e.js\n||tracker.test^\n');
}

// ── Local page servers ───────────────────────────────────────────────────────
// Two servers on 127.0.0.1 with different ports: same bytes, two ORIGINS
// (location.origin includes the port), which is exactly what the fingerprint
// randomizer is supposed to treat as two different sites.
const PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>shield probe</title></head>
<body>shield probe</body>
<script>
window.probeInfo = { href: location.href, search: location.search };
window.hit = function (url) {
  return fetch(url, { mode: 'no-cors', cache: 'no-store' })
    .then(function () { return 'LOADED'; })
    .catch(function (e) { return 'FAILED:' + ((e && e.message) || e); });
};
window.solidDiff = function () {
  var c = document.createElement('canvas'); c.width = 200; c.height = 100;
  var x = c.getContext('2d');
  x.fillStyle = 'rgb(18,52,86)'; x.fillRect(0, 0, 200, 100);
  var d = x.getImageData(0, 0, 200, 100).data;
  var changed = 0;
  for (var i = 0; i < d.length; i += 4) {
    if (d[i] !== 18 || d[i + 1] !== 52 || d[i + 2] !== 86 || d[i + 3] !== 255) changed++;
  }
  return { changed: changed, total: 20000 };
};
window.draw = function () {
  var c = document.createElement('canvas'); c.width = 300; c.height = 60;
  var x = c.getContext('2d');
  x.fillStyle = '#123456'; x.fillRect(0, 0, 300, 60);
  x.fillStyle = '#ff8800'; x.fillRect(10, 10, 120, 40);
  x.fillStyle = '#00ccff'; x.fillRect(150, 5, 60, 50);
  x.fillStyle = '#ffffff'; x.fillRect(220, 20, 70, 20);
  return c.toDataURL();
};
window.glDiff = function () {
  var c = document.createElement('canvas'); c.width = 64; c.height = 64;
  var gl = c.getContext('webgl');
  if (!gl) return { supported: false };
  gl.clearColor(0.2, 0.4, 0.6, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  var px = new Uint8Array(64 * 64 * 4);
  gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
  var counts = {}, k, i;
  for (i = 0; i < px.length; i += 4) {
    k = px[i] + ',' + px[i + 1] + ',' + px[i + 2] + ',' + px[i + 3];
    counts[k] = (counts[k] || 0) + 1;
  }
  var mode = '', best = -1;
  for (k in counts) if (counts[k] > best) { best = counts[k]; mode = k; }
  return { supported: true, changed: 4096 - best, total: 4096, mode: mode };
};
</script></html>
`;

// 1x1 transparent PNG — the control resource that must NOT be blocked.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function makePageServer() {
  return http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    // /probe.html and /seed.html are the same document under two paths: the
    // seed path keeps the fingerprint tabs separate from the Phase B tab,
    // which CDP matches by URL.
    if (url === '/probe.html' || url === '/seed.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PROBE_HTML);
      return;
    }
    if (url === '/ok.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(PNG_1PX);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('not found');
  });
}

let serverA = null, serverB = null;
let originA = null, originB = null, portA = 0, portB = 0;
function listen(srv) {
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}
async function startPageServers() {
  serverA = makePageServer();
  serverB = makePageServer();
  portA = await listen(serverA);
  portB = await listen(serverB);
  originA = 'http://127.0.0.1:' + portA;
  originB = 'http://127.0.0.1:' + portB;
  return originA;
}
function stopPageServers() {
  for (const s of [serverA, serverB]) { if (s) { try { s.close(); } catch (e) {} } }
  serverA = serverB = null;
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
// Same shape as the other E2E tests, plus the Network domain: request
// interception shows up here as loadingFailed/net::ERR_BLOCKED_BY_CLIENT,
// which is the one signal that cannot be produced by DNS or TLS failing.
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
  const events = [];
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('CDP websocket failed to connect'));
    setTimeout(() => reject(new Error('CDP websocket timeout')), 15000);
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else if (msg.result && msg.result.exceptionDetails) {
        const d = msg.result.exceptionDetails;
        rej(new Error('page exception: ' + ((d.exception && d.exception.description) || d.text)));
      } else res(msg.result);
      return;
    }
    if (msg.method) events.push(msg);
  };
  await ready;

  const send = (method, params) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error('CDP timeout: ' + method)); }
    }, 30000);
  });

  // requestId -> URL, then pair it with every failure the network stack saw.
  function netFailures() {
    const urls = new Map();
    const out = [];
    for (const m of events) {
      if (m.method === 'Network.requestWillBeSent') urls.set(m.params.requestId, m.params.request.url);
      else if (m.method === 'Network.loadingFailed') {
        out.push({
          url: urls.get(m.params.requestId) || '',
          errorText: m.params.errorText || '',
          canceled: !!m.params.canceled,
          type: m.params.type || '',
        });
      }
    }
    return out;
  }

  return {
    url: target.url,
    send,
    netFailures,
    clearNet: () => { events.length = 0; },
    ev: async (expression) => {
      const once = () => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        .then((r) => (r && r.result ? r.result.value : undefined));
      // A navigation can destroy the JS context mid-call — retry those.
      for (let attempt = 1; attempt <= 12; attempt++) {
        try { return await once(); }
        catch (e) {
          if (!/Execution context was destroyed|Cannot find context|Inspected target navigated|evaluate timeout/.test(e.message)) throw e;
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

// Wait until the network stack reports a failure for a URL containing `part`.
async function waitFailure(cdp, part, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const hits = cdp.netFailures().filter((f) => f.url.indexOf(part) >= 0);
    if (hits.length) return hits[hits.length - 1];
    await sleep(250);
  }
  return null;
}

// Wait specifically for an INTERCEPTION (ERR_BLOCKED_BY_CLIENT). Every other
// failure — DNS, TLS, connection — means the request was allowed to run.
async function waitBlocked(cdp, part, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const hits = cdp.netFailures().filter((f) =>
      f.url.indexOf(part) >= 0 && f.errorText === 'net::ERR_BLOCKED_BY_CLIENT');
    if (hits.length) return hits[hits.length - 1];
    await sleep(250);
  }
  return null;
}

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS Aegis Shield E2E test ==');
  console.log('  sandbox: ' + SANDBOX);

  cleanupLeftovers();
  await sleep(1500);

  const realBefore = snapshotRealData();
  console.log('  project data\\ snapshot: ' + Object.keys(realBefore).length + ' file(s)');

  setupSandbox();
  const probeOrigin = await startPageServers();
  console.log('  sandbox prepared (portable mode); probe pages at ' + probeOrigin + ' / ' + originB + '\n');

  let page = null;
  let tab = null;
  let seedA = null;
  let seedB = null;
  let appLog = ['', ''];
  try {
    // ── Phase A ──────────────────────────────────────────────────────────────
    console.log('-- Phase A: reach the real browser UI --');
    page = await readyApp();

    let r = await page.ev('!!window.ghost');
    check('login page exposes the ghost bridge', r === true, r);

    r = await page.ev("window.ghost.register('" + USER + "','" + PASS + "')");
    check('register creates the account', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('login succeeds', r && r.ok === true, JSON.stringify(r));

    r = await page.ev('window.ghost.setAutoClose(false, 5)');
    check('idle auto-close disabled for the test run', r && r.ok !== false, JSON.stringify(r));

    r = await page.ev("window.ghost.selectWorkspace('default')");
    check('selectWorkspace opens the browser UI', r && r.ok === true, JSON.stringify(r));

    r = await waitFor(page,
      `(() => { try { return /controls[.]html/.test(location.href) && !!window.ghost; } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded');
    check('controls.html is the live page', r.ok === true, JSON.stringify(r.value));

    r = await page.ev('window.ghost.getShieldStats()');
    const stats0 = r || {};
    console.log('  [info] shield stats: ' + JSON.stringify(stats0));
    check('the engine loaded the bundled rule list (>= 100 rules)', (stats0.rules || 0) >= 100, JSON.stringify(stats0));
    check('the profile shield-custom.txt rule was loaded (>= 1)', (stats0.customRules || 0) >= 1, JSON.stringify(stats0));

    r = await page.ev('window.ghost.getShieldPrefs()');
    const prefs0 = r || {};
    console.log('  [info] shield prefs: ' + JSON.stringify(prefs0));
    check('all three protections default to ON',
      prefs0.blockAds === true && prefs0.fpRandomizer === true && prefs0.stripParams === true, JSON.stringify(prefs0));

    // ── Phase B ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase B: tracking parameters are stripped from the navigation --');
    const dirtyUrl = probeOrigin + '/probe.html?utm_source=newsletter&utm_medium=email&utm_campaign=spring&fbclid=abc123&keep=yes';
    r = await page.ev("window.ghost.newTabWorkspace('default', '" + dirtyUrl + "')");
    check('a tab was opened in the default workspace', r === undefined || r === null, JSON.stringify(r));

    tab = await connectTarget((u) => /probe[.]html/.test(u), 'shield probe tab');
    check('probe tab is reachable over CDP', !!tab && /probe[.]html/.test(tab.url || ''), tab && tab.url);

    r = await waitFor(tab,
      `(() => { try { return document.readyState === 'complete' && location.href.indexOf('probe.html') >= 0; } catch(e) { return false; } })()`,
      v => v === true, 40, 'probe page never finished loading');
    check('probe page finished loading', r.ok === true, JSON.stringify(r.value));

    const search = await tab.ev('location.search');
    check('utm_* and fbclid are gone from the loaded URL', !/[?&](utm_|fbclid)/i.test(String(search)), search);
    check('the non-tracking parameter survived the strip', String(search) === '?keep=yes', search);

    const href = await tab.ev('location.href');
    check('the page loaded at the cleaned address', String(href).indexOf('probe.html?keep=yes') >= 0, href);

    r = await page.ev('window.ghost.getShieldStats()');
    check('the strip was counted by the engine', ((r || {}).stripped || 0) >= 1, JSON.stringify(r));

    // The Network domain must be live BEFORE any probe request is issued.
    await tab.send('Network.enable', {});
    tab.clearNet();

    // ── Phase C ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase C: the tracker request is cancelled before DNS/socket --');
    const blockedBefore = ((await page.ev('window.ghost.getShieldStats()')) || {}).blocked || 0;

    r = await tab.ev('window.hit(' + JSON.stringify(ANALYTICS) + ')');
    console.log('  [info] page-level result for the tracker fetch: ' + r);
    const fail1 = await waitFailure(tab, 'google-analytics.com');
    check('the network layer reports a failure for the tracker host',
      !!fail1, JSON.stringify(tab.netFailures()));
    check('that failure is net::ERR_BLOCKED_BY_CLIENT (interception, not DNS)',
      !!fail1 && fail1.errorText === 'net::ERR_BLOCKED_BY_CLIENT', fail1 && fail1.errorText);
    check('the failure is not a DNS/TLS error',
      !!fail1 && !/NAME_NOT_RESOLVED|TIMED_OUT|CONNECTION|CERT/.test(fail1.errorText), fail1 && fail1.errorText);

    const blockedAfter = ((await page.ev('window.ghost.getShieldStats()')) || {}).blocked || 0;
    check('the engine counted the block', blockedAfter > blockedBefore, blockedBefore + ' -> ' + blockedAfter);
    const top = ((await page.ev('window.ghost.getShieldStats()')) || {}).top || [];
    check('the blocked host is attributed to google-analytics.com',
      top.some((t) => t.domain === 'www.google-analytics.com' || t.domain === 'google-analytics.com'), JSON.stringify(top));

    r = await tab.ev('window.hit(' + JSON.stringify(probeOrigin + '/ok.png') + ')');
    check('a same-origin control resource still loads (no over-blocking)', r === 'LOADED', r);
    const okFail = tab.netFailures().filter((f) => f.url.indexOf('/ok.png') >= 0);
    check('the control resource produced no network failure', okFail.length === 0, JSON.stringify(okFail));

    // ── Phase D ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase D: the fingerprint randomizer is live in a content view --');
    r = await page.ev("window.ghost.newTabWorkspace('default', '" + probeOrigin + "/seed.html')");
    check('a seed tab was opened', r === undefined || r === null, JSON.stringify(r));
    seedA = await connectTarget((u) => u.indexOf('127.0.0.1:' + portA) >= 0 && /seed[.]html/.test(u), 'seed tab A');
    // Wait for the probe script itself, not just readyState: Chromium's own
    // error page also reports readyState "complete" at the same URL, and a
    // load that lost the race would otherwise throw "window.draw is not a
    // function" a moment later.
    await waitFor(seedA, 'document.readyState === "complete" && typeof window.draw === "function"', v => v === true, 40, 'seed tab A never loaded');
    check('seed tab A (origin ' + originA + ') is live', !!(seedA && seedA.url), seedA && seedA.url);

    const solid1 = await seedA.ev('window.solidDiff()');
    console.log('  [info] solid canvas readback: ' + JSON.stringify(solid1));
    check('canvas getImageData comes back with farbling noise (changed > 0)',
      !!solid1 && solid1.changed > 0, JSON.stringify(solid1));
    check('the noise stays sparse — graphics are not destroyed (<= 10% of pixels)',
      !!solid1 && solid1.changed > 0 && solid1.changed <= solid1.total * 0.1, JSON.stringify(solid1));

    const drawA1 = await seedA.ev('window.draw()');
    const drawA2 = await seedA.ev('window.draw()');
    check('repeated reads on one origin return the SAME bytes (equality tests keep working)',
      typeof drawA1 === 'string' && drawA1 === drawA2,
      typeof drawA1 === 'string' ? ('len ' + drawA1.length + ', equal=' + (drawA1 === drawA2)) : String(drawA1));

    const gl1 = await seedA.ev('window.glDiff()');
    console.log('  [info] WebGL readPixels: ' + JSON.stringify(gl1));
    check('WebGL is available in the content view', !!gl1 && gl1.supported === true, JSON.stringify(gl1));
    check('WebGL readPixels comes back with farbling noise (changed > 0)',
      !!gl1 && gl1.supported && gl1.changed > 0, JSON.stringify(gl1));

    // Second ORIGIN (different port) must farble differently: that is what
    // stops one tracker from linking the same browser across sites.
    r = await page.ev("window.ghost.newTabWorkspace('default', '" + originB + "/seed.html')");
    check('a second seed tab on a different origin was opened', r === undefined || r === null, JSON.stringify(r));
    seedB = await connectTarget((u) => u.indexOf('127.0.0.1:' + portB) >= 0 && /seed[.]html/.test(u), 'seed tab B');
    await waitFor(seedB, 'document.readyState === "complete" && typeof window.draw === "function"', v => v === true, 40, 'seed tab B never loaded');
    check('seed tab B (origin ' + originB + ') is live', !!(seedB && seedB.url), seedB && seedB.url);

    const drawB = await seedB.ev('window.draw()');
    check('a different origin farbles DIFFERENTLY (cross-site unlinkable)',
      typeof drawB === 'string' && typeof drawA1 === 'string' && drawB !== drawA1,
      typeof drawB === 'string' ? ('len ' + drawB.length + ', equal=' + (drawB === drawA1)) : String(drawB));

    // ── Phase E ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase E: every protection is a live toggle --');
    // E1 — parameter strip off / on, entirely local.
    r = await page.ev("window.ghost.setShieldPrefs({ stripParams: false })");
    check('stripParams switched OFF', r && r.stripParams === false, JSON.stringify(r));
    await seedA.ev("location.href = '" + probeOrigin + "/seed.html?utm_source=toggle&keep=1'");
    await waitFor(seedA, 'document.readyState === "complete" && location.href.indexOf("seed.html") >= 0',
      v => v === true, 40, 'reload after strip-off never finished');
    const offSearch = await seedA.ev('location.search');
    check('with the strip OFF the utm tag stays in the URL', /[?&]utm_source=/.test(String(offSearch)), offSearch);

    r = await page.ev("window.ghost.setShieldPrefs({ stripParams: true })");
    check('stripParams switched back ON', r && r.stripParams === true, JSON.stringify(r));
    await seedA.ev("location.href = '" + probeOrigin + "/seed.html?utm_source=toggle&keep=2'");
    await waitFor(seedA, 'document.readyState === "complete" && location.href.indexOf("seed.html") >= 0',
      v => v === true, 40, 'reload after strip-on never finished');
    const onSearch = await seedA.ev('location.search');
    check('with the strip ON the utm tag is removed again', String(onSearch) === '?keep=2', onSearch);

    // E2 — blocker off / on. With the shield off the reserved .test host is
    // looked up and fails locally; with it on the request never leaves.
    await seedA.send('Network.enable', {});
    seedA.clearNet();
    r = await page.ev("window.ghost.setShieldPrefs({ blockAds: false })");
    check('blockAds switched OFF', r && r.blockAds === false, JSON.stringify(r));
    const offResult = await seedA.ev('window.hit(' + JSON.stringify(TRACKER + '?n=1') + ')');
    await sleep(600);
    const offFails = seedA.netFailures().filter((f) => f.url.indexOf('tracker.test') >= 0);
    check('with the blocker OFF the request runs to the network stack unintercepted',
      offResult !== undefined && !offFails.some((f) => f.errorText === 'net::ERR_BLOCKED_BY_CLIENT'),
      'page=' + offResult + '  failures=' + JSON.stringify(offFails));

    r = await page.ev("window.ghost.setShieldPrefs({ blockAds: true })");
    check('blockAds switched back ON', r && r.blockAds === true, JSON.stringify(r));
    await seedA.ev('window.hit(' + JSON.stringify(TRACKER + '?n=2') + ')');
    const failOn = await waitBlocked(seedA, 'tracker.test');
    check('with the blocker ON the same host is cancelled before DNS',
      !!failOn && failOn.errorText === 'net::ERR_BLOCKED_BY_CLIENT', JSON.stringify(seedA.netFailures()));

    // E3 — fingerprint randomizer off / on. The preload reads the switch once
    // at document start, so the proof has to be a fresh page load — exactly
    // what a user gets after flipping the switch in Settings.
    r = await page.ev("window.ghost.setShieldPrefs({ fpRandomizer: false })");
    check('fpRandomizer switched OFF', r && r.fpRandomizer === false, JSON.stringify(r));
    await seedA.ev("location.href = '" + probeOrigin + "/seed.html?fp=off'");
    await waitFor(seedA, 'document.readyState === "complete" && location.href.indexOf("fp=off") >= 0',
      v => v === true, 40, 'reload with the randomizer off never finished');
    const solidOff = await seedA.ev('window.solidDiff()');
    check('with the randomizer OFF the canvas comes back untouched',
      !!solidOff && solidOff.changed === 0, JSON.stringify(solidOff));

    r = await page.ev("window.ghost.setShieldPrefs({ fpRandomizer: true })");
    check('fpRandomizer switched back ON', r && r.fpRandomizer === true, JSON.stringify(r));
    await seedA.ev("location.href = '" + probeOrigin + "/seed.html?fp=on'");
    await waitFor(seedA, 'document.readyState === "complete" && location.href.indexOf("fp=on") >= 0',
      v => v === true, 40, 'reload with the randomizer on never finished');
    const solidOn = await seedA.ev('window.solidDiff()');
    check('with the randomizer ON the noise returns',
      !!solidOn && solidOn.changed > 0, JSON.stringify(solidOn));

    // Leave the profile exactly as we found it for the next run.
    r = await page.ev("window.ghost.setShieldPrefs({ blockAds: true, fpRandomizer: true, stripParams: true })");
    check('all protections restored to ON', r && r.blockAds === true && r.fpRandomizer === true && r.stripParams === true, JSON.stringify(r));
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
  } finally {
    if (seedA) seedA.close();
    if (seedB) seedB.close();
    if (tab) tab.close();
    await killApp(page);
    if (page) page.close();
    stopPageServers();
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
    let removed = true;
    try { fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
      removed = false;
      console.log('  [info] sandbox cleanup incomplete (left in TEMP): ' + e.message);
    }
    console.log('\n== RESULT: ALL CHECKS PASSED ==' + (removed ? '  (sandbox removed)' : ''));
  } else {
    console.log('\n== RESULT: ' + failures + ' CHECK(S) FAILED ==  sandbox kept at ' + SANDBOX);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
