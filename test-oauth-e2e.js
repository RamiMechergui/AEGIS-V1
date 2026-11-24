// test-oauth-e2e.js — isolated E2E test for the OAuth popup fix (Option B:
// linked popup instead of a detached tab).
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder.
// It copies the app into a temp sandbox, writes a portable.dat marker there so
// all user data lands inside the sandbox, and afterwards asserts that the
// project data\ folder is byte-for-byte unchanged.
//
// Run:  node test-oauth-e2e.js
//
// Two local sites model the real shape of the flow: the RP (login page +
// callback) on one port, the identity provider on another, so "popup returns
// to the opener origin" really is a cross-origin hop like
// chatgpt.com -> accounts.google.com -> chatgpt.com.
//
// What is being proven (all against the REAL main.js window-open router):
//   Phase A  register + login + pick workspace -> the real browser UI
//   Phase B  the content tab speaks a plain Chrome UA: "Chrome/" present,
//            no "Electron" token, no app-name token (Google rejects those
//            with "This browser or app may not be secure")
//   Phase C  window.open(<oauth url>) returns a LIVE window (it used to
//            return null + spawn a detached tab), the opener stays put, and
//            the popup keeps window.opener
//   Phase D  the popup navigates the auth result back with
//            window.opener.postMessage(...) — the channel that was broken —
//            the opener receives it (with the RP cookie + localStorage the
//            popup can only see through the shared session partition), and
//            the popup then closes itself
//   Phase E  window.open('') placeholder popups are real windows too, so the
//            site can navigate them itself (the classic OAuth preamble)
//   Phase F  ordinary popups still open as TABS — no behaviour change
//   Phase G  a repeat of an identical auth/placeholder request NEVER comes
//            back null. ChatGPT's own sign-in code is
//              const m = window.open("about:blank","_blank","");
//              if (m == null) → "We couldn't open the sign-in window. Check
//              your popup blocker and try again."
//            so null IS the reported bug. Stale untouched twins are retired
//            afterwards, so a retry loop still cannot stack login windows.
//   Phase H  window.open() with an explicit size/position (popup,width=…,height=…)
//            is a WINDOW request: answered with a linked window, never a tab.
//            A bare noopener,noreferrer call keeps the old tab behaviour.
//
// The URL classification itself is covered offline by test-oauth.js with the
// real accounts.google.com URLs; here a local /oauth/authorize?client_id=…
// endpoint classifies the same way and keeps the test hermetic.

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP, 'opencode', 'aegis-oauth-test');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

const USER = 'oauth-user';
const PASS = 'oauth-secret';

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

let nextPort = 9530;
let activePort = null;

function cleanupLeftovers() {
  // Pass 1: the test's own browser process (it carries the debugging flag).
  // Pass 2: Chromium helper processes (renderer/gpu/zygote — same exe, no
  // debugging flag) that were orphaned when an aborted run's main process
  // died without taking its children down. They keep the sandbox files locked
  // and make the next run's rmSync fail with EPERM. Only orphans are touched:
  // helpers whose parent is still alive belong to a running AEGIS instance.
  const script = [
    "$exe = '*AEGIS-V1*'",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -like $exe -and $_.CommandLine -like '*remote-debugging-port=*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    'Start-Sleep -Milliseconds 800',
    "$alive = (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' }).ProcessId",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -like $exe -and ($alive -notcontains $_.ParentProcessId) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join('\n');
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' }); } catch (e) {}
}

// ── Sandbox setup ────────────────────────────────────────────────────────────
function dropJunction() {
  try { fs.rmdirSync(path.join(SANDBOX, 'node_modules')); } catch (e) { /* not a junction / absent */ }
}
async function setupSandbox() {
  dropJunction();
  // Windows keeps file handles a moment after the owning process dies, so a
  // fresh rmSync can hit EPERM — retry with a pause instead of aborting.
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3 }); lastErr = null; break; }
    catch (e) { lastErr = e; dropJunction(); await sleep(500); }
  }
  if (lastErr) throw lastErr;
  fs.mkdirSync(SANDBOX, { recursive: true });

  // Every file main.js requires at runtime must ship — without them the
  // sandbox app cannot start (the same list audit.js enforces for packaging).
  const files = ['main.js', 'preload.js', 'yt-tools.js', 'shield.js', 'shield-list.txt', 'vault.js', 'oauth.js', 'playlist-queue.js',
    'fp-preload.js', 'package.json', 'logo.png', 'logo.ico']
    .concat(fs.readdirSync(SRC).filter((f) => f.endsWith('.html')));
  for (const f of files) fs.copyFileSync(path.join(SRC, f), path.join(SANDBOX, f));

  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(SANDBOX, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(SANDBOX, 'portable.dat'), '');
  fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
}

// ── Two local sites: the relying party (opener + callback) and the IdP ───────
let rpServer = null;
let idpServer = null;
let rpOrigin = null;
let idpOrigin = null;
const page = (title, body) =>
  '<!doctype html>\n<meta charset="utf-8">\n<title>' + title + '</title>\n<body>' + body + '</body>\n';

// The opener page: seeds cookie + localStorage, records whatever the popup
// posts back, and exposes the probe script used by every phase.
const PROBE_SCRIPT = `
<script>
  window.__lastMsg = null;
  window.__lastPing = null;
  window.addEventListener('message', function (e) {
    var d = e.data;
    try { var o = JSON.parse(d); if (o && o.ping) { window.__lastPing = d; return; } } catch (err) {}
    window.__lastMsg = d;
  });
  document.cookie = 'aegis_oauth_probe=shared; path=/';
  try { localStorage.setItem('aegis_oauth_ls', 'shared'); } catch (e) {}
</script>`;

// The callback page: hands the auth result to the opener over window.opener —
// exactly the channel a detached tab used to lose.
const CALLBACK_SCRIPT = `
<script>
  var payload = { marker: null, opener: !!window.opener, cookie: document.cookie, ls: null, ua: navigator.userAgent };
  try { payload.marker = new URLSearchParams(location.search).get('from'); } catch (e) {}
  try { payload.ls = localStorage.getItem('aegis_oauth_ls'); } catch (e) {}
  try { if (window.opener) window.opener.postMessage(JSON.stringify(payload), '*'); } catch (e) { payload.err = String(e); }
</script>`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
async function startServers() {
  // Relying party: the login page (opener) + the callback it returns to.
  rpServer = http.createServer((req, res) => {
    const u = (req.url || '/').split('?')[0];
    let html;
    if (u === '/probe.html') html = page('aegis oauth probe', 'oauth probe' + PROBE_SCRIPT);
    else if (u === '/callback.html') html = page('callback done', 'callback' + CALLBACK_SCRIPT);
    else if (u === '/ordinary.html') html = page('ordinary', 'ordinary');
    else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  rpOrigin = await listen(rpServer);

  // Identity provider: a different origin, like accounts.google.com.
  idpServer = http.createServer((req, res) => {
    const u = (req.url || '/').split('?')[0];
    if (u !== '/oauth/authorize') { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page('provider authorize', 'authorize'));
  });
  idpOrigin = await listen(idpServer);
}
function stopServers() {
  for (const s of [rpServer, idpServer]) { try { if (s) s.close(); } catch (e) {} }
  rpServer = idpServer = null;
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
async function killApp(uiPage) {
  if (child && child.exitCode === null) {
    // Shut down the way a real user does, so before-quit flushes SQLite.
    if (uiPage) { try { await Promise.race([uiPage.ev("window.ghost.confirmQuitAction('quit')"), sleep(3000)]); } catch (e) { /* closing */ } }
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
      s.on('timeout' , () => { s.destroy(); res(true); });
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
  const p = await startApp();
  for (let i = 0; i < 40; i++) {
    try { if (await p.ev('!!window.ghost') === true) return p; } catch (e) { /* not ready */ }
    await sleep(250);
  }
  return p;
}

async function waitFor(target, expression, pred, tries = 48, label = '') {
  let last;
  for (let i = 0; i < tries; i++) {
    try { last = await target.ev(expression); } catch (e) { last = 'ERR: ' + e.message; }
    if (pred(last)) return { ok: true, value: last };
    await sleep(250);
  }
  return { ok: false, value: last, label };
}

// Waits until no page target matches (used for the auto-close assertions).
async function waitGone(match, tries = 32) {
  for (let i = 0; i < tries; i++) {
    const list = await listTargets();
    if (!list.some((t) => t.type === 'page' && match(t.url))) return { ok: true, value: 'gone' };
    await sleep(250);
  }
  return { ok: false, value: 'still open' };
}

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS OAuth linked-popup E2E test ==');
  console.log('  sandbox: ' + SANDBOX);

  cleanupLeftovers();
  await sleep(1500);

  const realBefore = snapshotRealData();
  console.log('  project data\\ snapshot: ' + Object.keys(realBefore).length + ' file(s)');

  await setupSandbox();
  await startServers();
  console.log('  sandbox prepared (portable mode)');
  console.log('  relying party: ' + rpOrigin + '   identity provider: ' + idpOrigin + '\n');

  const OAUTH_URL = idpOrigin + '/oauth/authorize?client_id=e2e&response_type=code&state=xyz';
  const CALLBACK_URL = (from) => rpOrigin + '/callback.html?from=' + from;
  const ORDINARY_URL = rpOrigin + '/ordinary.html';

  let ui = null;
  let tab = null;
  let popup = null;
  let appLog = ['', ''];
  const isPopupUrl = (u) => u.indexOf('/oauth/authorize') >= 0;
  const isAnyAuthWindow = (u) => u.indexOf('/callback.html') >= 0 || u.indexOf('/oauth/authorize') >= 0;

  try {
    // ── Phase A ──────────────────────────────────────────────────────────────
    console.log('-- Phase A: reach the real browser UI --');
    ui = await readyApp();

    let r = await ui.ev("window.ghost.register('" + USER + "','" + PASS + "')");
    check('register creates the account', r && r.ok === true, JSON.stringify(r));
    r = await ui.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('login succeeds', r && r.ok === true, JSON.stringify(r));
    r = await ui.ev('window.ghost.setAutoClose(false, 5)');
    check('idle auto-close disabled for the test run', r && r.ok !== false, JSON.stringify(r));
    r = await ui.ev("window.ghost.selectWorkspace('default')");
    check('selectWorkspace opens the browser UI', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(ui,
      `(() => { try { return /controls[.]html/.test(location.href) && !!window.ghost; } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded');
    check('controls.html is the live page', r.ok === true, JSON.stringify(r.value));

    // ── Phase B ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase B: plain Chrome User-Agent on a content tab --');
    r = await ui.ev("window.ghost.newTabWorkspace('default', '" + rpOrigin + "/probe.html')");
    check('a tab was opened in the default workspace', r === undefined || r === null, JSON.stringify(r));

    tab = await connectTarget((u) => /probe[.]html/.test(u), 'probe tab');
    check('probe tab is reachable over CDP', !!tab && /probe[.]html/.test(tab.url || ''), tab && tab.url);

    r = await waitFor(tab,
      `(() => { try { return document.readyState === 'complete' && location.href.indexOf('probe.html') >= 0; } catch(e) { return false; } })()`,
      v => v === true, 40, 'probe page never finished loading');
    check('probe page finished loading', r.ok === true, JSON.stringify(r.value));

    const ua = String(await tab.ev('navigator.userAgent'));
    console.log('  [info] content UA: ' + ua);
    check('UA advertises Chrome', /Chrome\/[\d.]+/.test(ua), ua);
    check('UA has no Electron token', !/Electron\//i.test(ua), ua);
    check('UA has no app-name token', !/aegis/i.test(ua), ua);

    // ── Phase C ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase C: OAuth window.open() yields a LINKED popup --');
    const baseline = (await listTargets()).filter((t) => t.type === 'page').length;

    r = await tab.ev(`(() => {
      const w = window.open(${JSON.stringify(OAUTH_URL)}, 'aegis-oauth-e2e');
      return w === null ? 'NULL' : 'WINDOW';
    })()`);
    check('window.open(oauth) returns a LIVE window (old code returned null)', r === 'WINDOW', r);

    r = await waitFor(tab, 'location.href', (v) => String(v).indexOf('probe.html') >= 0, 8, 'opener navigated away');
    check('the opener tab stayed on the probe page (no detached navigation)', r.ok === true, r.value);

    popup = await connectTarget(isPopupUrl, 'oauth popup');
    check('the auth window exists as its own target', !!popup, 'not found');
    const pagesNow = (await listTargets()).filter((t) => t.type === 'page').length;
    check('exactly one new window (popup, not a detached tab storm)', pagesNow === baseline + 1, baseline + ' -> ' + pagesNow);

    r = await popup.ev('typeof window.opener');
    check('popup keeps window.opener (postMessage channel intact)', r === 'object', r);
    // opener.location is cross-origin from the IdP (and must be blocked) —
    // prove the link works the way OAuth actually uses it: a postMessage.
    r = await popup.ev(`(() => {
      try { window.opener.postMessage(JSON.stringify({ ping: location.origin }), '*'); } catch (e) { return 'THREW:' + e.message; }
      return 'PINGED';
    })()`);
    check('popup can message its opener across origins', r === 'PINGED', r);
    r = await waitFor(tab, 'window.__lastPing', (v) => typeof v === 'string' && v.length > 2, 24,
      'opener never received the ping');
    check('…and the opener really received it', r.ok === true, r.value);
    check('the ping came from the identity-provider origin', String(r.value).indexOf(idpOrigin) >= 0, r.value);
    const popupUa = String(await popup.ev('navigator.userAgent'));
    check('popup speaks the same plain Chrome UA', /Chrome\/[\d.]+/.test(popupUa) && !/Electron\//i.test(popupUa), popupUa);

    // ── Phase D ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase D: result reaches the opener, popup closes itself --');
    r = await popup.ev('location.href = ' + JSON.stringify(CALLBACK_URL('d')) + '; "navigating"');
    check('popup was sent back to the callback page', r === 'navigating', r);

    const closed = await waitGone(isAnyAuthWindow);
    check('popup closed itself after the callback (auto-close)', closed.ok === true, closed.value);

    r = await waitFor(tab, 'window.__lastMsg', (v) => typeof v === 'string' && v.length > 2, 24,
      'opener never received the postMessage');
    check('opener received the result over window.opener.postMessage', r.ok === true, r.value);
    let msg = null;
    try { msg = JSON.parse(String(r.value)); } catch (e) { /* reported below */ }
    check('message says the popup had an opener', !!msg && msg.opener === true, r.value);
    check('popup saw the RP cookie on return (shared cookie store)',
      !!msg && String(msg.cookie).indexOf('aegis_oauth_probe=shared') >= 0, r.value);
    check('popup saw the RP localStorage on return (shared storage)',
      !!msg && msg.ls === 'shared', r.value);
    check('returned page carries a clean Chrome UA',
      !!msg && /Chrome\/[\d.]+/.test(msg.ua || '') && !/Electron\//i.test(msg.ua || ''), msg && msg.ua);

    r = await tab.ev('location.href');
    check('opener tab is still alive on the probe page', String(r).indexOf('probe.html') >= 0, r);
    if (popup) { popup.close(); popup = null; }

    // ── Phase E ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase E: blank placeholder popups stay navigable --');
    r = await tab.ev(`(() => {
      const w = window.open('');
      if (w === null) return 'NULL';
      w.location = ${JSON.stringify(OAUTH_URL)};
      return 'WINDOW';
    })()`);
    check('window.open("") returns a LIVE window the site can drive', r === 'WINDOW', r);

    const driven = await connectTarget(isPopupUrl, 'blank-then-navigated popup');
    check('the placeholder popup accepted the site navigation', !!driven, 'not found');
    r = await waitFor(driven, 'location.pathname', (v) => v === '/oauth/authorize', 32, 'popup never reached the auth URL');
    check('…and landed on the authorization endpoint', r.ok === true, r.value);
    r = await driven.ev('typeof window.opener');
    check('it also keeps window.opener', r === 'object', r);

    r = await driven.ev('location.href = ' + JSON.stringify(CALLBACK_URL('e')) + '; "navigating"');
    check('placeholder popup sent back to the callback', r === 'navigating', r);
    const closed2 = await waitGone(isAnyAuthWindow);
    check('placeholder popup auto-closed too', closed2.ok === true, closed2.value);
    r = await waitFor(tab, 'window.__lastMsg', (v) => {
      try { return typeof v === 'string' && JSON.parse(v).marker === 'e'; } catch (e) { return false; }
    }, 24, 'opener never received the second postMessage');
    check('second result also reached the opener', r.ok === true, r.value);
    driven.close();

    // ── Phase F ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase F: ordinary popups still open as tabs --');
    r = await tab.ev(`(() => {
      const w = window.open(${JSON.stringify(ORDINARY_URL)}, 'aegis-ordinary');
      return w === null ? 'NULL' : 'WINDOW';
    })()`);
    check('ordinary window.open is still denied to the page', r === 'NULL', r);
    const newTab = await connectTarget((u) => u.indexOf('/ordinary.html') >= 0, 'ordinary new tab');
    check('…and opened as a normal new tab instead', !!newTab, 'not found');
    newTab.close();

    // ── Phase G ──────────────────────────────────────────────────────────────
    // This is literally ChatGPT's sign-in code:
    //     const m = window.open("about:blank","_blank","");
    //     if (m == null) → "We couldn't open the sign-in window. Check your
    //     popup blocker and try again."
    // so the invariant is: NO repeat of an auth/placeholder request may ever
    // come back null, no matter how quickly it is made.
    console.log('\n-- Phase G: a repeat never comes back null (the popup-blocker error) --');
    const blankTarget = (u) => u === '' || u === 'about:blank' || /^about:blank#/.test(u);
    const blanksBefore = (await listTargets()).filter((t) => t.type === 'page' && blankTarget(t.url)).length;

    r = await tab.ev(`(() => {
      const a = window.open('about:blank');
      const b = window.open('about:blank');
      return (a === null ? 'NULL' : 'WINDOW') + '/' + (b === null ? 'NULL' : 'WINDOW');
    })()`);
    check('two identical requests in the same tick BOTH return a live window', r === 'WINDOW/WINDOW', r);

    await sleep(1800); // let those placeholders become stale and go nowhere
    r = await tab.ev(`(window.open('about:blank') === null ? 'NULL' : 'WINDOW')`);
    check('a later identical request also returns a live window', r === 'WINDOW', r);

    // …but a genuine retry loop must still not stack login windows: the fresh
    // request wins and the untouched twins are retired.
    await sleep(900);
    let matches = (await listTargets()).filter((t) => t.type === 'page' && blankTarget(t.url));
    check('stale identical placeholders are retired — exactly ONE window remains',
      matches.length - blanksBefore === 1, 'baseline ' + blanksBefore + ' -> ' + matches.length);

    const leftover = await connectTarget(blankTarget, 'leftover placeholder window');
    if (leftover) {
      await leftover.ev('window.close(); "closed"').catch(() => {});
      leftover.close();
      await sleep(400);
    }

    // ── Phase H ──────────────────────────────────────────────────────────────
    // window.open() with an explicit size/position is a WINDOW request by
    // definition — answering it with a tab would return null and trip the same
    // popup-blocked error on any site that checks the result.
    console.log('\n-- Phase H: an explicit popup size means a window, not a tab --');
    r = await tab.ev(`(() => {
      const w = window.open(${JSON.stringify(ORDINARY_URL + '?sized=1')}, '', 'popup,width=480,height=640');
      return w === null ? 'NULL' : 'WINDOW';
    })()`);
    check('window.open(url, …, "popup,width=480,height=640") returns a live window', r === 'WINDOW', r);
    const sized = await connectTarget((u) => u.indexOf('ordinary.html?sized=1') >= 0, 'sized popup');
    check('…created as its own window', !!sized, 'not found');
    if (sized) {
      r = await sized.ev('typeof window.opener');
      check('…still linked to the opener (window.opener intact)', r === 'object', r);
      await sized.ev('window.close(); "closed"').catch(() => {});
      sized.close();
      await sleep(400);
    }

    // A size-less "open in new tab" idiom must keep the tab behaviour.
    r = await tab.ev(`(() => {
      const w = window.open(${JSON.stringify(ORDINARY_URL + '?noopener=1')}, '', 'noopener,noreferrer');
      return w === null ? 'NULL' : 'WINDOW';
    })()`);
    check('noopener,noreferrer alone still opens a TAB (unchanged behaviour)', r === 'NULL', r);
    const noopTab = await connectTarget((u) => u.indexOf('noopener=1') >= 0, 'noopener tab');
    check('…and the tab exists', !!noopTab, 'not found');
    if (noopTab) noopTab.close();
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
  } finally {
    if (tab) tab.close();
    if (popup) popup.close();
    await killApp(ui);
    if (ui) ui.close();
    stopServers();
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
    dropJunction();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
      console.log('  [info] sandbox cleanup incomplete: ' + e.message);
    }
    console.log('\n== RESULT: ALL CHECKS PASSED ==  (sandbox removed)');
  } else {
    console.log('\n== RESULT: ' + failures + ' FAILURE(S) ==  (sandbox kept for inspection: ' + SANDBOX + ')');
  }
  process.exit(failures ? 1 : 0);
})();
