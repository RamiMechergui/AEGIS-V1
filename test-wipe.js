// test-wipe.js — isolated E2E test for the "3 wrong passwords wipe all data" feature.
//
// SAFETY FIRST: this test NEVER touches the project's real data\ folder.
// It copies the app into a temp sandbox, writes a portable.dat marker there so
// all user data lands inside the sandbox, and afterwards asserts that the
// project data\ folder is byte-for-byte unchanged.
//
// Run:  node test-wipe.js
//
// Flow:
//   Phase A  register an account, fail 2 logins  -> counter must be 2 on disk
//   (restart the app)                             -> proves an app restart cannot reset the counter
//   Phase B  fail the 3rd login                   -> wipe fires, every profile file gone,
//                                                    markers queued, message on screen
//   Phase B2 leftovers flushed back by Chromium   -> the next launch finishes the wipe
//   Phase C  register + log in with a new account -> app still fully usable

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const SRC = __dirname;
const SANDBOX = path.join(process.env.TEMP || process.env.TMP, 'opencode', 'aegis-wipe-test');
const ELECTRON = path.join(SRC, 'node_modules', 'electron', 'dist', 'electron.exe');

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
let nextPort = 9339;
let activePort = null;
const PORT_FILTER = 'remote-debugging-port=';

// A run that is killed mid-flight leaves its Electron alive with the sandbox as
// its cwd, which blocks the sandbox from being deleted next time. Clear those.
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

  // Seed data that the wipe must remove
  const dataDir = path.join(SANDBOX, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'ghostview-data.json'), '{"legacy":true}');
  fs.writeFileSync(path.join(dataDir, 'ghostview-data.json.bak'), '{"legacy":true}');
  fs.writeFileSync(path.join(dataDir, 'net-prefs.json'), '{"secureDns":true}');
  seedProfileFiles();
}

// A realistic Electron 35 / Chromium profile. These are exactly the items a
// hand-maintained wipe allowlist used to miss: site permission grants (the
// Preferences file), Local State, the DIPS bounce-tracking record (a list of
// sites the user visited), ad InterestGroups, SharedStorage and the per-
// workspace cookie jars.
const SEEDS = {
  'Preferences': 'SEEDPREFS-GRANTS',
  'Local State': 'SEEDLOCALSTATE',
  'DIPS': 'SEEDDIPS-RECORD',
  'DIPS-wal': 'SEEDDIPSWAL',
  'InterestGroups': 'SEEDINTERESTGROUPS',
  'SharedStorage': 'SEEDSHAREDSTORAGE',
  'PrivateAggregation': 'SEEDAGGREGATION',
  'Network/Cookies': 'SEEDNETWORKCOOKIES',
  'Local Storage/leveldb/000003.log': 'SEEDLOCALSTORAGE',
  'Partitions/user_rami_ws_default/Cookies': 'SEEDWORKSPACECOOKIES',
};
function seedProfileFiles() {
  for (const [rel, content] of Object.entries(SEEDS)) {
    const p = path.join(SANDBOX, 'data', 'session', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}
function seedFile(rel, content) {
  const p = path.join(SANDBOX, 'data', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ── App lifecycle ────────────────────────────────────────────────────────────
let child = null;
let stderrBuf = '';
let stdoutBuf = '';
function launch() {
  // Buffers are NOT reset per launch: the log of the run that performed the
  // wipe is the one worth printing if something fails three phases later.
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
    // and left the next launch racing SQLite/lock handles — which surfaced as
    // "Lock file can not be created" and SqliteError: disk I/O error.
    if (page) { try { await Promise.race([page.ev("window.ghost.confirmQuitAction('quit')"), sleep(3000)]); } catch (e) { /* app already closing */ } }
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
    if (child.exitCode === null) {   // fallback: it refused to quit
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
      for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
    }
  }
  child = null;
  // The singleton lock AND the devtools port are owned by the main process, so
  // waiting for its port to actually close means it is really gone.
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
      target = list.find((t) => t.type === 'page' && /login\.html/.test(t.url));
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
      // A navigation or reload can destroy the JS context mid-call — retry those.
      for (let attempt = 1; attempt <= 12; attempt++) {
        try { return await once(); }
        catch (e) {
          if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(e.message)) throw e;
          if (attempt === 12) throw e;
          // Re-running the expression is only safe for idempotent reads. A
          // destructive call (the wipe) must not fire twice, so say so loudly.
          console.log('  [retry ' + attempt + '] context lost during: ' + expression.slice(0, 80) + '  (' + e.message + ')');
          await sleep(250);
        }
      }
    },
    close: () => { try { ws.close(); } catch (e) {} },
  };
}

// Chromium occasionally still holds the singleton lock for a few hundred ms
// after the old port closes — retry the launch when it says so.
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

// The page must have a live JS context with the preload bridge before tests run.
async function readyApp() {
  const page = await startApp();
  for (let i = 0; i < 40; i++) {
    try { if (await page.ev('!!window.ghost') === true) return page; } catch (e) { /* not ready */ }
    await sleep(250);
  }
  return page;
}

// ── Assertions on the sandbox disk ───────────────────────────────────────────
const D = () => path.join(SANDBOX, 'data');
const dbFile = () => path.join(D(), 'ghostview.db');
const attemptsFile = () => path.join(D(), 'login-attempts.json');
const pendingFile = () => path.join(D(), 'pending-wipe.json');
const noticeFile = () => path.join(D(), 'wipe-notice.json');
// Reads the main DB file AND its WAL sidecar: in WAL mode recent rows may still
// live in ghostview.db-wal until a checkpoint, so a byte search must cover both.
const dbHas = (needle) => {
  for (const f of [dbFile(), dbFile() + '-wal']) {
    try { if (fs.readFileSync(f).includes(needle)) return true; } catch (e) {}
  }
  return false;
};
// Byte search across the whole sandbox data folder — DB, WAL, JSON stores and
// the Chromium profile alike — returning every file that still holds `needle`.
function dataHas(needle) {
  const hits = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { if (fs.statSync(p).size > 8 * 1024 * 1024) continue; } catch (err) { continue; }
      try { if (fs.readFileSync(p).includes(needle)) hits.push(path.relative(D(), p)); } catch (err) {}
    }
  };
  walk(D());
  return hits;
}
// Profiles still holding any of the seeded secrets.
function leftoverSeeds() {
  const left = [];
  for (const [rel, content] of Object.entries(SEEDS)) if (dataHas(content).length) left.push(rel);
  return left;
}

// Diagnostic snapshot of the sandbox's persistent state.
function dumpState(label) {
  const parts = [];
  let counter = 'absent';
  try { counter = fs.readFileSync(attemptsFile(), 'utf8'); } catch (e) {}
  parts.push('counter=' + counter.replace(/\s+/g, ''));
  parts.push('tester-in-db=' + dbHas('tester'));
  for (const f of ['ghostview-data.json', 'ghostview-data.json.bak', 'net-prefs.json']) {
    parts.push(f + '=' + fs.existsSync(path.join(D(), f)));
  }
  parts.push('Partitions=' + fs.existsSync(path.join(D(), 'session', 'Partitions')));
  parts.push('pendingWipe=' + fs.existsSync(pendingFile()));
  parts.push('wipeNotice=' + fs.existsSync(noticeFile()));
  console.log('  [state @ ' + label + '] ' + parts.join('  '));
}

// ── Test ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('== AEGIS wipe feature E2E test ==');
  console.log('  sandbox: ' + SANDBOX);

  cleanupLeftovers();
  await sleep(1500);

  const realBefore = snapshotRealData();
  console.log('  project data\\ snapshot: ' + Object.keys(realBefore).length + ' file(s)');

  setupSandbox();
  console.log('  sandbox prepared (portable mode)\n');

  let page = null;
  let appLog = ['', ''];
  try {
    // ── Phase A ──────────────────────────────────────────────────────────────
    console.log('-- Phase A: register + 2 failed logins --');
    page = await readyApp();

    let r = await page.ev('!!window.ghost');
    check('login page exposes the ghost bridge', r === true, r);

    r = await page.ev('window.ghost.wipeNotice()');
    check('no wipe notice on a clean profile', r && r.wiped === false, JSON.stringify(r));

    r = await page.ev("window.ghost.register('tester','correct-horse')");
    check('register creates the account', r && r.ok === true, JSON.stringify(r));
    check('account present in the sandbox DB', dbHas('tester'));

    r = await page.ev("window.ghost.login('tester','wrong-1')");
    check('wrong password #1 -> 2 attempts left', r && r.ok === false && r.attemptsLeft === 2, JSON.stringify(r));
    check('no message shown yet about wiping', !(r && r.wiped), JSON.stringify(r));

    r = await page.ev("window.ghost.login('tester','wrong-2')");
    check('wrong password #2 -> 1 attempt left', r && r.ok === false && r.attemptsLeft === 1, JSON.stringify(r));

    let counter = null;
    try { counter = JSON.parse(fs.readFileSync(attemptsFile(), 'utf8')); } catch (e) {}
    check('failed-attempt counter persisted to disk', counter && counter.count === 2, JSON.stringify(counter));
    dumpState('after phase A, app still running');

    await killApp(page);
    dumpState('after phase A killed');
    console.log('  (app restarted to prove the counter survives)\n');

    // ── Phase B ──────────────────────────────────────────────────────────────
    console.log('-- Phase B: 3rd wrong password triggers the wipe --');
    page = await readyApp();
    dumpState('phase B started, before login');

    // The 3rd failure goes through the real user path — the Sign In button —
    // so this proves the whole chain: main answers wiped:true and login.html
    // renders it (that message branch only exists for wiped responses).
    let msg = await page.ev(`(async () => {
      // readyApp only waits for the preload bridge, which exists before the
      // body is parsed — wait for the form itself before filling it in.
      for (let i = 0; i < 80 && !document.getElementById('login-pseudo'); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      document.getElementById('login-pseudo').value = 'tester';
      document.getElementById('login-pass').value = 'wrong-3';
      document.getElementById('login-btn').click();
      for (let i = 0; i < 80; i++) {
        const t = (document.getElementById('login-error') || {}).textContent || '';
        if (/deleted/i.test(t)) return t;
        await new Promise(r => setTimeout(r, 250));
      }
      return (document.getElementById('login-error') || {}).textContent || '';
    })()`);
    check('3rd wrong password -> wipe message rendered on the login screen',
      /deleted/i.test(msg || ''), JSON.stringify(msg));
    dumpState('after the 3rd failed login');

    r = await page.ev('window.ghost.wipeNotice()');
    check('wipe-notice IPC reports the wipe', r && r.wiped === true, JSON.stringify(r));

    check('accounts DB still exists (recreated)', fs.existsSync(dbFile()));
    check('account data erased from DB', !dbHas('tester'));
    check('attempt counter file removed', !fs.existsSync(attemptsFile()));
    check('legacy JSON store removed', !fs.existsSync(path.join(D(), 'ghostview-data.json')));
    check('legacy JSON backup removed', !fs.existsSync(path.join(D(), 'ghostview-data.json.bak')));
    check('network prefs removed', !fs.existsSync(path.join(D(), 'net-prefs.json')));
    check('workspace partitions (cookies/localStorage) removed',
      !fs.existsSync(path.join(D(), 'session', 'Partitions')));
    check('seeded partition payload is gone',
      !fs.existsSync(path.join(D(), 'session', 'Partitions', 'user_rami_ws_default', 'Cookies')));

    // The whole Chromium profile must go, not only the names an allowlist
    // happened to contain: Preferences (site grants), Local State, DIPS (a log
    // of visited sites), InterestGroups, SharedStorage, workspace cookies…
    // Chromium keeps a couple of browser-owned DBs (SharedStorage) open for the
    // whole session and refuses to unlink them — those are covered by the
    // pending-wipe marker and asserted again after the restart in Phase B2.
    const heldLive = leftoverSeeds();
    check('profile seeds erased live, or queued behind Chromium locks for the next launch',
      heldLive.length === 0 || fs.existsSync(pendingFile()),
      heldLive.length ? 'still held by Chromium: ' + heldLive.join(', ') : '');
    if (heldLive.length) console.log('  (held until next launch: ' + heldLive.join(', ') + ')');

    check('pending-wipe marker left for the next launch', fs.existsSync(pendingFile()));
    check('wipe notice written for the login screen', fs.existsSync(noticeFile()));

    // The old account must be truly gone: the CORRECT password no longer works.
    r = await page.ev("window.ghost.login('tester','correct-horse')");
    check('old account unusable after wipe (correct password rejected)', r && r.ok === false, JSON.stringify(r));

    // ── Phase B2 ─────────────────────────────────────────────────────────────
    // Chromium flushes Preferences/Local State back to disk when it exits, and
    // may have refused to unlink files it held. Simulate both, then prove the
    // NEXT launch finishes the wipe before any profile file is opened.
    console.log('\n-- Phase B2: leftovers flushed on shutdown are erased at the next launch --');
    await killApp(page);
    dumpState('after the wipe, app killed');
    const FLUSHED = {
      'session/Preferences': 'FLUSHEDPREFS-SECRET',
      'session/Local State': 'FLUSHEDLOCALSTATE-SECRET',
      'session/Partitions/user_rami_ws_default/Cookies': 'FLUSHEDCOOKIES-SECRET',
    };
    for (const rel of Object.keys(FLUSHED)) seedFile(rel, FLUSHED[rel]);
    check('shutdown leftovers planted on disk', dataHas('FLUSHEDPREFS-SECRET').length === 1,
      JSON.stringify(dataHas('FLUSHEDPREFS-SECRET')));
    check('pending-wipe marker still queued', fs.existsSync(pendingFile()));

    page = await readyApp();
    check('next launch consumed the pending-wipe marker', !fs.existsSync(pendingFile()));
    const stillLeft = Object.keys(FLUSHED).filter(rel => dataHas(FLUSHED[rel]).length);
    check('shutdown leftovers erased before Chromium reopened them',
      stillLeft.length === 0, stillLeft.join(', '));
    const heldAfterRestart = leftoverSeeds();
    check('every profile seed gone after the restart, including Chromium-locked files',
      heldAfterRestart.length === 0, heldAfterRestart.join(', '));
    check('wipe notice survives the restart', fs.existsSync(noticeFile()));
    await sleep(600);
    msg = await page.ev("(document.getElementById('login-error')||{}).textContent || ''");
    check('restarted login screen still reports the wipe', /deleted/i.test(msg || ''), msg);

    // Typing dismisses the notice, so the user is not stuck with it forever.
    msg = await page.ev(`(async () => {
      let i = document.getElementById('login-pseudo');
      for (let k = 0; k < 80 && !i; k++) { await new Promise(r => setTimeout(r, 100)); i = document.getElementById('login-pseudo'); }
      i.value = 'tester'; i.dispatchEvent(new Event('input'));
      return document.getElementById('login-error').textContent;
    })()`);
    check('typing dismisses the wipe message', !/deleted/i.test(msg || ''), JSON.stringify(msg));

    // ── Phase C ──────────────────────────────────────────────────────────────
    console.log('\n-- Phase C: app still usable afterwards --');
    r = await page.ev("window.ghost.register('tester','brand-new-pass')");
    check('old username is free again (re-register succeeds)', r && r.ok === true, JSON.stringify(r));

    r = await page.ev("window.ghost.login('tester','brand-new-pass')");
    check('new account can log in', r && r.ok === true, JSON.stringify(r));
    check('successful login resets the counter', !fs.existsSync(attemptsFile()));
    check('successful registration/login acknowledges the wipe notice', !fs.existsSync(noticeFile()));
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
