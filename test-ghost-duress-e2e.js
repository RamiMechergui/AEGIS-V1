// test-ghost-duress-e2e.js — isolated E2E test for the Ghost Workspace and the
// Duress Password (panic decoy) inside the REAL app.
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder.
// It copies the app into a temp sandbox, writes a portable.dat marker there so
// all user data lands inside the sandbox, and afterwards asserts that the
// project data\ folder is byte-for-byte unchanged.
//
// Run:  node test-ghost-duress-e2e.js
//
// What is being proven (all of it in a launched AEGIS, not in a unit harness):
//   Phase A  the workspace screen renders the Ghost Workspace card first, with
//            its "in-memory only" pill and WITHOUT rename/delete buttons, and
//            a duress password can be configured from the real session
//   Phase B  the Ghost Workspace lives in a real browser UI: its badge names
//            it, bookmarks/notes are refused there, no history row is ever
//            written, the same origin starts with EMPTY cookie/localStorage
//            (proving the partition is separate from the real workspace),
//            leaving the workspace forgets its tabs instantly, and reopening
//            it starts a brand-new empty session
//   Phase C  NOTHING from the Ghost Workspace ever reaches the disk: no
//            `ghost-ephemeral*` path exists anywhere under data\, and the
//            SQLite file holds zero rows keyed to the ghost workspace
//   Phase D  the duress password opens a separate, believable account: the
//            typed pseudonym is what the UI shows, the decoy has no history,
//            every credential prompt inside it answers with the ordinary
//            "Current password is incorrect.", and the real account (history,
//            workspaces, duress setting) comes back completely untouched
//   Phase E  login timing with the duress password is the same shape as a
//            normal login — no extra work that would reveal a decoy exists
//
// Nothing in this test needs the internet: every probe page is served from a
// local 127.0.0.1 server started by this file.

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'opencode', 'aegis-ghost-e2e');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

const USER = 'ghost-user';
const PASS = 'ghost-secret';
const DURESS = 'panic-password';
const TIMING_USER = 'timing-user';
const TIMING_PASS = 'timing-secret';

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

let nextPort = 9710;
let activePort = null;
const PORT_FILTER = 'remote-debugging-port=';

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

  // main.js / preload.js / yt-tools.js / shield.js / shield-list.txt /
  // fp-preload.js are required at runtime — without them the sandbox app
  // cannot even start.
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
// One origin, several URLs. The SAME origin is used from the real workspace and
// from the Ghost Workspace — which is exactly what makes "same site, different
// partition" observable: any cookie/localStorage the ghost page can read would
// have to have come from the real workspace's jar.
const STORE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ghost probe</title></head>
<body>ghost probe</body>
<script>window.probe = { href: location.href, search: location.search };</script>
</html>`;

let server = null;
let origin = null;
function listen(srv) {
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}
async function startPageServer() {
  server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/store.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(STORE_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('not found');
  });
  const port = await listen(server);
  origin = 'http://127.0.0.1:' + port;
  return origin;
}
function stopPageServer() { if (server) { try { server.close(); } catch (e) {} server = null; } }

// ── Disk inspection ──────────────────────────────────────────────────────────
// The Ghost Workspace's partition must not exist as a directory: a partition
// created WITHOUT the `persist:` prefix never gets a folder in the profile.
function findGhostPaths(root) {
  const out = [];
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (/ghost-ephemeral/i.test(e.name)) out.push(r);
      if (e.isDirectory()) walk(p, r);
    }
  };
  walk(root, '');
  return out;
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
    // quit dialog sends, so before-quit runs flushSessionsSync() (WAL
    // checkpoint) and every file handle is released cleanly.
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

  return {
    url: target.url,
    send,
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

async function waitFor(page, expression, pred, tries = 48, label = '') {
  let last;
  for (let i = 0; i < tries; i++) {
    try { last = await page.ev(expression); } catch (e) { last = 'ERR: ' + e.message; }
    if (pred(last)) return { ok: true, value: last };
    await sleep(250);
  }
  return { ok: false, value: last, label };
}

// Read the probe storage state from a content view: "<localStorage>|<cookie>".
const READ_STORAGE = `((localStorage.getItem('aegis_probe') || 'null') + '|' + document.cookie)`;

// ── SQLite inspection (runs AFTER the app is gone) ───────────────────────────
// better-sqlite3 is built for Electron's ABI, so the reader runs as a tiny
// Electron script, exactly like the other suites do.
function inspectDb() {
  const helper = path.join(SANDBOX, 'inspect-db.js');
  fs.writeFileSync(helper, [
    "const { app } = require('electron');",
    "const path = require('path');",
    "const Database = require('better-sqlite3');",
    "const dbPath = path.join(__dirname, 'data', 'ghostview.db');",
    "let out = {};",
    "try {",
    "  let db;",
    "  try { db = new Database(dbPath, { readonly: true }); } catch (e0) { db = new Database(dbPath); }",
    "  const one = (sql) => { try { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : null; } catch (e) { return 'ERR:' + e.message; } };",
    "  out.workspacesGhost = one(\"SELECT COUNT(*) FROM workspaces WHERE id='ghost'\");",
    "  out.tabsGhost = one(\"SELECT COUNT(*) FROM tabs WHERE workspace_id='ghost'\");",
    "  out.historyGhost = one(\"SELECT COUNT(*) FROM history WHERE workspace_id='ghost'\");",
    "  out.bookmarksGhost = one(\"SELECT COUNT(*) FROM bookmarks WHERE workspace_id='ghost'\");",
    "  out.notesGhost = one(\"SELECT COUNT(*) FROM notes WHERE workspace_id='ghost'\");",
    "  out.downloadsGhost = one(\"SELECT COUNT(*) FROM downloads WHERE workspace_id='ghost'\");",
    "  out.visitsGhost = one(\"SELECT COUNT(*) FROM page_visits WHERE workspace_id='ghost'\");",
    "  out.sessionsGhost = one(\"SELECT COUNT(*) FROM browser_sessions WHERE workspace_id='ghost'\");",
    "  out.duressCols = one(\"SELECT COUNT(*) FROM pragma_table_info('users') WHERE name LIKE 'duress%'\");",
    "  out.realDuressSet = one(\"SELECT COUNT(*) FROM users WHERE pseudo='USERVAL' AND duress_password IS NOT NULL AND duress_salt IS NOT NULL\");",
    "  out.decoyRows = one(\"SELECT COUNT(*) FROM users WHERE pseudo GLOB 'USERVAL_*'\");",
    "  out.decoyWorkspaces = one(\"SELECT COUNT(*) FROM workspaces WHERE user_pseudo GLOB 'USERVAL_*'\");",
    "  out.decoyHistory = one(\"SELECT COUNT(*) FROM history WHERE user_pseudo GLOB 'USERVAL_*'\");",
    "  out.realHistory = one(\"SELECT COUNT(*) FROM history WHERE user_pseudo='USERVAL' AND workspace_id='default'\");",
    "  out.realWorkspaces = one(\"SELECT COUNT(*) FROM workspaces WHERE user_pseudo='USERVAL'\");",
    "  out.userCount = one(\"SELECT COUNT(*) FROM users\");",
    "  db.close();",
    "} catch (e) { out.error = e.message; }",
    "console.log(JSON.stringify(out));",
    "app.quit();",
  ].join('\n').replace(/USERVAL/g, USER));

  try {
    const stdout = execFileSync(ELECTRON, [helper], { cwd: SANDBOX, encoding: 'utf8', timeout: 60000 });
    const line = (stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
    return line ? JSON.parse(line) : { error: 'no JSON from helper: ' + stdout };
  } catch (e) {
    return { error: 'helper failed: ' + e.message };
  }
}

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS Ghost Workspace + Duress Password E2E test ==');
  console.log('  sandbox: ' + SANDBOX);

  cleanupLeftovers();
  await sleep(1500);

  const realBefore = snapshotRealData();
  console.log('  project data\\ snapshot: ' + Object.keys(realBefore).length + ' file(s)');

  setupSandbox();
  const probeOrigin = await startPageServer();
  console.log('  sandbox prepared (portable mode); probe pages at ' + probeOrigin + '\n');

  let page = null;
  let ctlTab = null;
  let ghostA = null;
  let ghostB = null;
  let ghost2 = null;
  // History baseline for the REAL workspace: recorded (>=1 row) before any
  // ghost browsing, re-read after it, and finally compared against the SQLite
  // file once the app is gone. Only "no ghost URL leaked" is compared exactly,
  // because the default workspace's own start-up tab may finish navigating at
  // any moment and legitimately add a row of its own.
  let histMin = 0;
  let histFinal = 0;
  let timings = {};
  let appLog = ['', ''];
  try {
    // ── Phase A ──────────────────────────────────────────────────────────────
    console.log('-- Phase A: workspace screen, ghost card, duress setup --');
    page = await readyApp();

    let r = await page.ev("window.ghost.register('" + USER + "','" + PASS + "')");
    check('register creates the account', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('login succeeds', r && r.ok === true, JSON.stringify(r));

    r = await page.ev('window.ghost.setAutoClose(false, 5)');
    check('idle auto-close disabled for the test run', r && r.ok !== false, JSON.stringify(r));

    r = await page.ev('window.ghost.enterBrowser()');
    r = await waitFor(page,
      `(() => { try { return /workspace[.]html/.test(location.href) && !!window.ghost; } catch(e) { return false; } })()`,
      v => v === true, 80, 'workspace.html never loaded');
    check('workspace.html is the live page', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page, 'document.querySelectorAll(".wc").length', v => typeof v === 'number' && v >= 2, 40, 'workspace cards never rendered');
    check('workspace cards rendered (ghost + real)', r.ok === true && r.value >= 2, JSON.stringify(r.value));

    const card = await page.ev(`(() => {
      const c = document.querySelector('.wc');
      if (!c) return null;
      return {
        name: (c.querySelector('.wc-name') || {}).textContent || '',
        date: (c.querySelector('.wc-date') || {}).textContent || '',
        google: (c.querySelector('.wc-google') || {}).textContent || '',
        pill: !!c.querySelector('.ghost-pill'),
        rename: !!c.querySelector('.wc-rename'),
        del: !!c.querySelector('.wc-del'),
      };
    })()`);
    check('the Ghost Workspace card is FIRST', !!card && card.name === 'Ghost Workspace', JSON.stringify(card));
    check('the ghost card says nothing is written to disk',
      !!card && /nothing is written to disk/i.test(card.date), JSON.stringify(card));
    check('the ghost card carries the "in-memory only" pill', !!card && card.pill === true, JSON.stringify(card));
    check('the ghost card has NO rename button', !!card && card.rename === false, JSON.stringify(card));
    check('the ghost card has NO delete button', !!card && card.del === false, JSON.stringify(card));

    r = await page.ev('window.ghost.getWorkspaces()');
    check('get-workspaces synthesises the ghost row first',
      Array.isArray(r) && r.length >= 2 && r[0].id === 'ghost' && r[0].ghost === true && r[0].name === 'Ghost Workspace',
      JSON.stringify(r && r.map(w => w.id)));
    check('the ghost row carries no creation date', Array.isArray(r) && r[0].created === 0, JSON.stringify(r && r[0]));

    r = await page.ev("window.ghost.renameWorkspace('ghost','Hijacked')");
    check('the ghost workspace cannot be renamed', r && r.ok === false, JSON.stringify(r));
    r = await page.ev("window.ghost.deleteWorkspace('ghost')");
    check('the ghost workspace cannot be deleted', r && r.ok === false, JSON.stringify(r));

    // Duress password: configured from the real session (Settings → Profile).
    r = await page.ev("window.ghost.setDuressPassword('" + DURESS + "')");
    check('the duress password can be set', r && r.ok === true && r.set === true, JSON.stringify(r));

    r = await page.ev("window.ghost.setDuressPassword('" + PASS + "')");
    check('the duress password may not repeat the main password',
      r && r.ok === false && /different/.test(r.error || ''), JSON.stringify(r));

    r = await page.ev('window.ghost.getUser()');
    check('the real session reports duressSet=true, duress=false',
      !!r && r.duressSet === true && r.duress === false && r.pseudo === USER, JSON.stringify(r));

    // ── Phase B ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase B: the ghost session is separate, empty and unrecorded --');
    r = await page.ev("window.ghost.selectWorkspace('default')");
    check('selectWorkspace opens the browser UI', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(page,
      `(() => { try { return /controls[.]html/.test(location.href) && !!window.ghost; } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded');
    check('controls.html is the live page', r.ok === true, JSON.stringify(r.value));

    // Control: the SAME origin keeps storage inside the real workspace, so the
    // empty read in the ghost workspace below means "different partition" and
    // not "storage is broken here".
    r = await page.ev("window.ghost.newTabWorkspace('default','" + probeOrigin + "/store.html?phase=ctl')");
    // Wait for the probe script itself, not just readyState: Chromium's error
    // page also reports readyState "complete" at the same URL, and a load that
    // lost the race would make the storage reads below throw instead of read.
    ctlTab = await connectTarget((u) => /phase=ctl/.test(u), 'control tab');
    await waitFor(ctlTab, 'document.readyState === "complete" && typeof window.probe === "object"', v => v === true, 40, 'control tab never loaded');
    check('control tab is live in the default workspace', !!(ctlTab && ctlTab.url), ctlTab && ctlTab.url);

    await ctlTab.ev(`localStorage.setItem('aegis_probe','from-default'); document.cookie = 'aegis_probe=from-default; path=/'; 'ok'`);
    const ctlStorage = await ctlTab.ev(READ_STORAGE);
    check('control: the default workspace keeps cookie + localStorage',
      ctlStorage === 'from-default|aegis_probe=from-default', ctlStorage);

    r = await waitFor(page, "window.ghost.getHistory('default').then(h => h.length)",
      v => typeof v === 'number' && v >= 1, 32, 'navigation history never recorded in default');
    check('the default workspace records history (control)', r.ok === true, JSON.stringify(r.value));
    histMin = r.ok ? r.value : 0;

    // Enter the Ghost Workspace the way the card does.
    r = await page.ev("window.ghost.selectWorkspace('ghost')");
    check('the ghost card opens the browser UI', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(page,
      `(() => { try { return /controls[.]html/.test(location.href); } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded for ghost');
    check('controls.html is live for the ghost workspace', r.ok === true, JSON.stringify(r.value));

    const active = await page.ev('window.ghost.getActiveWorkspace()');
    check('the active workspace is the Ghost Workspace',
      !!active && active.id === 'ghost' && active.name === 'Ghost Workspace' && active.ghost === true,
      JSON.stringify(active));

    r = await waitFor(page, 'document.getElementById("badge-left").textContent',
      v => v === 'Ghost Workspace', 40, 'workspace badge never showed the ghost name');
    check('the workspace badge names the Ghost Workspace', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page, 'document.getElementById("bm-btn").style.display',
      v => v === 'none', 40, 'bookmark button still visible in ghost');
    check('the bookmark button is hidden where nothing can be bookmarked',
      r.ok === true, JSON.stringify(r.value));

    // Same origin as the control tab — but a brand-new, in-memory partition.
    await page.ev("window.ghost.newTabWorkspace('ghost','" + probeOrigin + "/store.html?phase=gA')");
    ghostA = await connectTarget((u) => /phase=gA/.test(u), 'ghost tab A');
    await waitFor(ghostA, 'document.readyState === "complete" && typeof window.probe === "object"', v => v === true, 40, 'ghost tab A never loaded');
    check('ghost tab A is live', !!(ghostA && ghostA.url), ghostA && ghostA.url);

    const ghostStorage = await ghostA.ev(READ_STORAGE);
    check('the ghost partition starts EMPTY (no cookie/localStorage from the real workspace)',
      ghostStorage === 'null|', ghostStorage);

    await ghostA.ev(`localStorage.setItem('aegis_probe','from-ghost'); document.cookie = 'aegis_probe=from-ghost; path=/'; 'ok'`);
    const ghostStored = await ghostA.ev(READ_STORAGE);
    check('the ghost session can hold storage while it lives',
      ghostStored === 'from-ghost|aegis_probe=from-ghost', ghostStored);

    // A second tab in the same ghost visit shares that in-memory session.
    await page.ev("window.ghost.newTabWorkspace('ghost','" + probeOrigin + "/store.html?phase=gB')");
    ghostB = await connectTarget((u) => /phase=gB/.test(u), 'ghost tab B');
    await waitFor(ghostB, 'document.readyState === "complete" && typeof window.probe === "object"', v => v === true, 40, 'ghost tab B never loaded');
    const ghostBStorage = await ghostB.ev(READ_STORAGE);
    check('a second ghost tab sees the same in-memory session',
      ghostBStorage === 'from-ghost|aegis_probe=from-ghost', ghostBStorage);

    r = await page.ev("window.ghost.getHistory('ghost')");
    check('no history row is written while browsing the ghost workspace',
      Array.isArray(r) && r.length === 0, JSON.stringify(r));

    r = await page.ev("window.ghost.addBookmark('" + probeOrigin + "/store.html?phase=gA','probe')");
    check('bookmarks are refused in the ghost workspace', r && r.ok === false, JSON.stringify(r));

    r = await page.ev("window.ghost.addNote('probe note','ghost')");
    check('notes are refused in the ghost workspace', r && r.ok === false, JSON.stringify(r));

    r = await page.ev('window.ghost.getBookmarks()');
    check('the ghost bookmark list is empty', Array.isArray(r) && r.length === 0, JSON.stringify(r));

    r = await page.ev('window.ghost.getNotes("ghost")');
    check('the ghost note list is empty', Array.isArray(r) && r.length === 0, JSON.stringify(r));

    // ── Phase C ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase C: leaving the ghost workspace discards everything --');
    r = await page.ev("window.ghost.selectWorkspace('default')");
    check('leaving the ghost workspace works', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(page, 'window.ghost.getActiveWorkspace().then(w => w && w.id)',
      v => v === 'default', 40, 'never switched back to default');
    check('the default workspace is active again', r.ok === true, JSON.stringify(r.value));

    r = await page.ev('window.ghost.getWorkspaces()');
    const ghostAfterLeave = Array.isArray(r) ? r.find(w => w.id === 'ghost') : null;
    check('the ghost workspace forgets its tabs the moment you leave',
      !!ghostAfterLeave && ghostAfterLeave.tabCount === 0, JSON.stringify(ghostAfterLeave));

    r = await page.ev("window.ghost.getHistory('default')");
    check('the real workspace history still holds no ghost URL',
      Array.isArray(r) && r.length >= histMin && !r.some((h) => /phase=g/.test(String(h.url || h))),
      (r && r.length) + ' rows, baseline ' + histMin);

    let ghostPaths = findGhostPaths(path.join(SANDBOX, 'data'));
    check('no ghost partition directory exists anywhere under data\\',
      ghostPaths.length === 0, ghostPaths.join(', '));

    // Re-open: every visit must start from a brand-new empty session.
    r = await page.ev("window.ghost.selectWorkspace('ghost')");
    check('the ghost workspace reopens', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(page, 'window.ghost.getActiveWorkspace().then(w => w && w.id)',
      v => v === 'ghost', 40, 'ghost never became active again');
    check('the ghost workspace is active again', r.ok === true, JSON.stringify(r.value));

    r = await page.ev('window.ghost.getWorkspaces()');
    const ghostReopen = Array.isArray(r) ? r.find(w => w.id === 'ghost') : null;
    check('reopening restores NO tabs (nothing was persisted)',
      !!ghostReopen && ghostReopen.tabCount <= 1, JSON.stringify(ghostReopen));

    await page.ev("window.ghost.newTabWorkspace('ghost','" + probeOrigin + "/store.html?phase=g2')");
    ghost2 = await connectTarget((u) => /phase=g2/.test(u), 'ghost reopen tab');
    await waitFor(ghost2, 'document.readyState === "complete" && typeof window.probe === "object"', v => v === true, 40, 'ghost reopen tab never loaded');
    const ghostReopenStorage = await ghost2.ev(READ_STORAGE);
    check('the previous ghost visit is gone — cookie and localStorage are empty again',
      ghostReopenStorage === 'null|', ghostReopenStorage);

    r = await page.ev("window.ghost.getHistory('ghost')");
    check('still no history after reopening', Array.isArray(r) && r.length === 0, JSON.stringify(r));

    ghostPaths = findGhostPaths(path.join(SANDBOX, 'data'));
    check('still no ghost partition on disk after reopening',
      ghostPaths.length === 0, ghostPaths.join(', '));

    // ── Phase D ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase D: the duress password opens a separate account --');
    r = await page.ev('window.ghost.logout()');
    check('logout tears the session down', r && r.ok === true, JSON.stringify(r));
    r = await page.ev("(() => { if (/login[.]html/.test(location.href)) return 'already'; window.location.href = 'login.html'; return 'nav'; })()");
    check('the renderer heads back to the login screen', r === 'nav' || r === 'already', String(r));
    r = await waitFor(page,
      `(() => { try { return /login[.]html/.test(location.href) && !!window.ghost; } catch(e) { return false; } })()`,
      v => v === true, 80, 'login.html never loaded');
    check('login.html is live', r.ok === true, JSON.stringify(r.value));

    // One wrong password: the 3-strike counter allows it, and the successful
    // duress login right after clears it exactly like a real login does.
    let t0 = Date.now();
    r = await page.ev("window.ghost.login('" + USER + "','wrong-password-once')");
    timings.fail = Date.now() - t0;
    check('a wrong password is still rejected',
      r && r.ok === false && !r.wiped && typeof r.attemptsLeft === 'number', JSON.stringify(r));

    t0 = Date.now();
    r = await page.ev("window.ghost.login('" + USER + "','" + DURESS + "')");
    timings.duress = Date.now() - t0;
    check('the duress password logs in like any other password',
      r && r.ok === true && !r.wiped, JSON.stringify(r));

    r = await page.ev('window.ghost.getUser()');
    check('the UI shows the pseudonym that was TYPED, not a derived key',
      !!r && r.pseudo === USER, JSON.stringify(r));
    check('the session is flagged as a decoy session', !!r && r.duress === true, JSON.stringify(r));
    check('the decoy does not advertise a duress password of its own',
      !!r && r.duressSet === false, JSON.stringify(r));

    r = await page.ev('window.ghost.getWorkspaces()');
    check('the decoy account is believable but EMPTY (ghost + default only)',
      Array.isArray(r) && r.length === 2 && r[0].id === 'ghost' && r[1].id === 'default',
      JSON.stringify(r && r.map(w => w.id)));

    r = await page.ev("window.ghost.getHistory('default')");
    check('the decoy account has no history at all',
      Array.isArray(r) && r.length === 0, JSON.stringify(r));

    r = await page.ev("window.ghost.changePassword('" + PASS + "','newpw123')");
    check('changing the password inside the decoy fails with the ORDINARY message',
      r && r.ok === false && r.error === 'Current password is incorrect.', JSON.stringify(r));

    r = await page.ev("window.ghost.setDuressPassword('another-one')");
    check('configuring a duress password inside the decoy fails with the SAME ordinary message',
      r && r.ok === false && r.error === 'Current password is incorrect.', JSON.stringify(r));

    r = await page.ev("window.ghost.verifyPassword('" + PASS + "')");
    check('the real password does NOT unlock the decoy panels', r === false, String(r));

    r = await page.ev("window.ghost.verifyPassword('" + DURESS + "')");
    check('the duress password unlocks the decoy panels (History/Notes gate)',
      r === true, String(r));

    // Back to the real account: everything must be exactly as we left it.
    r = await page.ev('window.ghost.logout()');
    check('logout from the decoy works', r && r.ok === true, JSON.stringify(r));
    t0 = Date.now();
    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    timings.real = Date.now() - t0;
    check('the real password still logs in', r && r.ok === true && !r.wiped, JSON.stringify(r));

    r = await page.ev('window.ghost.getUser()');
    check('the real session is back (duress=false, duressSet=true)',
      !!r && r.pseudo === USER && r.duress === false && r.duressSet === true, JSON.stringify(r));

    r = await page.ev("window.ghost.getHistory('default')");
    check('the real account history survived the decoy session untouched',
      Array.isArray(r) && r.length >= histMin && !r.some((h) => /phase=g/.test(String(h.url || h))),
      (r && r.length) + ' rows, baseline ' + histMin);

    r = await page.ev('window.ghost.getWorkspaces()');
    check('the real account workspaces are intact (ghost + default)',
      Array.isArray(r) && r.length === 2 && r[0].id === 'ghost', JSON.stringify(r && r.map(w => w.id)));

    // ── Phase E ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase E: login timing does not betray a duress password --');
    // A second account with NO duress password: both logins must run the same
    // two PBKDF2 derivations, so neither can be told apart by duration.
    r = await page.ev('window.ghost.logout()');
    check('logout before the timing probe', r && r.ok === true, JSON.stringify(r));
    r = await page.ev("window.ghost.register('" + TIMING_USER + "','" + TIMING_PASS + "')");
    check('a plain account (no duress password) can be registered', r && r.ok === true, JSON.stringify(r));
    t0 = Date.now();
    r = await page.ev("window.ghost.login('" + TIMING_USER + "','" + TIMING_PASS + "')");
    timings.plain = Date.now() - t0;
    check('the plain account logs in', r && r.ok === true, JSON.stringify(r));

    console.log('  [info] login durations (ms): ' + JSON.stringify(timings));
    const fastest = Math.min(timings.duress, timings.real, timings.plain);
    const slowest = Math.max(timings.duress, timings.real, timings.plain);
    check('the duress login is not dramatically slower than any other login',
      timings.duress <= Math.max(timings.real, timings.plain) * 3 + 600,
      timings.duress + ' vs real ' + timings.real + ' / plain ' + timings.plain);
    check('the duress login is not dramatically faster than any other login',
      timings.duress >= Math.min(timings.real, timings.plain) * 0.3 - 300,
      timings.duress + ' vs real ' + timings.real + ' / plain ' + timings.plain);
    console.log('  [info] timing spread ' + fastest + '..' + slowest + ' ms');

    // Final snapshot of the real account's history, taken from a logged-in real
    // session right before the app is shut down — this is the number the SQLite
    // file has to agree with afterwards.
    r = await page.ev('window.ghost.logout()');
    check('logout before the final snapshot', r && r.ok === true, JSON.stringify(r));
    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('back in the real account for the final snapshot', r && r.ok === true, JSON.stringify(r));
    r = await page.ev("window.ghost.getHistory('default').then(h => h.length)");
    histFinal = typeof r === 'number' ? r : -1;
    check('the final history snapshot was captured', histFinal >= histMin, histFinal + ' vs ' + histMin);
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
    if (stderrBuf) console.log('  --- app stderr ---\n' + stderrBuf.trim());
  } finally {
    if (ghostA) ghostA.close();
    if (ghostB) ghostB.close();
    if (ghost2) ghost2.close();
    if (ctlTab) ctlTab.close();
    await killApp(page);
    if (page) page.close();
    stopPageServer();
    appLog = [stdoutBuf, stderrBuf];
  }

  // ── Phase C (on disk): the SQLite file must hold no ghost rows ─────────────
  console.log('\n-- On-disk proof: the SQLite file --');
  const db = inspectDb();
  if (db.error) {
    check('database could be inspected after shutdown', false, db.error);
  } else {
    check('no workspace row for the ghost workspace', db.workspacesGhost === 0, JSON.stringify(db));
    check('no tab rows for the ghost workspace', db.tabsGhost === 0, JSON.stringify(db));
    check('no history rows for the ghost workspace', db.historyGhost === 0, JSON.stringify(db));
    check('no bookmark rows for the ghost workspace', db.bookmarksGhost === 0, JSON.stringify(db));
    check('no note rows for the ghost workspace', db.notesGhost === 0, JSON.stringify(db));
    check('no download rows for the ghost workspace', db.downloadsGhost === 0, JSON.stringify(db));
    check('no analytics visits for the ghost workspace', db.visitsGhost === 0, JSON.stringify(db));
    check('no analytics sessions for the ghost workspace', db.sessionsGhost === 0, JSON.stringify(db));
    check('the duress columns were migrated into the users table', db.duressCols === 3, JSON.stringify(db));
    check('the real account keeps its duress password hash', db.realDuressSet === 1, JSON.stringify(db));
    check('exactly one decoy account row exists', db.decoyRows === 1, JSON.stringify(db));
    check('the decoy account owns its own default workspace', db.decoyWorkspaces === 1, JSON.stringify(db));
    check('the decoy account has no history rows', db.decoyHistory === 0, JSON.stringify(db));
    check('the real account history survived every session', db.realHistory === histFinal, db.realHistory + ' vs ' + histFinal);
    check('the real account workspaces were never duplicated or lost', db.realWorkspaces === 1, JSON.stringify(db));
    check('exactly three accounts exist (real, decoy, timing probe)', db.userCount === 3, JSON.stringify(db));
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
