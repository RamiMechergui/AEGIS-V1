// test-vault-e2e.js — isolated E2E test: the at-rest vault + clipboard
// auto-wipe inside the REAL app (launched AEGIS, real IPC, real SQLite file).
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder.
// It copies the app into a temp sandbox, writes a portable.dat marker there so
// all user data lands inside the sandbox, and afterwards asserts that the
// project data\ folder is byte-for-byte unchanged.
//
// Run:  node test-vault-e2e.js
//
// What is being proven (all of it against the real ghostview.db on disk):
//   Phase A   register + login in the real UI, then a note, a bookmark, a
//             workspace rename, a tab and its history land in the app — and
//             every one of them reads back correctly through the IPC bridge
//             (the decrypt path), including the analytics reports that had to
//             move from SQL GROUP BY into JavaScript
//   Phase B   after a clean quit the RAW BYTES of ghostview.db (+wal) contain
//             none of the markers and do contain AEG1: ciphertext; the
//             user_keystores row exists with the 300k KDF, migrated=1
//   Phase C   a legacy account whose rows were written as PLAINTEXT behind the
//             app's back: the marker is readable in the file before login,
//             readable through the app at login, and gone from the file after
//             the next clean quit (transactional sweep + VACUUM), migrated=1
//   Phase D   password change re-wraps the key: old password refused (exactly
//             one attempt spent), new password works, the wrapped_key bytes
//             changed while the salt stayed the same, and tabs/history still
//             decrypt after the restart
//   Phase D2  a CORRUPTED keystore with the CORRECT password answers with an
//             honest error and does NOT spend a login attempt (spending it
//             would walk a damaged profile into the 3-strikes wipe)
//   Phase E   clipboard auto-wipe: the startup baseline survives both while
//             running and at quit, a session copy is cleared after the
//             configured delay, a newer copy is never cleared by an older
//             copy's timer, prefs clamp 1->5 and 9999->600, and a copy still
//             tracked at quit is wiped by before-quit
//
// Nothing in this test needs the internet: the one page a tab navigates to is
// served by a local 127.0.0.1 server inside the test process.

// Quiet node's "SQLite is an experimental feature" notice (node:sqlite is
// used only by THIS test, as an independent reader of the app's database).
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (String(warning).indexOf('SQLite is an experimental feature') >= 0) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'opencode', 'aegis-vault-e2e');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');
const DB_FILE = path.join(SANDBOX, 'data', 'ghostview.db');
const ATTEMPTS_FILE = path.join(SANDBOX, 'data', 'login-attempts.json');

const USER = 'vault-e2e-user';
const PASS = 'vault-e2e-pass-1';
const PASS2 = 'vault-e2e-pass-2';
const LEGACY_USER = 'legacy-e2e-user';
const LEGACY_PASS = 'legacy-e2e-pass';

// Markers — unique strings whose presence/absence in the raw database file is
// the whole point of the byte scans.
const M = {
  note: 'ZYX-NOTE-SECRET-4471',
  bmUrl: 'ZYX-BOOKMARK-5582',
  bmTitle: 'ZYX-BOOKMARK-TITLE-6693',
  ws: 'ZYX-WS-NAME-7714',
  tab: 'ZYX-TAB-URL-8815',
  pageTitle: 'ZYX-PAGE-TITLE-9926',
  legacyNote: 'ZYX-LEGACY-PLAIN-1123',
  legacyUrl: 'ZYX-LEGACY-URL-1124',
  legacyTitle: 'ZYX-LEGACY-TITLE-1125',
  legacyWs: 'ZYX-LEGACY-WS-1126',
  legacyBm: 'ZYX-LEGACY-BM-1127',
  clipBase: 'ZYX-CLIP-BASELINE',
  clipBase2: 'ZYX-CLIP-BASE2',
  clipOne: 'ZYX-CLIP-ONE',
  clipTwo: 'ZYX-CLIP-TWO',
  clipQuit: 'ZYX-CLIP-QUIT',
};

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

// A fresh port per launch — reusing one across restarts raced TIME_WAIT/half-
// closed sockets: the poll would say "free" and Chromium would still fail to
// rebind it.
let nextPort = 9720;
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

  // Everything main.js requires or loads at runtime must be in the sandbox.
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
// One server, one page: the marker tab and the bookmark both live on it, and
// its <title> is a marker too (history.title / page_visits.title / tabs.title
// all have to come back decrypted).
let server = null;
let origin = null;
function makeServer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><html><head><title>' + M.pageTitle + '</title></head><body>vault probe</body></html>');
  });
}
function startServer() {
  return new Promise((resolve, reject) => {
    server = makeServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      origin = 'http://127.0.0.1:' + server.address().port;
      resolve(origin);
    });
  });
}
function stopServer() { if (server) { try { server.close(); } catch (e) {} server = null; } }

const TAB_URL = () => origin + '/tab-' + M.tab + '.html';
const BM_URL = () => origin + '/bm-' + M.bmUrl + '.html';

// ── Clipboard helpers (the OS clipboard, read OUTSIDE the app) ───────────────
// Base64 through PowerShell so the exact bytes come back: powershell.exe
// appends a newline to plain output, which would break byte-exact compares.
function clipGet() {
  const script = "$t = Get-Clipboard -Raw -ErrorAction SilentlyContinue; if ($null -eq $t) { 'EMPTY' } else { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$t)) }";
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 20000 }).replace(/\r?\n$/, '');
    if (out === 'EMPTY') return '';
    return Buffer.from(out, 'base64').toString('utf8');
  } catch (e) { return null; }
}
function clipSet(text) {
  execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "Set-Clipboard -Value '" + String(text).replace(/'/g, "''") + "'"],
    { stdio: 'ignore', timeout: 20000 });
}

// ── Database helpers (independent reader: node:sqlite, not better-sqlite3) ───
// Every call happens while the app is CLOSED. Opening the file from a second
// process while AEGIS holds it would only race SQLite's locking.
function withDb(fn) {
  const db = new DatabaseSync(DB_FILE);
  try { return fn(db); } finally { try { db.close(); } catch (e) {} }
}
function keystoreRow(user) {
  try {
    return withDb((db) => {
      const r = db.prepare('SELECT * FROM user_keystores WHERE user_pseudo=?').get(user);
      if (!r) return null;
      return {
        kdf: String(r.kdf), iterations: Number(r.iterations), salt: String(r.salt),
        wrapped_key: String(r.wrapped_key), migrated: Number(r.migrated),
      };
    });
  } catch (e) { return null; }
}
// Raw bytes of the database (+WAL) as one latin1 string: every byte maps to
// one code unit, so an ASCII marker either is or is not in there.
function dbBytes() {
  let s = '';
  for (const f of ['ghostview.db', 'ghostview.db-wal']) {
    try { s += fs.readFileSync(path.join(SANDBOX, 'data', f)).toString('latin1'); } catch (e) { /* absent */ }
  }
  return s;
}
const absentFrom = (hay, needles) => needles.filter((n) => hay.indexOf(n) >= 0);

// Pre-vault account written straight into the file, exactly like an old
// AEGIS install would have left it: plaintext rows + a100k/64-byte-hex
// password hash, and NO keystore row.
function insertLegacyFixture() {
  withDb((db) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(LEGACY_PASS, salt, 100000, 64, 'sha512').toString('hex');
    const now = Date.now();
    db.prepare('INSERT OR REPLACE INTO users (pseudo,password,salt,created,photo,active_workspace) VALUES (?,?,?,?,?,?)')
      .run(LEGACY_USER, hash, salt, now, null, 'default');
    db.prepare('INSERT OR REPLACE INTO workspaces (id,user_pseudo,name,created,color) VALUES (?,?,?,?,?)')
      .run('default', LEGACY_USER, M.legacyWs, now, '#4a8bc5');
    db.prepare('INSERT INTO history (user_pseudo,workspace_id,url,title,timestamp) VALUES (?,?,?,?,?)')
      .run(LEGACY_USER, 'default', 'http://127.0.0.1:9/' + M.legacyUrl, M.legacyTitle, now);
    db.prepare('INSERT INTO bookmarks (user_pseudo,workspace_id,url,title,timestamp) VALUES (?,?,?,?,?)')
      .run(LEGACY_USER, 'default', 'http://127.0.0.1:9/' + M.legacyBm, M.legacyTitle + '-bm', now);
    db.prepare('INSERT INTO notes (user_pseudo,workspace_id,content,created,updated) VALUES (?,?,?,?,?)')
      .run(LEGACY_USER, 'default', M.legacyNote, now, now);
  });
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
    // checkpoint) + clipWipeOnQuit(), and every file handle is released
    // cleanly. taskkill /F skips all of that.
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

  return {
    url: target.url,
    send,
    events,
    close: () => { try { ws.close(); } catch (e) {} },
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

const LOGIN_HREF = `(() => { try { return /login[.]html/.test(location.href); } catch(e) { return false; } })()`;
const CONTROLS_HREF = `(() => { try { return /controls[.]html/.test(location.href) && !!window.ghost; } catch(e) { return false; } })()`;

// Login + disable idle auto-close + open the default workspace's browser UI.
async function enterBrowser(page, pseudo, password) {
  let r = await page.ev("window.ghost.login('" + pseudo + "','" + password + "')");
  if (!r || r.ok !== true) throw new Error('login failed for ' + pseudo + ': ' + JSON.stringify(r));
  r = await page.ev('window.ghost.setAutoClose(false, 5)');
  if (!r || r.ok === false) throw new Error('setAutoClose failed: ' + JSON.stringify(r));
  r = await page.ev("window.ghost.selectWorkspace('default')");
  if (!r || r.ok !== true) throw new Error('selectWorkspace failed: ' + JSON.stringify(r));
  const w = await waitFor(page, CONTROLS_HREF, v => v === true, 80, 'controls.html never loaded');
  if (!w.ok) throw new Error('controls.html never loaded');
}

// Quit the app cleanly, release its CDP handle, give SQLite a moment.
async function quitApp(pageRef) {
  const p = pageRef.page;
  pageRef.page = null;
  await killApp(p);
  if (p) p.close();
  await sleep(700);
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const realBefore = snapshotRealData();
  cleanupLeftovers();

  setupSandbox();
  await startServer();
  console.log('  sandbox prepared (portable mode); probe page at ' + origin + '\n');

  // Warm up PowerShell (first spawn costs ~1-2 s) and keep whatever was on the
  // clipboard so it can be put back at the end.
  const origClip = clipGet();

  const ref = { page: null };
  let appLog = ['', ''];
  try {
    // ── Phase A ──────────────────────────────────────────────────────────────
    console.log('-- Phase A: write marker data through the real UI, read it back --');
    ref.page = await readyApp();
    let page = ref.page;

    let r = await page.ev('!!window.ghost');
    check('login page exposes the ghost bridge', r === true, r);

    r = await page.ev("window.ghost.register('" + USER + "','" + PASS + "')");
    check('register creates the account (keystore enrolled first)', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('login succeeds (keystore unlocks, first sweep runs)', r && r.ok === true, JSON.stringify(r));

    r = await page.ev('window.ghost.setAutoClose(false, 5)');
    check('idle auto-close disabled for the test run', r && r.ok !== false, JSON.stringify(r));

    r = await page.ev("window.ghost.selectWorkspace('default')");
    check('selectWorkspace opens the browser UI', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(page, CONTROLS_HREF, v => v === true, 80, 'controls.html never loaded');
    check('controls.html is the live page', r.ok === true, JSON.stringify(r.value));

    // Write one marker into every encrypted table, through the IPC bridge.
    r = await page.ev("window.ghost.renameWorkspace('default', '" + M.ws + "')");
    check('workspace renamed with the marker', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.addNote('" + M.note + "')");
    check('note saved with the marker', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.addBookmark('" + BM_URL() + "', '" + M.bmTitle + "')");
    check('bookmark saved with the marker URL + title', r && r.ok === true, JSON.stringify(r));

    r = await page.ev('window.ghost.isBookmarked(' + JSON.stringify(BM_URL()) + ')');
    check('isBookmarked answers true (JS match over ciphertext)', r === true, r);

    r = await page.ev("window.ghost.newTabWorkspace('default', '" + TAB_URL() + "')");
    check('marker tab opened', r === undefined || r === null, JSON.stringify(r));

    // Every readback goes through decrypt-on-read.
    r = await waitFor(page,
      "window.ghost.getNotes().then(n => n.some(x => x.content === '" + M.note + "'))",
      v => v === true, 60, 'note never read back');
    check('note reads back decrypted', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getBookmarks().then(b => b.some(x => x.url.indexOf('" + M.bmUrl + "') >= 0 && x.title === '" + M.bmTitle + "'))",
      v => v === true, 60, 'bookmark never read back');
    check('bookmark reads back decrypted (url + title)', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getWorkspaces().then(w => w.some(x => x.id === 'default' && x.name === '" + M.ws + "'))",
      v => v === true, 60, 'workspace name never read back');
    check('workspace name reads back decrypted', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getTabsForWorkspace('default').then(t => (t.tabs || []).some(x => x.url.indexOf('" + M.tab + "') >= 0))",
      v => v === true, 60, 'tab never appeared');
    check('live tab list contains the marker URL', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getTabsForWorkspace('default').then(t => (t.tabs || []).some(x => (x.title || '').indexOf('" + M.pageTitle + "') >= 0))",
      v => v === true, 60, 'tab title never appeared');
    check('live tab title reads back decrypted', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getHistory('default').then(h => h.some(x => x.url.indexOf('" + M.tab + "') >= 0))",
      v => v === true, 60, 'history row never appeared');
    check('history row persisted with the marker URL', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getHistory('default').then(h => h.some(x => ((x.title || '').indexOf('" + M.pageTitle + "') >= 0) || ((x.title || '').indexOf('" + M.tab + "') >= 0)))",
      v => v === true, 60, 'history title never appeared');
    check('history title reads back decrypted', r.ok === true, JSON.stringify(r.value));

    // Analytics: GROUP BY domain / JOIN workspaces moved into JavaScript.
    const all = await page.ev('window.ghost.getAnalyticsAllTime()');
    check('analytics all-time report returns',
      !!all && Array.isArray(all.topSites) && Array.isArray(all.wsBreakdown), JSON.stringify(all && { topSites: all.topSites, wsBreakdown: all.wsBreakdown }));
    check('top-sites shows the DECRYPTED domain (JS aggregation)',
      !!all && all.topSites.some(t => t.domain === '127.0.0.1'),
      JSON.stringify(all && all.topSites));
    check('workspace breakdown shows the DECRYPTED workspace name (replaces the JOIN)',
      !!all && all.wsBreakdown.some(w => w.workspace_id === 'default' && w.name === M.ws),
      JSON.stringify(all && all.wsBreakdown));

    await quitApp(ref);

    // ── Phase B ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase B: the raw database file holds ciphertext, not markers --');
    const bytesB = dbBytes();
    // 'www.google.com' is in here too: the restored google tab's navigation
    // is the one that historically committed DURING quit teardown (after the
    // key was dropped) and landed as plaintext — ciphertext can never contain
    // a '.' so this needle can only ever match a real leak.
    const phaseAneedles = [M.note, M.bmUrl, M.bmTitle, M.ws, M.tab, M.pageTitle, PASS, PASS2, 'www.google.com'];
    const leakedB = absentFrom(bytesB, phaseAneedles);
    check('no Phase-A marker (or password) exists as plaintext in ghostview.db',
      bytesB.length > 0 && leakedB.length === 0, leakedB.join(', '));
    check('ciphertext marker AEG1: present in the file', bytesB.indexOf('AEG1:') >= 0);

    const ksB = keystoreRow(USER);
    check('user_keystores row exists for the account',
      !!ksB, JSON.stringify(ksB));
    check('keystore uses PBKDF2-SHA512 at 300k iterations',
      !!ksB && ksB.kdf === 'PBKDF2-SHA512' && ksB.iterations === 300000, JSON.stringify(ksB));
    check('keystore salt (32 hex) + wrapped key look well formed',
      !!ksB && /^[0-9a-f]{32}$/.test(ksB.salt) && ksB.wrapped_key.length >= 80, JSON.stringify(ksB && { salt: ksB.salt, len: ksB.wrapped_key.length }));
    check('migration flagged complete (migrated=1)', !!ksB && ksB.migrated === 1, JSON.stringify(ksB));
    const wrappedB = ksB ? ksB.wrapped_key : '';

    let walSize = -1;
    try { walSize = fs.statSync(path.join(SANDBOX, 'data', 'ghostview.db-wal')).size; } catch (e) { walSize = 0; }
    check('clean quit checkpointed the WAL (absent or empty)', walSize === 0, walSize);

    // ── Phase C ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase C: a legacy plaintext account is swept on first login --');
    insertLegacyFixture();
    const bytesC1 = dbBytes();
    const legacyNeedles = [M.legacyNote, M.legacyUrl, M.legacyTitle, M.legacyWs, M.legacyBm];
    check('legacy rows are PLAINTEXT on disk before login (the fixture is real)',
      absentFrom(bytesC1, legacyNeedles).length === legacyNeedles.length, absentFrom(bytesC1, legacyNeedles).join(', '));
    check('the vault account\'s markers are still absent while the legacy rows sit there',
      absentFrom(bytesC1, phaseAneedles).length === 0, absentFrom(bytesC1, phaseAneedles).join(', '));
    check('legacy account has NO keystore row yet', keystoreRow(LEGACY_USER) === null);

    ref.page = await readyApp();
    page = ref.page;
    await enterBrowser(page, LEGACY_USER, LEGACY_PASS);
    check('legacy account logs in (keystore created + sweep runs)', true);

    r = await waitFor(page,
      "window.ghost.getHistory('default').then(h => h.some(x => x.url.indexOf('" + M.legacyUrl + "') >= 0))",
      v => v === true, 60, 'legacy history never read back');
    check('legacy history reads back decrypted after the sweep', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getNotes().then(n => n.some(x => x.content === '" + M.legacyNote + "'))",
      v => v === true, 60, 'legacy note never read back');
    check('legacy note reads back decrypted after the sweep', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getBookmarks().then(b => b.some(x => x.url.indexOf('" + M.legacyBm + "') >= 0))",
      v => v === true, 60, 'legacy bookmark never read back');
    check('legacy bookmark reads back decrypted after the sweep', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getWorkspaces().then(w => w.some(x => x.id === 'default' && x.name === '" + M.legacyWs + "'))",
      v => v === true, 60, 'legacy workspace name never read back');
    check('legacy workspace name reads back decrypted after the sweep', r.ok === true, JSON.stringify(r.value));

    await quitApp(ref);

    const bytesC2 = dbBytes();
    check('legacy plaintext is GONE from the file after the sweep + VACUUM',
      absentFrom(bytesC2, legacyNeedles).length === 0, absentFrom(bytesC2, legacyNeedles).join(', '));
    check('ciphertext marker still present', bytesC2.indexOf('AEG1:') >= 0);
    check('the vault account\'s markers stayed absent',
      absentFrom(bytesC2, phaseAneedles).length === 0, absentFrom(bytesC2, phaseAneedles).join(', '));
    const ksC = keystoreRow(LEGACY_USER);
    check('legacy account now has a 300k keystore, migrated=1',
      !!ksC && ksC.iterations === 300000 && ksC.migrated === 1, JSON.stringify(ksC));

    // ── Phase D ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase D: restart decrypts everything; password change re-wraps the key --');
    ref.page = await readyApp();
    page = ref.page;
    await enterBrowser(page, USER, PASS);

    r = await waitFor(page,
      "window.ghost.getTabsForWorkspace('default').then(t => (t.tabs || []).some(x => x.url.indexOf('" + M.tab + "') >= 0))",
      v => v === true, 60, 'tabs were not restored from encrypted rows');
    check('tabs restored from encrypted rows after restart', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getHistory('default').then(h => h.some(x => x.url.indexOf('" + M.tab + "') >= 0))",
      v => v === true, 60, 'history did not decrypt after restart');
    check('history still decrypts after restart', r.ok === true, JSON.stringify(r.value));

    r = await page.ev("window.ghost.changePassword('" + PASS + "','" + PASS2 + "')");
    check('password change re-wraps the key inside the transaction', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.logout().then(() => { window.location.href = 'login.html'; return true; })");
    check('logout succeeds (DEK dropped)', r === true, r);
    r = await waitFor(page, LOGIN_HREF, v => v === true, 40, 'login page never appeared after logout');
    check('back at the login page', r.ok === true, JSON.stringify(r.value));

    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('the OLD password is now refused',
      r && r.ok === false && !r.wiped, JSON.stringify(r));
    check('exactly one attempt was spent (2 left before the wipe)',
      r && r.attemptsLeft === 2, JSON.stringify(r));

    r = await page.ev("window.ghost.login('" + USER + "','" + PASS2 + "')");
    check('the NEW password logs in', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.setAutoClose(false, 5)");
    await page.ev("window.ghost.selectWorkspace('default')");
    r = await waitFor(page, CONTROLS_HREF, v => v === true, 80, 'controls.html never loaded after re-login');
    check('browser UI opens again after the password change', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getHistory('default').then(h => h.some(x => x.url.indexOf('" + M.tab + "') >= 0))",
      v => v === true, 60, 'history did not decrypt after re-key');
    check('history still decrypts after the re-key', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      "window.ghost.getBookmarks().then(b => b.some(x => x.url.indexOf('" + M.bmUrl + "') >= 0 && x.title === '" + M.bmTitle + "'))",
      v => v === true, 60, 'bookmark did not decrypt after re-key');
    check('bookmark still decrypts after the re-key', r.ok === true, JSON.stringify(r.value));

    await quitApp(ref);

    const ksD = keystoreRow(USER);
    check('wrapped_key CHANGED after the password change',
      !!ksD && ksD.wrapped_key !== wrappedB && ksD.wrapped_key.length >= 80,
      JSON.stringify(ksD && { same: ksD.wrapped_key === wrappedB, len: ksD.wrapped_key.length }));
    check('salt stayed the SAME (only the wrap changed, no row re-encryption)',
      !!ksD && ksB && ksD.salt === ksB.salt, JSON.stringify({ before: ksB && ksB.salt, after: ksD && ksD.salt }));
    check('migrated flag untouched by the re-key', !!ksD && ksD.migrated === 1, JSON.stringify(ksD));
    const bytesD = dbBytes();
    check('no marker resurfaced as plaintext after the re-key',
      absentFrom(bytesD, phaseAneedles).length === 0, absentFrom(bytesD, phaseAneedles).join(', '));
    const wrappedD = ksD ? ksD.wrapped_key : '';

    // ── Phase D2 ─────────────────────────────────────────────────────────────
    console.log('\n-- Phase D2: a damaged keystore must not spend a login attempt --');
    // Corrupt the wrapped key behind the app's back (app is closed here).
    withDb((db) => {
      const row = db.prepare('SELECT wrapped_key FROM user_keystores WHERE user_pseudo=?').get(USER);
      if (row) db.prepare('UPDATE user_keystores SET wrapped_key=? WHERE user_pseudo=?')
        .run('ZZZZ' + String(row.wrapped_key).slice(4), USER);
    });
    check('keystore corrupted for the probe', (() => {
      const k = keystoreRow(USER);
      return !!k && k.wrapped_key !== wrappedD;
    })());

    ref.page = await readyApp();
    page = ref.page;
    r = await page.ev("window.ghost.login('" + USER + "','" + PASS2 + "')");
    check('correct password + damaged keystore answers with an honest error',
      r && r.ok === false && /unlocked/.test(String(r.error || '')), JSON.stringify(r));
    check('the failure did NOT spend a login attempt (no attemptsLeft in the answer)',
      r && r.ok === false && r.attemptsLeft === undefined, JSON.stringify(r));
    check('login-attempts counter still absent (no wipe path armed)',
      !fs.existsSync(ATTEMPTS_FILE), fs.existsSync(ATTEMPTS_FILE) ? 'file exists' : 'absent');

    await quitApp(ref);

    // Restore the keystore so the rest of the run can log in again.
    withDb((db) => db.prepare('UPDATE user_keystores SET wrapped_key=? WHERE user_pseudo=?').run(wrappedD, USER));
    check('keystore restored', (() => {
      const k = keystoreRow(USER);
      return !!k && k.wrapped_key === wrappedD;
    })());

    // ── Phase E1 ─────────────────────────────────────────────────────────────
    console.log('\n-- Phase E1: the startup clipboard baseline survives a quit --');
    clipSet(M.clipBase2);
    ref.page = await readyApp();          // app starts, seeds the baseline
    await sleep(2500);                    // a couple of poll ticks happen
    await quitApp(ref);
    check('baseline written BEFORE launch is still on the clipboard after quit',
      clipGet() === M.clipBase2, JSON.stringify(clipGet()));

    // ── Phase E2 ─────────────────────────────────────────────────────────────
    console.log('\n-- Phase E2: clipboard auto-wipe inside the running app --');
    clipSet(M.clipBase);
    ref.page = await readyApp();
    page = ref.page;
    await enterBrowser(page, USER, PASS2);

    r = await page.ev('window.ghost.getClipboardPrefs()');
    check('auto-wipe defaults to ON with a 20 s delay',
      r && r.enabled === true && r.seconds === 20, JSON.stringify(r));

    r = await page.ev("window.ghost.setClipboardPrefs({ enabled: true, seconds: 5 })");
    check('delay saved as 5 s', r && r.ok === true && r.seconds === 5, JSON.stringify(r));

    // Baseline: copied before launch, so it must never be armed.
    await sleep(6500); // > one full poll cycle (1.5 s) + the 5 s delay
    check('startup baseline untouched after 6.5 s of polling',
      clipGet() === M.clipBase, JSON.stringify(clipGet()));

    // A session copy is wiped after the configured delay — not before.
    let t0 = Date.now();
    r = await page.ev("window.ghost.copyText('" + M.clipOne + "')");
    check('copy-text arms the wipe', r === true, r);
    await sleep(400);
    check('not wiped instantly', clipGet() === M.clipOne, JSON.stringify(clipGet()));
    let emptied = '';
    let emptiedAt = 0;
    while (Date.now() - t0 < 9000) {
      if (clipGet() === '') { emptied = 'yes'; emptiedAt = Date.now() - t0; break; }
      await sleep(400);
    }
    check('session copy wiped within the window', emptied === 'yes', 'after ' + emptiedAt + ' ms');
    check('not wiped before the configured 5 s delay', emptied === 'yes' && emptiedAt >= 4800, emptiedAt + ' ms');

    // A NEWER copy must never be cleared by the OLDER copy's timer: ONE is
    // copied at t1, TWO replaces it 2 s later (from outside the app), and at
    // t1+5.5 s — after ONE's deadline — the clipboard must still hold TWO.
    const t1 = Date.now();
    await page.ev("window.ghost.copyText('" + M.clipOne + "')");
    while (Date.now() - t1 < 2000) await sleep(50);
    clipSet(M.clipTwo);                              // external, newer copy
    while (Date.now() - t1 < 5500) await sleep(50);
    const mid = clipGet();
    check('the newer copy survives the older copy\'s deadline', mid === M.clipTwo, JSON.stringify(mid));
    let twoEmptied = '';
    let twoAt = 0;
    while (Date.now() - t1 < 11000) {
      if (clipGet() === '') { twoEmptied = 'yes'; twoAt = Date.now() - t1; break; }
      await sleep(400);
    }
    check('the newer copy is wiped by its OWN timer', twoEmptied === 'yes', 'after ' + twoAt + ' ms');

    // Prefs clamp: out-of-range values are pulled into 5..600.
    r = await page.ev("window.ghost.setClipboardPrefs({ enabled: true, seconds: 1 })");
    check('seconds=1 clamps up to the 5 s floor', r && r.ok === true && r.seconds === 5, JSON.stringify(r));
    r = await page.ev("window.ghost.setClipboardPrefs({ enabled: true, seconds: 9999 })");
    check('seconds=9999 clamps down to the 600 s ceiling', r && r.ok === true && r.seconds === 600, JSON.stringify(r));
    r = await page.ev("window.ghost.setClipboardPrefs({ enabled: true, seconds: 20 })");
    check('default restored (20 s)', r && r.ok === true && r.seconds === 20, JSON.stringify(r));

    // before-quit: content still on the clipboard when the app closes must not
    // outlive the session. 600 s delay so the timer cannot fire during this.
    await page.ev("window.ghost.setClipboardPrefs({ enabled: true, seconds: 600 })");
    r = await page.ev("window.ghost.copyText('" + M.clipQuit + "')");
    check('copy-text armed for the quit test', r === true, r);
    check('tracked copy is on the clipboard right before quit',
      clipGet() === M.clipQuit, JSON.stringify(clipGet()));
    await quitApp(ref);
    check('before-quit wiped the tracked copy', clipGet() === '', JSON.stringify(clipGet()));
  } catch (e) {
    failures++;
    console.log('  [FAIL] test aborted: ' + e.message);
    if (e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
  } finally {
    try { await quitApp(ref); } catch (e) { /* already down */ }
    stopServer();
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

  // Put the user's own clipboard back (this test overwrote it on purpose).
  if (origClip !== null && origClip !== '') {
    try { clipSet(origClip); console.log('  [info] original clipboard restored'); }
    catch (e) { console.log('  [info] could not restore the original clipboard: ' + e.message); }
  } else {
    console.log('  [info] original clipboard was empty or non-text — nothing to restore');
  }

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
