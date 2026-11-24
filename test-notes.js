// test-notes.js — isolated E2E test for workspace-isolated, password-gated Notes.
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder.
// It copies the app into a temp sandbox, writes a portable.dat marker there so
// all user data lands inside the sandbox, and afterwards asserts that the
// project data\ folder is byte-for-byte unchanged.
//
// Run:  node test-notes.js
//
// Flow:
//   Phase A  seed a LEGACY notes table (no workspace_id) via an Electron helper,
//            register + login  -> migration must backfill workspace_id='default'
//   Phase B  notes per workspace (backend)  -> default / other / no-arg scoping
//   Phase C  verifyPassword wrong + right
//   Phase D  the real controls.html UI      -> password gate, unlock, cancel,
//            switching workspace refreshes the visible list
//   Phase E  deleteWorkspace                -> only that workspace's notes go
//
// The legacy seed matters: better-sqlite3 is built for Electron's ABI and cannot
// be loaded by plain Node, so the pre-existing database is created by running a
// helper inside Electron itself — exactly the binary the app will use.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP, 'opencode', 'aegis-notes-test');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

const USER = 'tester';
const PASS = 'note-secret';
const LEGACY_TEXT = 'LEGACY-NOTE-SEED';
const DEFAULT_NOTE = 'DEFAULT-WS-NOTE';
const OTHER_NOTE = 'OTHER-WS-NOTE';

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
let nextPort = 9461;
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

// ── Legacy database seed ─────────────────────────────────────────────────────
// Builds a ghostview.db exactly the way the OLD build did: a notes table with
// NO workspace_id column, holding one note for USER. When the current main.js
// opens it, the migration has to add the column and backfill 'default'.
function seedLegacyDb() {
  const helper = path.join(SANDBOX, 'seed-legacy-notes.js');
  fs.writeFileSync(helper, [
    "const { app } = require('electron');",
    "const path = require('path');",
    "const fs = require('fs');",
    "const Database = require('better-sqlite3');",
    "const dbPath = path.join(__dirname, 'data', 'ghostview.db');",
    "fs.mkdirSync(path.dirname(dbPath), { recursive: true });",
    "const db = new Database(dbPath);",
    "db.pragma('journal_mode = WAL');",
    "db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_pseudo TEXT NOT NULL, content TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)');",
    "db.prepare('INSERT INTO notes (user_pseudo,content,created,updated) VALUES (?,?,?,?)').run('" + USER + "', '" + LEGACY_TEXT + "', Date.now(), Date.now());",
    "db.close();",
    "console.log('legacy notes seeded');",
    "app.quit();",
  ].join('\n'));

  const out = execFileSync(ELECTRON, [helper], { cwd: SANDBOX, encoding: 'utf8', timeout: 60000 });
  if (!/legacy notes seeded/.test(out || '')) throw new Error('legacy seed helper failed: ' + out);
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
  child.on('error', (e) => { stderrBuf += 'SPAWN ERROR: ' + e.message; });
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
async function connect() {
  let target = null;
  for (let i = 0; i < 60; i++) {
    if (child && child.exitCode !== null) {
      throw new Error('app exited early (code ' + child.exitCode + ')\nstderr:\n' + stderrBuf + '\nstdout:\n' + stdoutBuf);
    }
    try {
      const list = await (await fetch('http://127.0.0.1:' + activePort + '/json/list')).json();
      target = list.find((t) => t.type === 'page' && /login[.]html/.test(t.url));
      if (target) break;
    } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  if (!target) throw new Error('login.html CDP target not found\nstderr:\n' + stderrBuf + '\nstdout:\n' + stdoutBuf);

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
    try { return await connect(); }
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

// ── Assertions on the sandbox disk ───────────────────────────────────────────
const D = () => path.join(SANDBOX, 'data');
const dbFile = () => path.join(D(), 'ghostview.db');
// Reads the main DB file AND its WAL sidecar: in WAL mode recent rows may still
// live in ghostview.db-wal until a checkpoint, so a byte search must cover both.
const dbHas = (needle) => {
  for (const f of [dbFile(), dbFile() + '-wal']) {
    try { if (fs.readFileSync(f).includes(needle)) return true; } catch (e) {}
  }
  return false;
};

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS notes (workspace isolation + password gate) E2E test ==');
  console.log('  sandbox: ' + SANDBOX);

  cleanupLeftovers();
  await sleep(1500);

  const realBefore = snapshotRealData();
  console.log('  project data\\ snapshot: ' + Object.keys(realBefore).length + ' file(s)');

  setupSandbox();
  seedLegacyDb();
  console.log('  sandbox prepared (portable mode, legacy notes schema seeded)\n');

  let page = null;
  let appLog = ['', ''];
  let otherWsId = null;
  try {
    // ── Phase A ──────────────────────────────────────────────────────────────
    console.log('-- Phase A: migration of legacy (workspace-less) notes --');
    page = await readyApp();

    let r = await page.ev('!!window.ghost');
    check('login page exposes the ghost bridge', r === true, r);

    r = await page.ev("window.ghost.register('" + USER + "','" + PASS + "')");
    check('register creates the account', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.login('" + USER + "','" + PASS + "')");
    check('login succeeds', r && r.ok === true, JSON.stringify(r));

    // Idle auto-close would log the test out mid-run if it ever got slow.
    r = await page.ev('window.ghost.setAutoClose(false, 5)');
    check('idle auto-close disabled for the test run', r && r.ok !== false, JSON.stringify(r));

    // currentWorkspace (the fallback every no-wsId call resolves to) is only
    // established when the browser UI opens — so get there first, exactly like
    // the real flow: login -> pick workspace -> controls.html.
    r = await page.ev("window.ghost.selectWorkspace('default')");
    check('selectWorkspace opens the browser UI', r && r.ok === true, JSON.stringify(r));

    r = await waitFor(page,
      `(() => { try { return /controls[.]html/.test(location.href) && !!window.ghost; } catch(e) { return false; } })()`,
      v => v === true, 80, 'controls.html never loaded');
    check('controls.html is the live page', r.ok === true, JSON.stringify(r.value));

    r = await page.ev('window.ghost.getNotes()');
    const legacyList = Array.isArray(r) ? r : null;
    check('legacy note survives the migration', !!legacyList && legacyList.length === 1 && legacyList[0].content === LEGACY_TEXT, JSON.stringify(r));
    check('legacy note backfilled to the default workspace', dbHas('workspace_id'), 'workspace_id column not found in DB bytes');

    r = await page.ev("window.ghost.getNotes('default')");
    check("legacy note is visible under wsId='default'", Array.isArray(r) && r.length === 1, JSON.stringify(r));
    r = await page.ev("window.ghost.getNotes('some-other-ws')");
    check('legacy note is NOT visible under another wsId', Array.isArray(r) && r.length === 0, JSON.stringify(r));

    // ── Phase B ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase B: notes are scoped per workspace (backend) --');
    r = await page.ev("window.ghost.addNote('" + DEFAULT_NOTE + "')");
    check('addNote without wsId lands in the active (default) workspace', r && r.ok === true && r.note && r.note.workspaceId === 'default', JSON.stringify(r));

    r = await page.ev("window.ghost.getNotes('default')");
    check("default workspace shows its 2 notes (legacy + new)",
      Array.isArray(r) && r.length === 2 && r.some(n => n.content === DEFAULT_NOTE) && r.some(n => n.content === LEGACY_TEXT), JSON.stringify(r));

    r = await page.ev("window.ghost.createWorkspace('Isolated')");
    check('second workspace created', r && r.ok === true && !!r.id, JSON.stringify(r));
    otherWsId = r && r.ok ? r.id : null;

    r = await page.ev("window.ghost.addNote('" + OTHER_NOTE + "', '" + otherWsId + "')");
    check('addNote with an explicit wsId stores it there', r && r.ok === true && r.note && r.note.workspaceId === otherWsId, JSON.stringify(r));

    r = await page.ev("window.ghost.getNotes('default')");
    check('default workspace does NOT contain the other workspace\'s note',
      Array.isArray(r) && r.length === 2 && !r.some(n => n.content === OTHER_NOTE), JSON.stringify(r));

    r = await page.ev("window.ghost.getNotes('" + otherWsId + "')");
    check('other workspace contains ONLY its own note',
      Array.isArray(r) && r.length === 1 && r[0].content === OTHER_NOTE, JSON.stringify(r));

    r = await page.ev('window.ghost.getNotes()');
    check('getNotes() with no wsId follows the active workspace (default)',
      Array.isArray(r) && r.length === 2 && !r.some(n => n.content === OTHER_NOTE), JSON.stringify(r));

    r = await page.ev("window.ghost.switchWorkspace('" + otherWsId + "')");
    check('switchWorkspace to the other workspace succeeds', r && r.ok === true, JSON.stringify(r));
    r = await page.ev('window.ghost.getNotes()');
    check('after switching, getNotes() with no wsId follows the new workspace',
      Array.isArray(r) && r.length === 1 && r[0].content === OTHER_NOTE, JSON.stringify(r));
    r = await page.ev("window.ghost.getNotes('default')");
    check("default workspace's notes are still intact and separate",
      Array.isArray(r) && r.length === 2 && !r.some(n => n.content === OTHER_NOTE), JSON.stringify(r));

    r = await page.ev("window.ghost.switchWorkspace('default')");
    check('switch back to default succeeds', r && r.ok === true, JSON.stringify(r));

    // ── Phase C ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase C: the password the gate relies on --');
    r = await page.ev("window.ghost.verifyPassword('definitely-wrong')");
    check('verifyPassword rejects a wrong password', r === false, JSON.stringify(r));
    r = await page.ev("window.ghost.verifyPassword('" + PASS + "')");
    check('verifyPassword accepts the right password', r === true, JSON.stringify(r));

    // ── Phase D ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase D: real controls.html UI (gate, unlock, cancel, switch) --');
    // Opening Notes must show the password gate with nothing else visible.
    r = await page.ev(`(() => {
      document.getElementById('notes-btn').click();
      const gateOpen = document.getElementById('notes-gate').classList.contains('open');
      const composerHidden = document.querySelector('#notes-panel .notes-composer').style.display === 'none';
      const lockedText = document.getElementById('notes-list').textContent || '';
      return { gateOpen, composerHidden, hasLockedText: /Password required/i.test(lockedText), hasNoteContent: lockedText.indexOf('${DEFAULT_NOTE}') >= 0 };
    })()`);
    check('opening Notes shows the password gate first', r && r.gateOpen === true, JSON.stringify(r));
    check('composer is hidden while locked', r && r.composerHidden === true, JSON.stringify(r));
    check('locked placeholder shown, no note content leaked', r && r.hasLockedText === true && r.hasNoteContent === false, JSON.stringify(r));

    r = await page.ev(`(() => {
      document.getElementById('ngp').value = 'definitely-wrong';
      document.getElementById('ngok').click();
      return true;
    })()`);
    r = await waitFor(page,
      `(() => { const m = document.getElementById('ngm'); return m ? m.textContent : ''; })()`,
      v => /Incorrect password/.test(String(v)), 32, 'no error message');
    check('wrong password in the gate is rejected with a message', r.ok === true, JSON.stringify(r.value));
    r = await page.ev(`(() => ({
      gateOpen: document.getElementById('notes-gate').classList.contains('open'),
      composerHidden: document.querySelector('#notes-panel .notes-composer').style.display === 'none'
    }))()`);
    check('gate stays closed to the content after a wrong password', r && r.gateOpen === true && r.composerHidden === true, JSON.stringify(r));

    r = await page.ev(`(() => {
      document.getElementById('ngp').value = '${PASS}';
      document.getElementById('ngok').click();
      return true;
    })()`);
    r = await waitFor(page,
      `(() => { try { return !document.getElementById('notes-gate').classList.contains('open'); } catch(e) { return false; } })()`,
      v => v === true, 32, 'gate never opened for the right password');
    check('right password unlocks the notes panel', r.ok === true, JSON.stringify(r.value));

    r = await waitFor(page,
      `(() => { const t = document.getElementById('notes-list').textContent || ''; return t.indexOf('${DEFAULT_NOTE}') >= 0 && t.indexOf('${LEGACY_TEXT}') >= 0; })()`,
      v => v === true, 32, 'notes never rendered');
    check('unlocked list shows the default workspace\'s notes', r.ok === true, JSON.stringify(r.value));

    r = await page.ev(`(() => {
      const composerHidden = document.querySelector('#notes-panel .notes-composer').style.display === 'none';
      const t = document.getElementById('notes-list').textContent || '';
      const ws = document.getElementById('notes-ws');
      return { composerHidden, hasOther: t.indexOf('${OTHER_NOTE}') >= 0, wsLabel: ws.textContent, wsVisible: ws.style.display !== 'none' };
    })()`);
    check('composer visible after unlocking', r && r.composerHidden === false, JSON.stringify(r));
    check("other workspace's note is not listed", r && r.hasOther === false, JSON.stringify(r));
    check('header shows which workspace is being viewed', r && r.wsVisible === true && /workspace/i.test(r.wsLabel || ''), JSON.stringify(r && r.wsLabel));

    // Switching workspace while the panel is open must re-scope the list.
    r = await page.ev("window.ghost.switchWorkspace('" + otherWsId + "')");
    check('switchWorkspace from inside the browser succeeds', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(page,
      `(() => { const t = document.getElementById('notes-list').textContent || ''; return t.indexOf('${OTHER_NOTE}') >= 0 && t.indexOf('${DEFAULT_NOTE}') < 0; })()`,
      v => v === true, 40, 'list did not re-scope after the workspace switch');
    check('open Notes list follows the workspace switch', r.ok === true, JSON.stringify(r.value));

    r = await page.ev("window.ghost.switchWorkspace('default')");
    check('switch back to default from the browser succeeds', r && r.ok === true, JSON.stringify(r));
    r = await waitFor(page,
      `(() => { const t = document.getElementById('notes-list').textContent || ''; return t.indexOf('${DEFAULT_NOTE}') >= 0 && t.indexOf('${OTHER_NOTE}') < 0; })()`,
      v => v === true, 40, 'list did not follow the switch back');
    check('list follows the switch back to default', r.ok === true, JSON.stringify(r.value));

    // Closing re-locks, and Cancel (unlike History) closes the whole panel.
    r = await page.ev(`(() => {
      document.getElementById('notes-close').click();
      document.getElementById('notes-btn').click();
      return {
        gateOpen: document.getElementById('notes-gate').classList.contains('open'),
        composerHidden: document.querySelector('#notes-panel .notes-composer').style.display === 'none',
        lockedAgain: /Password required/i.test(document.getElementById('notes-list').textContent || '')
      };
    })()`);
    check('reopening Notes re-locks the panel', r && r.gateOpen === true && r.composerHidden === true && r.lockedAgain === true, JSON.stringify(r));

    r = await page.ev(`(() => { document.getElementById('ngc').click(); return true; })()`);
    r = await waitFor(page,
      `(() => { try { return !document.getElementById('notes-panel').classList.contains('open') && !document.getElementById('notes-btn').classList.contains('active'); } catch(e) { return false; } })()`,
      v => v === true, 16, 'panel stayed open after Cancel');
    check('Cancel on the gate closes the notes panel', r.ok === true, JSON.stringify(r.value));

    // ── Phase E ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase E: deleting a workspace takes its notes with it --');
    r = await page.ev("window.ghost.deleteWorkspace('" + otherWsId + "')");
    check('deleteWorkspace succeeds', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.getNotes('" + otherWsId + "')");
    check("deleted workspace's notes are gone", Array.isArray(r) && r.length === 0, JSON.stringify(r));

    r = await page.ev("window.ghost.getNotes('default')");
    check("default workspace's notes survive the deletion",
      Array.isArray(r) && r.length === 2 && r.some(n => n.content === DEFAULT_NOTE) && r.some(n => n.content === LEGACY_TEXT), JSON.stringify(r));
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
