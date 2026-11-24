const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, dialog, shell, clipboard, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { execFile, spawn, spawnSync } = require('child_process');
const ytEngine = require('./yt-tools');
// Aegis Shield — local ad/tracker blocking, tracking-parameter strip and the
// fingerprint-randomizer bootstrap (see shield.js). No Electron deps at load.
const shield = require('./shield');
// OAuth/SSO popup recognition + the plain-Chrome User-Agent rebuild (pure
// module, unit-tested by test-oauth.js). main.js routes window.open() targets
// it recognises through the linked-popup path instead of a detached tab.
const oauth = require('./oauth');
// Sequential playlist download queue ("Download Full Playlist"). Electron-free
// state machine — see playlist-queue.js; the unit suite test-playlist-queue.js
// proves the one-video-at-a-time behaviour with a fake runner.
const { createPlaylistQueue } = require('./playlist-queue');
// Vault — at-rest field encryption (AES-256-GCM + per-user envelope key). Pure
// crypto, no Electron deps: see vault.js; unit suite test-vault.js.
const vault = require('./vault');

// ── Portable Mode ──
// All user data (DB, sessions, cookies) stored next to the app when portable.dat
// is present or PORTABLE=1 env var is set.
(function setupPortable() {
  const marker = 'portable.dat';
  let portable = process.env.PORTABLE === '1';
  if (!portable) {
    // Check next to exe (packaged) or in source root (dev)
    if (app.isPackaged) {
      portable = fs.existsSync(path.resolve(process.resourcesPath, '..', marker));
    } else {
      portable = fs.existsSync(path.join(__dirname, marker));
    }
  }
  if (!portable) {
    // Also auto-detect if a data/ folder already exists next to the app
    const dataCheck = app.isPackaged
      ? path.resolve(process.resourcesPath, '..', 'data')
      : path.join(__dirname, 'data');
    portable = fs.existsSync(dataCheck);
  }
  if (portable) {
    const dataDir = app.isPackaged
      ? path.resolve(process.resourcesPath, '..', 'data')
      : path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
    app.setPath('sessionData', path.join(dataDir, 'session'));
    if (!fs.existsSync(app.getPath('sessionData'))) fs.mkdirSync(app.getPath('sessionData'), { recursive: true });
    console.log('Portable mode: data stored at', dataDir);
  }
})();

// ── Self-destruct support (3 wrong passwords → wipe everything) ──
// Both markers live in the data folder and are written BEFORE anything is
// deleted, so they survive the wipe itself:
//   pending-wipe.json — retried by runPendingWipe() on the next launch
//   wipe-notice.json  — tells the user what happened, even after a restart
const PENDING_WIPE_PATH = path.join(app.getPath('userData'), 'pending-wipe.json');
const WIPE_NOTICE_PATH = path.join(app.getPath('userData'), 'wipe-notice.json');
const WIPED_MSG = 'Too many failed attempts. All local data has been deleted. Please create a new account.';

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function clearWipeNotice() { try { fs.unlinkSync(WIPE_NOTICE_PATH); } catch (e) {} }

// The only entries a wipe leaves behind: a repo placeholder, the
// single-instance lock of a running copy, and our own two marker files.
function keptOnWipe(name) {
  return name === '.gitkeep' || name.startsWith('Singleton') ||
         name.startsWith('pending-wipe') || name.startsWith('wipe-notice');
}

// Deletes EVERYTHING inside dir, then recreates it.
// A hand-maintained allowlist was tried first and already missed items Electron
// 35 writes (Preferences, Local State, DIPS, InterestGroups, SharedStorage,
// PrivateAggregation, Shared Dictionary, Dawn caches) — a directory that holds
// nothing but browser profile data is emptied wholesale instead.
// Windows refuses to unlink files Chromium still has open; those are retried
// by runPendingWipe() before the next launch opens any session file.
function emptyDir(dir) {
  const sessionDir = app.getPath('sessionData');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { /* missing */ }
  for (const n of names) {
    if (keptOnWipe(n)) continue;
    const p = path.join(dir, n);
    // portable mode: userData contains the session dir itself — already emptied
    if (path.resolve(p) === path.resolve(sessionDir)) continue;
    rmrf(p);
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

// Everything that should now be gone but is still on disk (locked / re-flushed
// by Chromium as it shut down).
function wipeLeftovers() {
  const left = [];
  const sessionDir = app.getPath('sessionData');
  [app.getPath('sessionData'), app.getPath('userData')].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(n => {
        if (keptOnWipe(n)) return;
        const p = path.join(dir, n);
        if (path.resolve(p) === path.resolve(sessionDir)) return;  // counted via its own pass
        left.push(p);
      });
    } catch (e) {}
  });
  return left;
}

function wipeDataFolders() {
  emptyDir(app.getPath('sessionData'));   // Chromium profile (cookies, localStorage, DIPS…)
  emptyDir(app.getPath('userData'));      // AEGIS data (database, prefs, legacy store…)
  const sessionDir = app.getPath('sessionData');
  if (!fs.existsSync(sessionDir)) { try { fs.mkdirSync(sessionDir, { recursive: true }); } catch (e) {} }
}

// Runs at startup, BEFORE any session/profile file is opened — the only moment
// when nothing holds a handle — so it can finish a wipe that the previous run
// could not complete while Chromium was alive.
function runPendingWipe() {
  let info = null;
  try { info = JSON.parse(fs.readFileSync(PENDING_WIPE_PATH, 'utf8')); } catch (e) { return; }
  console.log('Finishing data wipe started at', new Date(info.at || 0).toLocaleString(), '...');
  wipeDataFolders();
  const left = wipeLeftovers();
  if (left.length) { console.warn('wipe still blocked, will retry next launch:', left.join(', ')); return; }
  try { fs.unlinkSync(PENDING_WIPE_PATH); } catch (e) {}
}
runPendingWipe();

const TOP = 78;
const BOTTOM = 22;
const DB_PATH = path.join(app.getPath('userData'), 'ghostview.db');

// ── Network speed prefs (must be applied before app ready) ──
const NET_PREFS_PATH = path.join(app.getPath('userData'), 'net-prefs.json');
let netPrefs = { secureDns: false };
try { netPrefs = Object.assign(netPrefs, JSON.parse(fs.readFileSync(NET_PREFS_PATH, 'utf8'))); } catch (e) {}

// ── Download-folder preference (default + YouTube-specific destination) ──
// dlDir: the default folder for ALL downloads, set in Parameters.
// ytDir: an optional dedicated folder for YouTube downloads; when empty the
// YouTube feature follows dlDir (see ytDownloadDir). Same load-on-start /
// write-on-change pattern as net-prefs.
const DL_PREFS_PATH = path.join(app.getPath('userData'), 'dl-prefs.json');
let dlPrefs = { ytDir: '', dlDir: '' };
try { dlPrefs = Object.assign(dlPrefs, JSON.parse(fs.readFileSync(DL_PREFS_PATH, 'utf8'))); } catch (e) {}
function saveDlPrefs() { try { fs.writeFileSync(DL_PREFS_PATH, JSON.stringify(dlPrefs)); } catch (e) {} }

// ── Aegis Shield ──
// Loads shield-prefs.json + the bundled rule list into the domain trie and
// generates the per-run fingerprint seed. MUST come after runPendingWipe()
// above (a wipe deletes shield-prefs.json) and after setupPortable(), which
// may relocate the profile folder.
shield.init(app.getPath('userData'));

app.commandLine.appendSwitch('disable-features', 'MediaRouter,ChromeWhatsNewUI');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-features', 'msWebOOUI');
// Download large files over multiple parallel connections
app.commandLine.appendSwitch('enable-parallel-downloading');
// Secure DNS (DNS-over-HTTPS) — opt-in via Settings → Network Speed
if (netPrefs.secureDns) app.commandLine.appendSwitch('enable-features', 'DnsOverHttps:DnsOverHttpsMode/secure');
app.setAsDefaultProtocolClient('ghostview');
// Register AEGIS for http/https links so Windows can open links with it.
// Packaged app only — in dev this would point links at electron.exe and hijack them.
if (app.isPackaged) {
  try { app.setAsDefaultProtocolClient('http'); } catch (e) {}
  try { app.setAsDefaultProtocolClient('https'); } catch (e) {}
}

// ── Standard browser User-Agent (set before any session exists) ──────────────
// Electron's default UA carries the app name and the Electron token
// ("aegis/1.0.0 … Electron/35.x.x"). Google's sign-in endpoint rejects that
// with "This browser or app may not be secure", which surfaces as a silent
// OAuth failure / endless login loop. Rebuild a plain Chrome string instead —
// oauth.standardUserAgent() only removes those two tokens, so OS, arch and the
// real Chromium version stay exact. Applied to every session twice: here as
// the process-wide fallback, and per session in setupSession() below.
function computeUserAgent() {
  let ua = '';
  try { ua = oauth.standardUserAgent(app.userAgentFallback, app.getName()); } catch (e) {}
  if (ua) return ua;
  // Unexpected UA shape → construct a Chrome string for this platform.
  const v = process.versions.chrome || '134.0.0.0';
  const tail = `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
  if (process.platform === 'darwin') return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${tail}`;
  if (process.platform === 'linux') return `Mozilla/5.0 (X11; Linux x86_64) ${tail}`;
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${tail}`;
}
const BROWSER_USER_AGENT = computeUserAgent();
app.userAgentFallback = BROWSER_USER_AGENT;

let mainWindow;
let workspaceTabs = {};
let activeIdPerWorkspace = {};
let idCounter = 0;
let currentUser = null;
// What the UI shows as the signed-in pseudonym: the name that was TYPED at
// login. A duress login runs inside a derived decoy account whose real key
// must never reach the screen.
let currentUserLabel = null;
// Non-null only during a duress (decoy) session: the pseudonym of the real
// account the decoy derives from. Used to answer credential prompts with the
// duress password and to block every "change my account" path.
let decoyOwnerPseudo = null;
let currentWorkspace = null;
let autoSaveInterval = null;
let idleTimeout = null;
const DEFAULT_AUTO_CLOSE = 1;
const DEFAULT_AUTO_CLOSE_SECONDS = 300;
let panelOpen = false;
const PANEL_WIDTH = 400;
// Workspace-wide download shelf (controls.html): reserved strip at the bottom
// of the content area so the shelf renders ABOVE the page views — same pattern
// as panelOpen's width reserve. 0 = no shelf visible.
let shelfReserve = 0;
let zoomLevel = 0;
let downloadsWindow = null;
let splitMode = false;
let splitLeft = null;
let splitRight = null;
let splitRatio = 0.5;
let db;
let suggestHeight = 0;
let playingTabs = new Map();
let powerSaveId = null;
// Every workspace session this run has opened — wipeAllData() clears their
// in-memory cookie jars/caches too, not just the files on disk.
const usedPartitions = new Set();

// ── Ghost Workspace ──
// A standing card on the workspace screen that opens a workspace living
// entirely in RAM: its session partition is created WITHOUT the `persist:`
// prefix, so Chromium never writes cookies/cache/localStorage to disk, and no
// row, tab list, history entry, bookmark or note is ever INSERTed for it in
// SQLite. Closing the workspace (or quitting) drops the partition and all of
// its state vanishes.
const GHOST_WS_ID = 'ghost';
const GHOST_WS_NAME = 'Ghost Workspace';
const GHOST_WS_COLOR = '#8b5cf6';
// Bumped every time the Ghost Workspace is opened so each visit gets a
// brand-new partition name: nothing from a previous visit can ever be
// re-attached (and nothing old is ever re-read).
let ghostGeneration = 0;

function isGhostWs(id) { return id === GHOST_WS_ID; }

// In-memory partition name for the current Ghost visit. Non-`persist:` names
// live only in RAM — Chromium creates no `Partitions/<name>/` folder for them.
function ghostPartition() { return 'ghost-ephemeral-g' + ghostGeneration; }

// Single source of truth for "which partition does this workspace get".
// Everything that opens a view routes through here so the Ghost Workspace
// can never accidentally be given a `persist:` partition.
function partitionFor(wsId) {
  if (isGhostWs(wsId)) return ghostPartition();
  return 'persist:user_' + currentUser + '_ws_' + wsId;
}

// Synthetic workspace row so the rest of the app (menu, get-active-workspace,
// rename/delete guards) can treat the Ghost Workspace like any other card
// without a real SQLite row existing.
function ghostRow(p) {
  return { id: GHOST_WS_ID, user_pseudo: p, name: GHOST_WS_NAME, created: 0, color: GHOST_WS_COLOR, google_email: null, ghost: 1 };
}

// Discard the Ghost Workspace: destroy its views, forget its tabs, then wipe
// the in-memory session (cookies/cache/storage) so the RAM goes back to the
// OS. Fire-and-forget — nothing here can leave a file behind because the
// partition never had one.
function closeGhostWorkspace() {
  try {
    const tabs = workspaceTabs[GHOST_WS_ID];
    if (tabs) tabs.forEach(t => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(t.view); } catch(e) {}
      try { t.view.webContents.close(); } catch(e) {}
    });
    delete workspaceTabs[GHOST_WS_ID];
    delete activeIdPerWorkspace[GHOST_WS_ID];
    for (const [tabId, info] of playingTabs) { if (info.workspaceId === GHOST_WS_ID) playingTabs.delete(tabId); }
  } catch(e) {}
  const part = 'ghost-ephemeral-g' + ghostGeneration;
  try {
    if (usedPartitions.has(part)) {
      const s = session.fromPartition(part);
      s.clearStorageData().catch(() => {});
      s.clearCache().catch(() => {});
      s.clearAuthCache().catch(() => {});
      usedPartitions.delete(part);
    }
  } catch(e) {}
  updatePowerSaveBlocker();
}

// ── Analytics ──
let analyticsEnabled = true;
let currentVisit = null;
let sessionStartTime = null;
let sessionTabSwitches = 0;
let sessionDomains = new Set();
// True while the current analytics session started inside the Ghost Workspace:
// no browser_sessions row was written for it (Ghost writes nothing), and the
// row is deferred until a real workspace becomes active.
let sessionRowPending = false;
let windowFocusedAt = null;
let activeTimeTick = null;

function updatePowerSaveBlocker() {
  const hasAudio = playingTabs.size > 0;
  if (hasAudio && powerSaveId === null) {
    powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!hasAudio && powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
}

// Every playing tab, tagged with the workspace it lives in — that tag is what
// lets the "background media" pill jump straight to the workspace playing it.
// If a path recorded a tab without workspaceId, fall back to scanning the live
// tab lists so the pill can still navigate.
function mediaStatePayload() {
  const entries = Array.from(playingTabs.entries()).map(([id, info]) => {
    let wsId = info.workspaceId;
    if (!wsId) {
      for (const k of Object.keys(workspaceTabs)) {
        if ((workspaceTabs[k] || []).some(t => t.id === id)) { wsId = k; break; }
      }
    }
    return { id, ...info, workspaceId: wsId };
  });
  const byWorkspace = {};
  entries.forEach(t => { if (!byWorkspace[t.workspaceId]) byWorkspace[t.workspaceId] = []; byWorkspace[t.workspaceId].push(t); });
  return { playing: playingTabs.size > 0, tabs: entries, byWorkspace };
}

function broadcastMediaState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media-state', mediaStatePayload());
  }
}

function currentTabs() {
  return currentWorkspace ? (workspaceTabs[currentWorkspace] || []) : [];
}

function setCurrentTabs(arr) {
  if (currentWorkspace) workspaceTabs[currentWorkspace] = arr;
}

function getActiveId(wsId) { return activeIdPerWorkspace[wsId] || null; }
function setActiveId(wsId, id) { activeIdPerWorkspace[wsId] = id; }

function getActiveTab(wsId) {
  const tabs = workspaceTabs[wsId];
  if (!tabs) return null;
  const id = getActiveId(wsId);
  return tabs.find(t => t.id === id) || (tabs.length > 0 ? tabs[0] : null);
}

let shownViews = new Set();
let syncViewsPending = false;
let lastSyncBounds = '';
function removeShownViews() {
  shownViews.forEach(v => { try { mainWindow.contentView.removeChildView(v); } catch(e) {} });
  shownViews.clear();
}
function syncViewsImmediate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const isFS = mainWindow.isFullScreen();
  const b = mainWindow.getBounds();
  const pw = panelOpen ? PANEL_WIDTH : 0;
  const top = TOP + suggestHeight;
  const h = Math.max(50, b.height - top - (isFS ? 0 : BOTTOM) - shelfReserve);
  if (splitMode && splitLeft && splitRight) {
    const gap = 4;
    const handleW = 6;
    const totalW = b.width - pw;
    const leftW = Math.floor(totalW * splitRatio);
    const rightW = totalW - leftW - handleW - gap;
    const boundsKey = `s|${leftW}|${rightW}|${top}|${h}|${pw}|${shelfReserve}`;
    if (boundsKey === lastSyncBounds) return;
    lastSyncBounds = boundsKey;
    removeShownViews();
    const lt = getActiveTab(splitLeft);
    if (lt) { lt.view.setBounds({ x:0, y:top, width:leftW, height:h }); mainWindow.contentView.addChildView(lt.view); shownViews.add(lt.view); }
    const rt = getActiveTab(splitRight);
    if (rt) { rt.view.setBounds({ x:leftW + gap + handleW, y:top, width:rightW, height:h }); mainWindow.contentView.addChildView(rt.view); shownViews.add(rt.view); }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-bounds', { left: leftW, right: rightW, handleX: leftW + gap, total: totalW });
  } else if (currentWorkspace) {
    const t = getActiveTab(currentWorkspace);
    if (t) {
      const boundsKey = `n|0|${top}|${b.width-pw}|${h}|${pw}|${shelfReserve}`;
      if (boundsKey === lastSyncBounds) return;
      lastSyncBounds = boundsKey;
      removeShownViews();
      t.view.setBounds({ x:0, y:top, width:b.width-pw, height:h }); mainWindow.contentView.addChildView(t.view); shownViews.add(t.view);
    }
  }
  // Page views were just re-added above: lift the suggestion overlay back on top
  // (addChildView on an existing child reorders it to the topmost position).
  if (ytOverlayView && !ytOverlayView.webContents.isDestroyed() &&
      mainWindow.contentView.children.includes(ytOverlayView)) {
    try { mainWindow.contentView.addChildView(ytOverlayView); } catch (err) {}
  }
  if (suggestOverlayView && !suggestOverlayView.webContents.isDestroyed() &&
      mainWindow.contentView.children.includes(suggestOverlayView)) {
    try { mainWindow.contentView.addChildView(suggestOverlayView); } catch (err) {}
  }
}
function syncViews() {
  if (syncViewsPending) return;
  syncViewsPending = true;
  process.nextTick(() => { syncViewsPending = false; lastSyncBounds = ''; syncViewsImmediate(); });
}

// ── Database ──

function initDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jsonFile = path.join(app.getPath('userData'), 'ghostview-data.json');
  const hasJson = fs.existsSync(jsonFile);
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  // secure_delete: UPDATE/DELETE zero-fill the old bytes instead of leaving
  // them in free pages. Without it, every pre-vault plaintext row would still
  // be readable inside the file after being "encrypted" over the top.
  db.pragma('secure_delete = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      pseudo TEXT PRIMARY KEY, password TEXT NOT NULL, salt TEXT NOT NULL,
      created INTEGER NOT NULL, photo TEXT, active_workspace TEXT DEFAULT 'default',
      is_guest INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT NOT NULL, user_pseudo TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL,
      color TEXT DEFAULT '#4a8bc5', google_email TEXT,
      PRIMARY KEY (id, user_pseudo)
    );
    CREATE TABLE IF NOT EXISTS tabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_pseudo TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_pseudo TEXT NOT NULL,
      url TEXT NOT NULL, title TEXT DEFAULT '', timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_pseudo TEXT NOT NULL,
      url TEXT NOT NULL, title TEXT DEFAULT '', timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_pseudo TEXT NOT NULL,
      filename TEXT NOT NULL, url TEXT, save_path TEXT, total_bytes INTEGER DEFAULT 0,
      received_bytes INTEGER DEFAULT 0, start_time INTEGER NOT NULL,
      done INTEGER DEFAULT 0, success INTEGER DEFAULT 0, canceled INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS page_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_pseudo TEXT NOT NULL, workspace_id TEXT,
      url TEXT NOT NULL, domain TEXT NOT NULL, category TEXT DEFAULT 'Uncategorized',
      title TEXT DEFAULT '', start_time INTEGER NOT NULL, end_time INTEGER, duration INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS browser_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_pseudo TEXT NOT NULL, workspace_id TEXT,
      start_time INTEGER NOT NULL, end_time INTEGER, duration INTEGER DEFAULT 0,
      tab_switches INTEGER DEFAULT 0, domains_visited INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS daily_analytics (
      date TEXT NOT NULL, user_pseudo TEXT NOT NULL,
      total_active_time INTEGER DEFAULT 0, total_pages_visited INTEGER DEFAULT 0,
      workspaces_used INTEGER DEFAULT 0, longest_session INTEGER DEFAULT 0,
      avg_session_duration REAL DEFAULT 0, focus_score INTEGER DEFAULT 0,
      productivity_score INTEGER DEFAULT 0, social_media_time INTEGER DEFAULT 0,
      learning_time INTEGER DEFAULT 0,
      PRIMARY KEY (date, user_pseudo)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_pseudo TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_keystores (
      user_pseudo TEXT PRIMARY KEY,
      kdf TEXT NOT NULL DEFAULT 'PBKDF2-SHA512',
      iterations INTEGER NOT NULL,
      salt TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      created INTEGER NOT NULL,
      rekeyed INTEGER,
      migrated INTEGER NOT NULL DEFAULT 0
    );
  `);
  try { db.exec('ALTER TABLE downloads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT \'\''); } catch(e) {}
  try { db.exec('UPDATE downloads SET workspace_id = \'default\' WHERE workspace_id = \'\''); } catch(e) {}
  try { db.exec('ALTER TABLE workspaces ADD COLUMN color TEXT DEFAULT \'#4a8bc5\''); } catch(e) {}
  // The Google account email shown on the workspace card, persisted so it is
  // visible without re-reading the session (see get-google-email).
  try { db.exec('ALTER TABLE workspaces ADD COLUMN google_email TEXT'); } catch(e) {}
  // Anonymous (guest) accounts — drives e.g. the Ghost Mode top-bar badge.
  try { db.exec('ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN auto_close INTEGER NOT NULL DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN auto_close_seconds INTEGER NOT NULL DEFAULT 300"); } catch(e) {}
  // ── Duress password (panic decoy): a second password that opens a separate,
  //    believable-but-empty account. NULL = not configured. ──
  try { db.exec('ALTER TABLE users ADD COLUMN duress_password TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN duress_salt TEXT'); } catch(e) {}
  // Key of the decoy account this user's duress password opens (set once, at
  // first use) — remembered so a later login lands on the same account even if
  // the derived name was taken by a registration in the meantime.
  try { db.exec('ALTER TABLE users ADD COLUMN duress_decoy_key TEXT'); } catch(e) {}
  // ── Persistent session: tab order + active tab per workspace ──
  try { db.exec('ALTER TABLE tabs ADD COLUMN position INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE workspaces ADD COLUMN active_url TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE workspaces ADD COLUMN active_index INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tabs_user_ws ON tabs(user_pseudo, workspace_id)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_history_user_ws_ts ON history(user_pseudo, workspace_id, timestamp)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_user_ws ON bookmarks(user_pseudo, workspace_id)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_visits_user_start ON page_visits(user_pseudo, start_time)'); } catch(e) {}
  try { db.exec('DROP INDEX IF EXISTS idx_visits_user_domain'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_visits_user_ws ON page_visits(user_pseudo, workspace_id)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_visits_category ON page_visits(user_pseudo, category, start_time)'); } catch(e) {}
  // url/domain are ciphertext in the vault (see vault.js) — an index on them
  // could never match a plaintext comparison, so both are dropped rather than
  // carried as silent dead weight. Lookups moved into JavaScript.
  try { db.exec('DROP INDEX IF EXISTS idx_bookmarks_url'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_start ON browser_sessions(user_pseudo, start_time)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_notes_user_created ON notes(user_pseudo, created)'); } catch(e) {}
  // ── Notes are per-workspace; older builds stored them per user only ──
  try { db.exec("ALTER TABLE notes ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'"); } catch(e) {}
  try { db.exec("UPDATE notes SET workspace_id = 'default' WHERE workspace_id IS NULL OR workspace_id = ''"); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_notes_user_ws_created ON notes(user_pseudo, workspace_id, created)'); } catch(e) {}
  // Assign distinct colors to existing workspaces that have the default
  const wsColors = ['#4a8bc5','#7a5db5','#48bb78','#e5834a','#e56a6a','#4ac5b5','#c5a84a','#9b5de5'];
  try {
    const uncolored = db.prepare("SELECT id, user_pseudo, ROW_NUMBER() OVER (PARTITION BY user_pseudo ORDER BY created) AS rn FROM workspaces WHERE color='#4a8bc5'").all();
    const upd = db.prepare('UPDATE workspaces SET color=? WHERE id=? AND user_pseudo=?');
    uncolored.forEach(r => upd.run(wsColors[(r.rn - 1) % wsColors.length], r.id, r.user_pseudo));
  } catch(e) {}
  if (hasJson) {
    try {
      const json = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
      if (json.users) {
        const insUser = db.prepare('INSERT OR IGNORE INTO users (pseudo,password,salt,created,photo,active_workspace) VALUES (?,?,?,?,?,?)');
        const insWS = db.prepare('INSERT OR IGNORE INTO workspaces (id,user_pseudo,name,created) VALUES (?,?,?,?)');
        const insTab = db.prepare('INSERT INTO tabs (workspace_id,user_pseudo,url,title) VALUES (?,?,?,?)');
        const insHist = db.prepare('INSERT INTO history (workspace_id,user_pseudo,url,title,timestamp) VALUES (?,?,?,?,?)');
        const insBm = db.prepare('INSERT INTO bookmarks (workspace_id,user_pseudo,url,title,timestamp) VALUES (?,?,?,?,?)');
        const tx = db.transaction(() => {
          for (const [key, u] of Object.entries(json.users)) {
            insUser.run(key, u.password, u.salt, u.created||Date.now(), u.photo||null, u.activeWorkspace||'default');
            const wss = u.workspaces || { 'default': { name:'Default', tabs:u.tabs||[], history:u.history||[], created:u.created||Date.now() } };
            for (const [wsId, ws] of Object.entries(wss)) {
              insWS.run(wsId, key, ws.name, ws.created);
              if (ws.tabs) ws.tabs.forEach(t => insTab.run(wsId, key, t.url||'', t.title||''));
              if (ws.history) ws.history.forEach(h => insHist.run(wsId, key, h.url, h.title||'', h.timestamp));
              if (ws.bookmarks) ws.bookmarks.forEach(b => insBm.run(wsId, key, b.url, b.title||'', b.timestamp));
            }
          }
        });
        tx();
      }
      fs.renameSync(jsonFile, jsonFile + '.bak');
    } catch(e) { console.error('Migration error:', e); }
  }
}

const bookmarkCache = new Map();
function bookmarkKey(p, ws, url) { return p + '|' + ws + '|' + url; }
function invalidateBookmarkCache() { bookmarkCache.clear(); }

const stmt = {};
function prepareStatements() {
  stmt.historyInsert = db.prepare('INSERT INTO history (user_pseudo,workspace_id,url,title,timestamp) VALUES (?,?,?,?,?)');
  stmt.visitInsert = db.prepare('INSERT INTO page_visits (user_pseudo,workspace_id,url,domain,category,title,start_time) VALUES (?,?,?,?,?,?,?)');
  stmt.visitUpdate = db.prepare('UPDATE page_visits SET end_time=?,duration=? WHERE id=?');
  stmt.tabDelete = db.prepare('DELETE FROM tabs WHERE user_pseudo=? AND workspace_id=?');
  try {
    stmt.tabInsert = db.prepare('INSERT INTO tabs (user_pseudo,workspace_id,url,title,position) VALUES (?,?,?,?,?)');
  } catch(e) {
    stmt.tabInsert = db.prepare('INSERT INTO tabs (user_pseudo,workspace_id,url,title) VALUES (?,?,?,?)');
  }
  // Bookmarks are matched by URL in JavaScript (findBookmarkRow) because url
  // is ciphertext: a `WHERE url=?` would compare base64 against a plaintext
  // URL and never hit. Only the id — which stays plaintext — is used in SQL.
  stmt.bookmarkFind = db.prepare('SELECT id, url FROM bookmarks WHERE user_pseudo=? AND workspace_id=?');
  stmt.bookmarkInsert = db.prepare('INSERT INTO bookmarks (user_pseudo,workspace_id,url,title,timestamp) VALUES (?,?,?,?,?)');
  stmt.bookmarkDelete = db.prepare('DELETE FROM bookmarks WHERE id=? AND user_pseudo=?');
  stmt.noteList = db.prepare('SELECT id,content,created,updated FROM notes WHERE user_pseudo=? AND workspace_id=? ORDER BY created DESC, id DESC');
  stmt.noteInsert = db.prepare('INSERT INTO notes (user_pseudo,workspace_id,content,created,updated) VALUES (?,?,?,?,?)');
  stmt.noteUpdate = db.prepare('UPDATE notes SET content=?,updated=? WHERE id=? AND user_pseudo=?');
  stmt.noteDelete = db.prepare('DELETE FROM notes WHERE id=? AND user_pseudo=?');
}

// ── Vault: at-rest field encryption (AES-256-GCM, per-user envelope key) ─────
//
// What is encrypted: the identifier-bearing text columns of the seven tables
// listed below. What stays plaintext on purpose: every number and every coarse
// label (timestamps, durations, byte counts, daily_analytics.* and the single
// word page_visits.category) — those are exactly what the analytics GROUP BYs
// run on, they carry no identifier, and daily_analytics already stores the
// same facts as plain aggregates.
//
// Encryption is a one-way street for SQL: once a column is ciphertext, no
// statement may ever compare, group, order or index it again. Every such site
// in this file was moved into JavaScript (bookmarks by url, downloads by
// save_path, top-sites by domain, workspace breakdown by name) and
// test-vault.js fails the build if a WHERE/GROUP BY/ORDER BY on an encrypted
// column ever comes back.
//
//   table        encrypted columns                        row scope
//   history      url, title                               workspace_id
//   bookmarks    url, title                               workspace_id
//   tabs         url, title                               workspace_id
//   notes        content                                  workspace_id
//   page_visits  url, domain, title                       workspace_id
//   downloads    filename, url, save_path                 workspace_id
//   workspaces   name, google_email, active_url           id
//
// The key (DEK) exists only in this process' memory and only for the account
// that is logged in — see vault.js for the envelope (PBKDF2-SHA512 300k wraps
// the DEK) and vaultMigrate below for the one-time plaintext sweep.
const VAULT_TABLES = [
  { table: 'history',     cols: ['url', 'title'],                       scope: 'workspace_id' },
  { table: 'bookmarks',   cols: ['url', 'title'],                       scope: 'workspace_id' },
  { table: 'tabs',        cols: ['url', 'title'],                       scope: 'workspace_id' },
  { table: 'notes',       cols: ['content'],                            scope: 'workspace_id' },
  { table: 'page_visits', cols: ['url', 'domain', 'title'],             scope: 'workspace_id' },
  { table: 'downloads',   cols: ['filename', 'url', 'save_path'],       scope: 'workspace_id' },
  { table: 'workspaces',  cols: ['name', 'google_email', 'active_url'], scope: 'id' },
];
const VAULT_MATRIX = Object.create(null);
for (const t of VAULT_TABLES) VAULT_MATRIX[t.table] = { cols: t.cols, scope: t.scope };

// DEK of the logged-in account: never on disk, never logged, never sent over
// IPC. vaultUser pins it to one pseudonym, so a key left behind by a logout
// race can never decrypt a different account's rows.
let vaultKey = null;
let vaultUser = null;

function vaultActiveFor(user) { return !!vaultKey && !!user && vaultUser === user; }
function vaultDeactivate() { vault.zeroize(vaultKey); vaultKey = null; vaultUser = null; }

// True when this account's rows are SUPPOSED to be ciphertext — its one-time
// plaintext sweep has already run (migrated=1) — but the key is not in memory
// right now. Writing anyway would leak, so vaultEncRow returns null and the
// caller drops the write. Guests and duress profiles have no keystore row at
// all, and a pre-first-login account is still migrated=0 (plaintext by design
// until the sweep): both are exempt.
function vaultPlainForbidden(user) {
  if (!user || vaultActiveFor(user)) return false;
  try {
    const ks = db.prepare('SELECT migrated FROM user_keystores WHERE user_pseudo=?').get(user);
    return !!ks && !!ks.migrated;
  } catch (e) {
    return true; // no database to consult: fail safe, never fall through to plaintext
  }
}

// Encrypt one row's matrix columns in place (returns a copy; untouched columns
// keep their identity). `row` must carry the scope column and, when available,
// user_pseudo — the caller passes `user` as the fallback.
function vaultEncRow(table, row, user) {
  const spec = VAULT_MATRIX[table];
  if (!spec || !row) return row;
  const u = row.user_pseudo || user;
  if (!vaultActiveFor(u)) {
    // A vaulted account must NEVER fall through to plaintext: with no key in
    // memory (a navigation committing during quit teardown, a logout race)
    // return null so the caller drops the write instead of leaking it.
    if (vaultPlainForbidden(u)) return null;
    return row;
  }
  const scope = String(row[spec.scope] || '');
  let out = row;
  for (const col of spec.cols) {
    const v = row[col];
    if (v === null || v === undefined || v === '' || vault.isEncrypted(v)) continue;
    if (out === row) out = Object.assign({}, row);
    out[col] = vault.encrypt(vaultKey, v, vault.aadFor(table, col, u, scope));
  }
  return out;
}

// Decrypt one row's matrix columns. A value that fails authentication (row
// moved to another account/column, file tampered with) is handed back exactly
// as stored instead of throwing: one bad cell must never take down a panel,
// and the AEG1: marker on screen is the honest report that something is wrong.
function vaultDecRow(table, row, user) {
  const spec = VAULT_MATRIX[table];
  if (!spec || !row) return row;
  const u = row.user_pseudo || user;
  if (!vaultActiveFor(u)) return row;
  const scope = String(row[spec.scope] || '');
  let out = row;
  for (const col of spec.cols) {
    const v = row[col];
    if (!vault.isEncrypted(v)) continue;
    if (out === row) out = Object.assign({}, row);
    try {
      out[col] = vault.decrypt(vaultKey, v, vault.aadFor(table, col, u, scope));
    } catch (err) {
      console.error('vault: could not decrypt ' + table + '.' + col + ' — value left as stored');
    }
  }
  return out;
}

function vaultKeystoreRow(user) {
  try { return db.prepare('SELECT * FROM user_keystores WHERE user_pseudo=?').get(user); }
  catch (e) { return null; }
}

// Enrol a brand-new account: its keystore exists before its first row is ever
// read, so nothing about it is ever written in plaintext after this point.
function vaultEnrollNewUser(user, password) {
  try {
    const ks = vault.createKeystore(password, user);
    vault.zeroize(ks.dek); // login unwraps a fresh copy from the row
    db.prepare('INSERT OR REPLACE INTO user_keystores (user_pseudo,kdf,iterations,salt,wrapped_key,created,migrated) VALUES (?,?,?,?,?,?,0)')
      .run(user, 'PBKDF2-SHA512', ks.iterations, ks.salt, ks.wrapped, Date.now());
  } catch (e) {
    // Never block registration on the vault: the account still works and the
    // keystore is created at first login instead (see vaultActivateForLogin).
    console.error('vault: enrolment failed, will retry at first login:', e && e.message);
  }
}

// One-time sweep: encrypt every pre-vault row of this account, then rebuild
// the file. Both halves are mandatory — an UPDATE with secure_delete=ON hides
// the old bytes in free pages, and only VACUUM rewrites the file so that they
// are gone for good. Runs inside a transaction, so a failure (or a kill)
// leaves migrated=0 and the next login simply starts the sweep again.
function vaultMigrate(user) {
  if (!vaultActiveFor(user)) return false;
  const ks = db.prepare('SELECT migrated FROM user_keystores WHERE user_pseudo=?').get(user);
  if (!ks || ks.migrated) return true;
  const sweep = db.transaction(() => {
    for (const t of VAULT_TABLES) {
      const rows = db.prepare(
        'SELECT id AS pk, user_pseudo, ' + t.scope + ' AS scope, ' + t.cols.join(', ') +
        ' FROM ' + t.table + ' WHERE user_pseudo=?'
      ).all(user);
      if (!rows.length) continue;
      const upd = db.prepare(
        'UPDATE ' + t.table + ' SET ' + t.cols.map(c => c + '=?').join(', ') +
        ' WHERE id=? AND user_pseudo=?'
      );
      for (const r of rows) {
        const row = { user_pseudo: r.user_pseudo };
        row[t.scope] = r.scope;
        for (const c of t.cols) row[c] = r[c];
        const enc = vaultEncRow(t.table, row, user);
        if (!enc) continue; // key gone mid-sweep: leave the row for the next attempt
        const vals = t.cols.map(c => enc[c]);
        if (t.cols.every((c, i) => vals[i] === r[c])) continue; // already ciphertext
        upd.run(...vals, r.pk, user);
      }
    }
    db.prepare('UPDATE user_keystores SET migrated=1 WHERE user_pseudo=?').run(user);
  });
  sweep();
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
  try { db.exec('VACUUM'); } catch (e) { console.error('vault: post-migration VACUUM failed:', e); }
  return true;
}

// Third and final KDF of a login attempt, exactly once for every successful
// branch: unwrap an existing keystore, enrol a legacy account (creating its
// keystore), or — in the duress branch — burn an identical derivation so the
// wall-clock cost cannot tell an observer which of the two happened.
function vaultActivateForLogin(user, password) {
  const row = vaultKeystoreRow(user);
  let dek;
  if (row) {
    dek = vault.unlockKeystore(password, user, row); // throws: damaged/tampered row
  } else {
    const ks = vault.createKeystore(password, user);
    dek = ks.dek;
    db.prepare('INSERT INTO user_keystores (user_pseudo,kdf,iterations,salt,wrapped_key,created,migrated) VALUES (?,?,?,?,?,?,0)')
      .run(user, 'PBKDF2-SHA512', ks.iterations, ks.salt, ks.wrapped, Date.now());
  }
  vaultKey = dek;
  vaultUser = user;
  vaultMigrate(user);
}

// Password change: re-wrap the SAME DEK under a KEK derived from the new
// password. No ciphertext row is touched, so the re-key is atomic — there is
// no state in which half the database still wants the old password. Must be
// called inside the change-password transaction.
function vaultRekey(user, newPassword) {
  if (!vaultActiveFor(user)) return;
  const row = vaultKeystoreRow(user);
  if (row) {
    const next = vault.rewrapKeystore(vaultKey, newPassword, row, user);
    db.prepare('UPDATE user_keystores SET salt=?, iterations=?, wrapped_key=?, rekeyed=? WHERE user_pseudo=?')
      .run(next.salt, next.iterations, next.wrapped, Date.now(), user);
    return;
  }
  // Keystore vanished mid-session (external edit): rebuild one around the key
  // that is already in memory, so re-encryption stays a no-op too.
  const fresh = { salt: crypto.randomBytes(16).toString('hex'), iterations: vault.KDF_ITERATIONS };
  const next = vault.rewrapKeystore(vaultKey, newPassword, fresh, user);
  db.prepare('INSERT INTO user_keystores (user_pseudo,kdf,iterations,salt,wrapped_key,created,migrated) VALUES (?,?,?,?,?,?,0)')
    .run(user, 'PBKDF2-SHA512', next.iterations, next.salt, next.wrapped, Date.now());
  vaultMigrate(user);
}

// ── Analytics URL Classifier ──
function classifyDomain(domain) {
  const d = domain.toLowerCase().replace(/^www\./, '');
  const social = ['facebook.com','twitter.com','x.com','instagram.com','linkedin.com','tiktok.com','snapchat.com','reddit.com','pinterest.com','discord.com','twitch.tv','telegram.org','whatsapp.com','messenger.com','wechat.com','tumblr.com','threads.net','bsky.app'];
  const video = ['youtube.com','netflix.com','hulu.com','disneyplus.com','hbomax.com','max.com','peacocktv.com','paramountplus.com','primevideo.com','crunchyroll.com','vimeo.com','dailymotion.com'];
  const news = ['cnn.com','bbc.com','bbc.co.uk','nytimes.com','theguardian.com','reuters.com','bloomberg.com','wsj.com','washingtonpost.com','apnews.com','npr.org','foxnews.com','msnbc.com','news.ycombinator.com','theverge.com','wired.com','arstechnica.com','techcrunch.com','engadget.com'];
  const productivity = ['github.com','gitlab.com','bitbucket.org','stackoverflow.com','stackexchange.com','docs.google.com','sheets.google.com','notion.so','notion.site','miro.com','figma.com','linear.app','asana.com','trello.com','slack.com','teams.microsoft.com','outlook.live.com','outlook.office.com','mail.google.com','calendar.google.com','drive.google.com','office.com','microsoft365.com','chat.openai.com','claude.ai','perplexity.ai','gemini.google.com','copilot.microsoft.com','phind.com'];
  const learning = ['wikipedia.org','coursera.org','udemy.com','edx.org','khanacademy.org','skillshare.com','pluralsight.com','udacity.com','datacamp.com','codecademy.com','freecodecamp.org','mdn.dev','mdn.mozilla.org','developer.mozilla.org','stackoverflow.com','w3schools.com','geeksforgeeks.org','leetcode.com','hackerrank.com','codewars.com','medium.com','dev.to','towardsdatascience.com'];
  const shopping = ['amazon.com','amazon.co.uk','amazon.de','amazon.fr','ebay.com','etsy.com','walmart.com','target.com','bestbuy.com','aliexpress.com','shopify.com','shein.com','zalando.com'];
  const entertainment = ['spotify.com','pandora.com','deezer.com','apple.com','imdb.com','rottentomatoes.com','letterboxd.com','goodreads.com','quizlet.com','genius.com','bandcamp.com','soundcloud.com','mixcloud.com'];

  if (social.some(s => d.includes(s))) return 'Social Media';
  if (video.some(v => d.includes(v))) return 'Video & Streaming';
  if (news.some(n => d.includes(n))) return 'News & Articles';
  if (productivity.some(p => d.includes(p))) return 'Productivity';
  if (learning.some(l => d.includes(l))) return 'Learning';
  if (shopping.some(s => d.includes(s))) return 'Shopping';
  if (entertainment.some(e => d.includes(e))) return 'Entertainment';
  return 'General Browsing';
}

// ── Analytics Tracking ──
function getDomain(url) {
  try { return new URL(url).hostname; } catch(e) { return url; }
}

function recordVisitStart(tabId, url, title, wsId) {
  if (!analyticsEnabled || !currentUser) return;
  if (isGhostWs(wsId || currentWorkspace)) return; // Ghost: nothing recorded
  endCurrentVisit();
  const domain = getDomain(url);
  const category = classifyDomain(domain);
  const now = Date.now();
  const ws = wsId || currentWorkspace;
  // url/domain/title are the identifier: they go in ciphertext. category is a
  // single coarse label and stays plaintext so the analytics GROUP BYs (and
  // daily_analytics, which already stores social_media_time in the clear) keep
  // working on something indexable.
  const enc = vaultEncRow('page_visits', {
    user_pseudo: currentUser, workspace_id: ws, url: url.slice(0, 2048),
    domain: domain, category: category, title: title || '',
  }, currentUser);
  if (!enc) return;
  const info = stmt.visitInsert.run(enc.user_pseudo, enc.workspace_id, enc.url, enc.domain, enc.category, enc.title, now);
  currentVisit = { visitId: info.lastInsertRowid, tabId, url, domain, category, startTime: now };
  sessionDomains.add(domain);
}

function endCurrentVisit() {
  if (!currentVisit || !currentUser) return;
  const now = Date.now();
  const dur = now - currentVisit.startTime;
  stmt.visitUpdate.run(now, dur, currentVisit.visitId);
  currentVisit = null;
}

function ensureSession() {
  if (!currentUser) return;
  if (!sessionStartTime) {
    sessionStartTime = Date.now();
    sessionTabSwitches = 0;
    sessionDomains = new Set();
    if (isGhostWs(currentWorkspace)) sessionRowPending = true; // no row for Ghost
    else db.prepare('INSERT INTO browser_sessions (user_pseudo,workspace_id,start_time) VALUES (?,?,?)').run(currentUser, currentWorkspace, sessionStartTime);
  } else if (sessionRowPending && !isGhostWs(currentWorkspace)) {
    // Session began inside the Ghost Workspace (no row written there); write it
    // now that a real workspace is active so analytics stay continuous.
    sessionRowPending = false;
    try { db.prepare('INSERT INTO browser_sessions (user_pseudo,workspace_id,start_time) VALUES (?,?,?)').run(currentUser, currentWorkspace, sessionStartTime); } catch(e) {}
  }
}

function recordTabSwitch() {
  if (!analyticsEnabled || !currentUser || !sessionStartTime) return;
  sessionTabSwitches++;
  endCurrentVisit();
}

function endSession() {
  if (!sessionStartTime || !currentUser) return;
  const now = Date.now();
  const dur = now - sessionStartTime;
  db.prepare('UPDATE browser_sessions SET end_time=?,duration=?,tab_switches=?,domains_visited=? WHERE start_time=? AND user_pseudo=? AND end_time IS NULL')
    .run(now, dur, sessionTabSwitches, sessionDomains.size, sessionStartTime, currentUser);
  sessionStartTime = null;
  sessionRowPending = false;
  endCurrentVisit();
}

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

function computeDailyMetrics() {
  if (!currentUser) return;
  const today = getTodayStr();
  const dayStart = new Date(today).getTime();
  const dayEnd = dayStart + 86400000;
  const totalTime = db.prepare('SELECT COALESCE(SUM(duration),0) as t FROM page_visits WHERE user_pseudo=? AND start_time>=? AND start_time<?').get(currentUser, dayStart, dayEnd);
  const pages = db.prepare('SELECT COUNT(*) as c FROM page_visits WHERE user_pseudo=? AND start_time>=? AND start_time<?').get(currentUser, dayStart, dayEnd);
  const sessions = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(duration),0) as total, COALESCE(AVG(duration),0) as avg, MAX(duration) as longest FROM browser_sessions WHERE user_pseudo=? AND start_time>=? AND start_time<?').get(currentUser, dayStart, dayEnd);
  const catDist = db.prepare('SELECT category, COALESCE(SUM(duration),0) as t FROM page_visits WHERE user_pseudo=? AND start_time>=? AND start_time<? GROUP BY category ORDER BY t DESC').all(currentUser, dayStart, dayEnd);
  const socialTime = (catDist.find(c => c.category === 'Social Media') || { t: 0 }).t;
  const learningTime = (catDist.find(c => c.category === 'Learning') || { t: 0 }).t;
  const productivityTime = (catDist.find(c => c.category === 'Productivity') || { t: 0 }).t;
  const totalActive = totalTime.t || 0;
  let focusScore = totalActive > 0 ? Math.round(((totalActive - socialTime * 1.5) / totalActive) * 100) : 0;
  focusScore = Math.max(0, Math.min(100, focusScore));
  let prodScore = totalActive > 0 ? Math.round(((productivityTime + learningTime) / totalActive) * 100) : 0;
  const wsCount = db.prepare('SELECT COUNT(DISTINCT workspace_id) as c FROM page_visits WHERE user_pseudo=? AND start_time>=? AND start_time<?').get(currentUser, dayStart, dayEnd);
  db.prepare(
    `INSERT OR REPLACE INTO daily_analytics (date,user_pseudo,total_active_time,total_pages_visited,workspaces_used,longest_session,avg_session_duration,focus_score,productivity_score,social_media_time,learning_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(today, currentUser, totalActive, pages.c || 0, wsCount.c || 0, sessions.longest || 0, sessions.avg || 0, focusScore, prodScore, socialTime, learningTime);
}

function initAnalyticsTimers() {
  if (activeTimeTick) clearInterval(activeTimeTick);
  activeTimeTick = setInterval(() => {
    if (!currentUser || !analyticsEnabled) return;
    computeDailyMetrics();
    if (currentVisit) endCurrentVisit();  // re-open by recording a new start doesn't make sense; this saves intermediate state
  }, 300000);
}

function startAnalyticsForUser() {
  analyticsEnabled = true;
  sessionStartTime = null;
  sessionRowPending = false;
  currentVisit = null;
  sessionDomains = new Set();
  sessionTabSwitches = 0;
  initAnalyticsTimers();
  const cutoff = Date.now() - 90 * 86400000;
  try { db.prepare('DELETE FROM page_visits WHERE start_time < ?').run(cutoff); } catch(e) {}
  try { db.prepare('DELETE FROM history WHERE timestamp < ?').run(cutoff); } catch(e) {}
}

function stopAnalytics() {
  analyticsEnabled = false;
  endSession();
  if (activeTimeTick) { clearInterval(activeTimeTick); activeTimeTick = null; }
}

function deleteAllAnalytics() {
  if (!currentUser) return;
  stopAnalytics();
  db.prepare('DELETE FROM page_visits WHERE user_pseudo=?').run(currentUser);
  db.prepare('DELETE FROM browser_sessions WHERE user_pseudo=?').run(currentUser);
  db.prepare('DELETE FROM daily_analytics WHERE user_pseudo=?').run(currentUser);
}

function getUser(p) { return db.prepare('SELECT * FROM users WHERE pseudo=?').get(p.toLowerCase()); }
function getWorkspaces(p) { return db.prepare('SELECT * FROM workspaces WHERE user_pseudo=?').all(p).map(r => vaultDecRow('workspaces', r, p)); }
function getWorkspace(p, id) {
  // The Ghost Workspace has no SQL row by design — hand back the synthetic
  // row so guards (rename/delete/split/menu) see it as a normal workspace.
  if (isGhostWs(id)) return ghostRow(p);
  const row = db.prepare('SELECT * FROM workspaces WHERE id=? AND user_pseudo=?').get(id, p);
  return row ? vaultDecRow('workspaces', row, p) : row;
}
function getTabsDb(p, wsId) {
  // workspace_id is part of every value's AAD but is not projected here (and
  // not wanted in the payload), so it is re-attached for the decrypt only.
  try {
    return db.prepare('SELECT url, title, position FROM tabs WHERE user_pseudo=? AND workspace_id=? ORDER BY position ASC, rowid ASC').all(p, wsId)
      .map(r => vaultDecRow('tabs', { user_pseudo: p, workspace_id: wsId, url: r.url, title: r.title, position: r.position }, p));
  } catch(e) {
    return db.prepare('SELECT url, title FROM tabs WHERE user_pseudo=? AND workspace_id=?').all(p, wsId)
      .map(r => vaultDecRow('tabs', { user_pseudo: p, workspace_id: wsId, url: r.url, title: r.title }, p));
  }
}
function getWorkspaceState(p, wsId) {
  try {
    const row = db.prepare('SELECT active_url, active_index FROM workspaces WHERE id=? AND user_pseudo=?').get(wsId, p);
    if (!row) return row;
    // The AAD needs id + user_pseudo, which this projection does not select —
    // borrow them for the decrypt, then hand back the original two keys only.
    const dec = vaultDecRow('workspaces', { id: wsId, user_pseudo: p, active_url: row.active_url, active_index: row.active_index }, p);
    return { active_url: dec.active_url, active_index: dec.active_index };
  } catch(e) { return null; }
}
function saveTabsDb(p, wsId, list, activeUrl, activeIndex) {
  if (isGhostWs(wsId)) return; // Ghost Workspace: never persist a tab list
  // Encrypt BEFORE touching the table: if the key is missing for a vaulted
  // account (quit teardown racing a navigation), the whole save is dropped —
  // a DELETE without re-inserting would destroy the previously saved tabs.
  const encList = list.map((t) => vaultEncRow('tabs', { user_pseudo: p, workspace_id: wsId, url: t.url, title: t.title }, p));
  if (encList.some((e) => !e)) return;
  const finalUrl = activeUrl || (list[activeIndex || 0] ? list[activeIndex || 0].url : (list[0] ? list[0].url : null));
  const wsEnc = vaultEncRow('workspaces', { id: wsId, user_pseudo: p, active_url: finalUrl, active_index: activeIndex || 0 }, p);
  db.transaction(() => {
    stmt.tabDelete.run(p, wsId);
    encList.forEach((enc, i) => {
      try { stmt.tabInsert.run(p, wsId, enc.url, enc.title, i); }
      catch(e) { stmt.tabInsert.run(p, wsId, enc.url, enc.title); }
    });
    try {
      if (wsEnc) db.prepare('UPDATE workspaces SET active_url=?, active_index=? WHERE id=? AND user_pseudo=?')
        .run(wsEnc.active_url, activeIndex || 0, wsId, p);
    } catch(e) {}
  })();
}
function getHistDb(p, wsId) {
  // (workspace_id not projected — re-attached for the AAD, see getTabsDb)
  return db.prepare('SELECT url,title,timestamp FROM history WHERE user_pseudo=? AND workspace_id=? ORDER BY timestamp DESC LIMIT 200').all(p, wsId)
    .map(r => {
      const dec = vaultDecRow('history', { user_pseudo: p, workspace_id: wsId, url: r.url, title: r.title }, p);
      return { url: dec.url, title: dec.title, timestamp: r.timestamp };
    });
}
function getBmDb(p, wsId) {
  return db.prepare('SELECT url,title,timestamp FROM bookmarks WHERE user_pseudo=? AND workspace_id=? ORDER BY timestamp DESC').all(p, wsId)
    .map(r => {
      const dec = vaultDecRow('bookmarks', { user_pseudo: p, workspace_id: wsId, url: r.url, title: r.title }, p);
      return { url: dec.url, title: dec.title, timestamp: r.timestamp };
    });
}
// Match a plaintext URL against a workspace's stored bookmarks. SQL cannot do
// it (url is ciphertext), so the rows are decrypted and compared in memory —
// and because the AAD binds user + workspace, a bookmark moved in from another
// workspace or account fails authentication instead of matching.
function findBookmarkId(p, wsId, url) {
  if (!stmt.bookmarkFind) return null;
  for (const r of stmt.bookmarkFind.all(p, wsId)) {
    const dec = vaultDecRow('bookmarks', { id: r.id, user_pseudo: p, workspace_id: wsId, url: r.url }, p);
    if (dec.url === url) return r.id;
  }
  return null;
}
function ensureDefaultWs(p) {
  if (getWorkspace(p, 'default')) return;
  const ws = vaultEncRow('workspaces', { id: 'default', user_pseudo: p, name: 'Default' }, p);
  if (!ws) return; // vaulted account without a key: created at the next login instead
  db.prepare('INSERT OR IGNORE INTO workspaces (id,user_pseudo,name,created,color) VALUES (?,?,?,?,?)').run('default', p, ws.name, Date.now(), '#4a8bc5');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex') };
}
function verifyPassword(password, salt, hash) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex') === hash;
}
function userExists(p) { return !!getUser(p); }
function registerUser(pseudo, password) {
  const key = pseudo.toLowerCase();
  if (userExists(key)) return false;
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (pseudo,password,salt,created,photo,active_workspace) VALUES (?,?,?,?,?,?)').run(key, hash, salt, Date.now(), null, 'default');
  // Keystore first: it exists before the account has a single row, so the
  // first login can sweep the default workspace (and anything the JSON import
  // produced) through vaultMigrate instead of leaving it in plaintext forever.
  vaultEnrollNewUser(key, password);
  ensureDefaultWs(key);
  return true;
}
// ── Duress password (panic decoy) ──
// A second password that opens a separate, believable-but-empty AEGIS account;
// the real account's rows, partitions and files are never touched. Two rules
// keep it invisible from the outside:
//   1. authenticate() always burns EXACTLY two PBKDF2 derivations — the real
//      verification plus the duress verification (or a discarded filler) — so
//      login timing can never tell an observer that a duress password exists.
//   2. A duress login does everything a real login does (same counters, same
//      notices, same screen), and every credential prompt inside the decoy
//      answers with the ordinary "Current password is incorrect."
const DECOY_MAC_KEY = 'aegis/decoy/v1';
const FILLER_SALT = 'aegis-filler-salt';
const FILLER_HASH = 'aegis-filler-hash';

function decoyKeyFor(realKey) {
  // Deterministic per account (so `register` needs no special case) but not a
  // guessable fixed suffix: it is an HMAC of the pseudonym.
  return realKey + '_' + crypto.createHmac('sha256', DECOY_MAC_KEY).update(realKey).digest('hex').slice(0, 12);
}

function authenticate(pseudo, password) {
  const key = (pseudo || '').trim().toLowerCase();
  const user = getUser(key);
  const hasDuress = !!(user && user.duress_password);
  // Derivation 1: the real password — or a discarded filler when no such
  // account exists, so a miss costs exactly what a hit costs.
  const realOk = !!user && verifyPassword(password, user.salt, user.password);
  // Derivation 2: the duress password — or a filler that verifies nothing.
  const duressOk = hasDuress && verifyPassword(password, user.duress_salt, user.duress_password);
  if (!hasDuress) verifyPassword(password, FILLER_SALT, FILLER_HASH);
  return { key, user, real: realOk, duress: duressOk };
}

// The decoy account is created the first time the duress password is used,
// with an unguessable random password: nobody can walk back into it except
// through the duress password itself.
function ensureDecoyUser(realKey) {
  const owner = getUser(realKey);
  let key = owner && owner.duress_decoy_key;
  if (!key) {
    const base = decoyKeyFor(realKey);
    key = base;
    // If the derived name is already taken by a registered account, step aside
    // instead of hijacking it (and remember the name we settled on).
    for (let n = 1; getUser(key); n++) key = base + '_' + n;
    try { db.prepare('UPDATE users SET duress_decoy_key=? WHERE pseudo=?').run(key, realKey); } catch (e) {}
  }
  if (!getUser(key)) {
    const { salt, hash } = hashPassword(crypto.randomBytes(24).toString('hex'));
    db.prepare('INSERT INTO users (pseudo,password,salt,created,photo,active_workspace) VALUES (?,?,?,?,?,?)').run(key, hash, salt, Date.now(), null, 'default');
    ensureDefaultWs(key);
  } else {
    ensureDefaultWs(key);
  }
  return key;
}

function loginUser(pseudo, password) {
  const a = authenticate(pseudo, password);
  if (!a.user) return false;
  if (a.real) {
    // Third KDF of this attempt (authenticate() already burned two): unwrap
    // the account's envelope key, or enrol a legacy account and sweep it.
    try {
      vaultActivateForLogin(a.key, password);
    } catch (err) {
      // The password was CORRECT — this is a damaged/tampered keystore, not a
      // failed attempt: it must not count toward the 3-strikes wipe.
      console.error('vault: unlock failed for ' + a.key + ':', err && err.message);
      vaultDeactivate();
      return { vaultError: 'Your encrypted data could not be unlocked. The profile may be damaged; only a restored copy of ghostview.db can recover it.' };
    }
    currentUser = a.key;
    decoyOwnerPseudo = null;
  } else if (a.duress) {
    // Duress login: same side effects as a real one, different account — and
    // the decoy account deliberately has NO keystore (duress derives no key),
    // so it stores and shows plain data exactly like any ordinary profile.
    // burnKdf() spends the same PBKDF2 the real branch just spent, so login
    // timing still cannot distinguish the two.
    vault.burnKdf(password);
    vaultDeactivate();
    currentUser = ensureDecoyUser(a.key);
    decoyOwnerPseudo = a.key;
  } else {
    return false;
  }
  // Show the name the user typed — never the decoy's derived key.
  currentUserLabel = (pseudo || '').trim() || a.key;
  ensureDefaultWs(currentUser);
  resetIdleTimer();
  startAnalyticsForUser();
  return true;
}

// ── Icon / Menu ──

function findIcon() {
  const exts = ['.png','.ico','.jpg','.jpeg'];
  const dirs = [__dirname, path.join(__dirname, 'assets')];
  for (const d of dirs) for (const e of exts) { const p = path.join(d, 'logo'+e); if (fs.existsSync(p)) return p; }
  return null;
}

// ── Nav-less modal windows ──
// The AEGIS / Workspaces menu bar is application-wide: setApplicationMenu()
// re-applies it to every window, including the modal parameter helpers. Those
// windows must show NO application navigation (the QUIT button inside the page
// is their only control), so they are stripped here and re-stripped after every
// menu rebuild.
const navlessWindows = new Set();
function stripWindowNav(win) {
  if (!win || win.isDestroyed()) return;
  if (!navlessWindows.has(win)) {
    navlessWindows.add(win);
    win.once('closed', () => navlessWindows.delete(win));
  }
  try { win.setMenu(null); } catch (e) {}
  try { win.setAutoHideMenuBar(true); win.setMenuBarVisibility(false); } catch (e) {}
}
function restripWindowNavs() {
  for (const w of Array.from(navlessWindows)) {
    if (w.isDestroyed()) navlessWindows.delete(w);
    else stripWindowNav(w);
  }
}

function buildMenu() {
  if (!currentUser) { Menu.setApplicationMenu(null); return; }
  const user = getUser(currentUser);
  if (!user) { Menu.setApplicationMenu(null); return; }
  const wss = getWorkspaces(currentUser);
  if (!wss.length) { Menu.setApplicationMenu(null); return; }
  const active = currentWorkspace || user.active_workspace || 'default';

  const splitItems = [];
  if (splitMode) {
    splitItems.push({ label: 'Exit Split View', click: () => exitSplitMode() });
  } else {
    const others = wss.filter(w => w.id !== active && !isGhostWs(w.id)); // Ghost: no split
    if (others.length > 0) {
      splitItems.push({ label: 'Split with:', enabled: false });
      others.forEach(w => {
        splitItems.push({ label: w.name, click: () => enterSplitMode(w.id) });
      });
    } else {
      splitItems.push({ label: 'Need 2+ workspaces', enabled: false });
    }
  }

  const ghostMenu = {
    label: 'AEGIS', submenu: [
      { label: 'Return to Workspaces', click: () => { saveUserTabsPersist(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-workspaces'); } },
      { label: 'Return to Login', click: () => { saveUserTabsPersist(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-login'); } },
      { type: 'separator' },
      { label: 'AEGIS Parameters', click: () => openParameters() },
      { label: 'Youtube Download parameters', click: () => openYtParams() },
      { type: 'separator' },
      { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => toggleDownloads() },
      { type: 'separator' },
      { label: 'Take Notes', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-notes'); } },
      { type: 'separator' },
      { label: 'Split', submenu: splitItems },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Escape', click: () => confirmQuit() },
    ],
  };
  const wsMenu = { label: 'Workspaces', submenu: [] };
  // Ghost Workspace first — same order as the workspace screen.
  wsMenu.submenu.push({
    label: GHOST_WS_NAME, type: 'checkbox', checked: active === GHOST_WS_ID,
    click: () => { if (active !== GHOST_WS_ID) switchWorkspace(GHOST_WS_ID); },
  });
  wss.forEach(w => {
    wsMenu.submenu.push({
      label: w.name, type: 'checkbox', checked: w.id === active,
      click: () => { if (w.id !== active) switchWorkspace(w.id); },
    });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([ghostMenu, wsMenu]));
  // The AEGIS/Workspaces menus must stay visible in fullscreen mode too:
  // Chromium auto-hides the menu bar whenever a fullscreen window receives a
  // new application menu (login, workspace switch, F11, restore…), so force it
  // back on every rebuild.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setAutoHideMenuBar(false); mainWindow.setMenuBarVisibility(true); } catch (e) {}
  }
  // …but never for the parameter windows: they carry no AEGIS/Workspaces nav.
  restripWindowNavs();
}

// ── Window ──

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 600, minHeight: 400, fullscreen: true,
    title: 'AEGIS', backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
      webviewTag: false,
    },
  });
  mainWindow.loadFile('login.html');
  mainWindow.webContents.on('context-menu', (e, params) => {
    const t = [];
    if (params.editFlags.canCut && params.selectionText) t.push({ label:'Cut', role:'cut' });
    if (params.editFlags.canCopy && params.selectionText) t.push({ label:'Copy', role:'copy' });
    if (params.editFlags.canPaste) t.push({ label:'Paste', role:'paste' });
    if (t.length) t.push({ type:'separator' });
    t.push({ label:'Select All', role:'selectAll' });
    Menu.buildFromTemplate(t).popup({ window: mainWindow });
  });
  // Rebuild FIRST, then re-assert visibility: setApplicationMenu() on a
  // fullscreen window re-hides the menu bar, so visibility must be the last
  // step (buildMenu() also forces it, this covers the pre-login null menu).
  // Entering fullscreen: Chromium finishes hiding the menu bar WHILE the
  // transition runs — i.e. after this event fires — so the AEGIS/Workspaces
  // menus vanished on every normal fullscreen entry (only a menu built while
  // already settled in fullscreen, like at startup, survived). Rebuild the
  // menu and force it visible again once the transition has settled.
  const reassertMenuInFs = () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) {
      buildMenu();
      try { mainWindow.setAutoHideMenuBar(false); mainWindow.setMenuBarVisibility(true); } catch (e) {}
    }
  };
  mainWindow.on('enter-full-screen', () => { if (!mainWindow.isDestroyed()) { buildMenu(); try { mainWindow.setMenuBarVisibility(true); } catch (e) {} setTimeout(reassertMenuInFs, 150); setTimeout(reassertMenuInFs, 500); mainWindow.webContents.send('fs-change', true); syncViews(); } });
  mainWindow.on('leave-full-screen', () => { if (!mainWindow.isDestroyed()) { mainWindow.setMenuBarVisibility(true); setTimeout(() => { if (!mainWindow.isDestroyed()) { buildMenu(); mainWindow.setMenuBarVisibility(true); } }, 200); mainWindow.webContents.send('fs-change', false); syncViews(); } });
  mainWindow.on('minimize', () => { if (!mainWindow.isDestroyed()) mainWindow.setMenuBarVisibility(true); });
  mainWindow.on('restore', () => { if (!mainWindow.isDestroyed()) { buildMenu(); mainWindow.setMenuBarVisibility(true); } });
  mainWindow.on('focus', () => { windowFocusedAt = Date.now(); });
  mainWindow.on('blur', () => { endCurrentVisit(); if (sessionStartTime) endSession(); });
  setupF11Handler(mainWindow.webContents);
  // Chrome page change (login ⇄ browser): never leave a stale dropdown floating
  // (bump the seq so an open stuck awaiting first load can't re-show afterwards),
  // and warm the overlay view so the first suggestion dropdown appears instantly.
  mainWindow.webContents.on('did-navigate', () => {
    suggestOverlaySeq++;
    hideSuggestOverlayView();
    try { ensureSuggestOverlayView(); } catch (err) {}
    // Never leave the floating quality popover behind across login ⇄ browser.
    ytOverlaySeq++;
    hideYtOverlayView();
  });
}

// ── Tab Management ──

function contentBounds() {
  const b = mainWindow.getBounds();
  const pw = panelOpen ? PANEL_WIDTH : 0;
  const top = TOP + suggestHeight;
  return { x: 0, y: top, width: b.width - pw, height: Math.max(50, b.height - top - BOTTOM - shelfReserve) };
}

// ── Aegis Shield: webPreferences for every CONTENT view (page tabs) ──
// Sandboxed like before, but the fingerprint randomizer preload must patch
// the page's own JavaScript world, which requires contextIsolation: false
// (the main chrome window keeps its own hardened preferences: contextIsolation
// true + preload.js). nodeIntegrationInSubFrames runs the same sandboxed
// preload in iframes too — tracker iframes are a prime canvas-fingerprinting
// vector — and the sandbox keeps Node out of them; the preload exposes
// nothing to the page either way.
function contentWebPreferences(partition) {
  return {
    sandbox: true, spellcheck: false, partition,
    disableHtmlFullscreenWindowResize: false, backgroundThrottling: false,
    contextIsolation: false,
    preload: path.join(__dirname, 'fp-preload.js'),
    nodeIntegrationInSubFrames: true,
  };
}
const permCache = {};

// ── Silent-allow list ─────────────────────────────────────────────────────────
// These permissions are granted immediately at BOTH levels (request and check)
// so no dialog is ever built for them: 'persistent-storage' (OPFS /
// navigator.storage.persist()) and 'clipboard-sanitized-write' — the sanitized
// async clipboard WRITE half only (navigator.clipboard.writeText()); read
// access is the separate 'clipboard-read' permission and is NOT listed.
// KEEP THIS LIST MINIMAL: camera, microphone, geolocation, notifications,
// screen sharing and every other permission keep their existing dialog/deny
// policy below. The identifiers are exactly what Electron 35 hands these
// handlers (observed live from ChatGPT's permission requests).
const AUTO_APPROVED_PERMISSIONS = new Set(['persistent-storage', 'clipboard-sanitized-write']);

function setupSession(ses, wsId) {
  if (ses._configured) return;
  ses._configured = true;
  // Every content session speaks the plain Chrome UA (see BROWSER_USER_AGENT):
  // Google/Apple sign-in endpoints reject Electron's default string with
  // "This browser or app may not be secure". Sessions inherit app.userAgentFallback
  // too, but setting it here makes the guarantee explicit for partitions that
  // were created before the fallback was assigned.
  try { ses.setUserAgent(BROWSER_USER_AGENT); } catch (e) {}
  // Aegis Shield local request engine: one listener for every http(s)/ws(s)
  // request. Blocks are cancelled BEFORE the socket opens (domain trie from
  // shield-list.txt + shield-custom.txt), GET navigations are redirected to
  // the same URL minus tracking parameters, and both are toggleable live from
  // Settings → Aegis Shield. Never throws, so a shield bug cannot break loads.
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    let result;
    try { result = shield.handleRequest(details); } catch (e) { result = {}; }
    callback(result || {});
  });
  // Check-level gate: geolocation is always refused, so navigator.permissions
  // reports it as 'denied' and no code path can opt into the OS location
  // service. Every other permission is returned exactly as Electron's own
  // default would (granted, except deprecated-sync-clipboard-read), so this
  // handler changes nothing but geolocation.
  ses.setPermissionCheckHandler((wc, perm) => {
    if (perm === 'geolocation') return false;
    // Auto-approved permissions answer 'granted' on every check pathway too
    // (navigator.permissions.query, navigator.storage.persisted(), clipboard
    // probes), so no code path can see a different answer than the request
    // handler below gives.
    if (AUTO_APPROVED_PERMISSIONS.has(perm)) return true;
    return perm !== 'deprecated-sync-clipboard-read';
  });
  ses.setPermissionRequestHandler((wc, perm, cb) => {
    // Geolocation is auto-refused before the cache and before the dialog:
    // a previously allowed site cannot re-enable it and no popup is ever shown.
    if (perm === 'geolocation') return cb(false);
    // Silent allow-list: answered right here — never cached (a future policy
    // change must not be masked by a stale entry) and never dialoged.
    if (AUTO_APPROVED_PERMISSIONS.has(perm)) return cb(true);
    const key = wsId + ':' + new URL(wc.getURL() || 'http://localhost').hostname + ':' + perm;
    if (permCache[key] !== undefined) return cb(permCache[key]);
    if (!mainWindow || mainWindow.isDestroyed()) return cb(false);
    dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['Allow', 'Deny'], defaultId: 1, title: 'Permission Request', message: `The site is requesting permission for: ${perm}` }).then(r => { permCache[key] = r.response === 0; cb(r.response === 0); });
  });
  ses.on('will-download', (e, item) => handleDownload(item, wsId));
}

function safeLoadURL(wc, url) {
  const u = (url || '').trim();
  if (!u || u === 'about:blank') return false;
  try { wc.loadURL(u); return true; }
  catch(e) {
    try { wc.loadURL('https://www.google.com'); return true; }
    catch(e2) { return false; }
  }
}

// ── window.open() router: linked OAuth popups vs. ordinary new tabs ──────────
// Third-party "Continue with Google / Apple / Microsoft" buttons start the
// handshake with window.open() and expect a LINKED window back: the callback
// page posts the result to window.opener and then window.close()s itself.
// AEGIS used to turn every window.open() into an independent tab, which drops
// window.opener — the message never arrives, the site thinks the popup was
// blocked and starts over: the infinite auth loop.
//
// Everything oauth.isOAuthUrl()/isBlankPopupUrl() recognises is therefore
// ALLOWED as a real child window: Electron keeps window.opener alive (verified:
// opener is a live Window object) and the popup inherits this tab's
// webPreferences verbatim — same session partition, same cookies, same
// localStorage as the tab that started the login (verified: popup session ===
// session.fromPartition(tabPartition)). window.close() inside such a popup
// destroys only the popup (verified), so well-behaved sites close themselves;
// watchLinkedPopup() covers the rest by closing it when it returns to the
// origin that opened it. Everything else keeps the old new-tab behaviour.
function watchLinkedPopup(openerWc) {
  if (openerWc._aegisPopupWatch) return;
  openerWc._aegisPopupWatch = true;

  openerWc.on('did-create-window', (win) => {
    // ── linked-popup bookkeeping ────────────────────────────────────────────
    // Two goals pull in opposite directions:
    //   • window.open() must NEVER come back null (a null is what makes a site
    //     raise "We couldn't open the sign-in window. Check your popup
    //     blocker…"), so repeats are allowed through;
    //   • a genuine retry loop must not stack login windows forever.
    // A twin is retired only when it is BOTH stale (≥1.5 s old) AND still
    // sitting on the URL it was opened with — i.e. it never went anywhere, so
    // nothing can be lost by closing it. A popup that has already moved on
    // (about:blank → auth.openai.com → accounts.google.com) is a login in
    // progress and is never touched.
    let created = '';
    try { created = win.webContents.getURL(); } catch (e) {}
    const pendingUrl = (openerWc._aegisAuthPopup && openerWc._aegisAuthPopup.url) || '';
    const norm = (u) => {
      const s = String(u || '').trim();
      return (!s || s === 'about:blank' || /^about:blank#/.test(s)) ? 'about:blank' : s;
    };
    const key = norm(created) !== 'about:blank' ? norm(created) : norm(pendingUrl);
    const now = Date.now();
    const wins = openerWc._aegisAuthWins || (openerWc._aegisAuthWins = []);
    for (let i = wins.length - 1; i >= 0; i--) {
      const w = wins[i];
      let gone = false;
      try { gone = !w.win || w.win.isDestroyed(); } catch (e) { gone = true; }
      if (gone) { wins.splice(i, 1); continue; }
      if (w.key !== key || now - w.t < 1500) continue;
      let cur = '';
      try { cur = w.win.webContents.getURL(); } catch (e) {}
      if (norm(cur) === w.key) { // never went anywhere → safe to retire
        try { w.win.close(); } catch (e) {}
        wins.splice(i, 1);
      }
    }
    wins.push({ key, t: now, win });
    while (wins.length > 8) wins.shift();

    // Where must the popup come back to for the handshake to be considered
    // finished? The origin of the page that called window.open().
    let openerOrigin = '';
    try { openerOrigin = new URL(openerWc.getURL()).origin; } catch (e) {}
    if (!openerOrigin || openerOrigin === 'null') return; // about:blank/file → no auto-close rule

    const wc = win.webContents;
    let closeTimer = null;
    const closePopup = () => {
      closeTimer = null;
      try { if (!win.isDestroyed()) win.close(); } catch (e) {}
      try { if (!openerWc.isDestroyed()) openerWc.focus(); } catch (e) {}
    };
    const scheduleClose = () => { if (!closeTimer) closeTimer = setTimeout(closePopup, 1500); };
    const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };
    const checkReturn = () => {
      if (win.isDestroyed()) return;
      let origin = '';
      try { origin = new URL(wc.getURL()).origin; } catch (e) { return; }
      if (origin === openerOrigin) scheduleClose(); // callback delivered → close
      else cancelClose();                           // still handshaking (or user backed out)
    };
    wc.on('did-navigate', checkReturn);
    wc.on('did-finish-load', checkReturn);
    win.on('closed', cancelClose);
    openerWc.once('destroyed', () => { cancelClose(); try { if (!win.isDestroyed()) win.close(); } catch (e) {} });

    // AEGIS runs fullscreen: make sure the login window is actually visible
    // instead of sitting behind the main window.
    try { win.show(); win.moveTop(); win.focus(); } catch (e) {}
  });
}

function handleWindowOpen(openerWc, details) {
  const url = (details && details.url) || '';

  // Anything that is unambiguously a WINDOW request gets a real window:
  // an identity handshake, a blank placeholder the site will navigate itself,
  // or an explicit popup size/position from the page.
  const wantsWindow = oauth.isBlankPopupUrl(url) || oauth.isOAuthUrl(url) ||
    oauth.isPopupWindowRequest(details && details.features);

  if (wantsWindow) {
    const now = Date.now();

    // A retry of the identical request must STILL return a real window: sites
    // check the result of window.open() and raise
    //   "We couldn't open the sign-in window. Check your popup blocker…"
    // the moment it comes back null. So this path never denies — window.open()
    // is answered exactly the way Chrome answers it. Window bookkeeping for
    // retiring a stale twin lives in watchLinkedPopup()'s did-create-window,
    // where the actual window (and whether it has gone anywhere) is known.
    openerWc._aegisAuthPopup = { url, t: now };

    let alive = false;
    try { alive = !openerWc.isDestroyed(); } catch (e) {}
    if (alive) {
      watchLinkedPopup(openerWc);
      return {
        action: 'allow',
        // webPreferences is deliberately NOT overridden: the popup must inherit
        // the opener's partition + preload so the auth cookies/localStorage are
        // shared with the tab that started the login.
        overrideBrowserWindowOptions: {
          width: 520, height: 760, minWidth: 380, minHeight: 480,
          autoHideMenuBar: true,
        },
      };
    }
    // Opener already gone: a linked window is impossible, fall back to a tab.
    addTab(url);
    return { action: 'deny' };
  }

  // Ordinary popup → a normal AEGIS tab. The page is told "null", which is
  // also what Chrome does for a blocked popup; if a site ever complains about
  // its popup being blocked, this line names the URL it was refused.
  console.log('[aegis] window.open -> new tab (page sees null): ' + url);
  addTab(url);
  return { action: 'deny' };
}

function addTab(url, partition, silent) {
  // partition may be omitted; silent may be passed as 2nd arg (boolean)
  if (typeof partition === 'boolean') { silent = partition; partition = undefined; }
  const tabs = currentTabs();
  const id = idCounter++;
  const wsPartition = partition || (currentWorkspace ? partitionFor(currentWorkspace) : undefined);
  if (wsPartition) usedPartitions.add(wsPartition);
  const view = new WebContentsView({
    webPreferences: contentWebPreferences(wsPartition),
  });

  const ses = view.webContents.session;
  const wsId = currentWorkspace;
  setupSession(ses, wsId);

  view.setBounds(contentBounds());
  safeLoadURL(view.webContents, url);
  setupF11Handler(view.webContents);
  const emit = (event, extra) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, { id, title: view.webContents.getTitle(), url: view.webContents.getURL(), ws: wsId, ...extra });
  };
  function emitNav() { emit('nav-state', { canGoBack: view.webContents.navigationHistory.canGoBack(), canGoForward: view.webContents.navigationHistory.canGoForward(), ws: wsId }); }

  function updatePlayingTabMeta() {
    if (playingTabs.has(id)) {
      // Spread the existing entry: it also carries workspaceId, which the
      // "jump to the playing workspace" pill depends on.
      playingTabs.set(id, { ...playingTabs.get(id), title: view.webContents.getTitle(), url: view.webContents.getURL() });
      broadcastMediaState();
    }
  }
  view.webContents.on('page-title-updated', (e, t) => { emit('tab-updated', { title: t, ws: wsId }); updatePlayingTabMeta(); scheduleTabSave(); });
  view.webContents.on('page-favicon-updated', (e, favicons) => { if (favicons && favicons.length > 0) { const tab = tabs.find(t => t.id === id); if (tab) tab.favicon = favicons[0]; emit('tab-updated', { favicon: favicons[0], ws: wsId }); } });
  function resetFavicon() { const tab = tabs.find(t => t.id === id); if (tab) tab.favicon = ''; }
  view.webContents.on('did-navigate', (e, u) => { resetFavicon(); emit('tab-updated', { url: u, favicon: '', ws: wsId }); emitNav(); addHistory(u, view.webContents.getTitle(), wsId); scheduleTabSave(); if (u && u !== 'about:blank') { ensureSession(); recordVisitStart(id, u, view.webContents.getTitle(), wsId); } });
  view.webContents.on('did-navigate-in-page', (e, u) => { if (e.isMainFrame) { resetFavicon(); emit('tab-updated', { url: u, favicon: '', ws: wsId }); emitNav(); addHistory(u, view.webContents.getTitle(), wsId); scheduleTabSave(); if (u && u !== 'about:blank') { ensureSession(); recordVisitStart(id, u, view.webContents.getTitle(), wsId); } } });
  view.webContents.on('did-start-loading', () => emit('tab-loading', { loading: true }));
  view.webContents.on('did-stop-loading', () => { emit('tab-loading', { loading: false }); emitNav(); });
  view.webContents.on('update-target-url', (e, u) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status-url', u || ''); });
  view.webContents.on('found-in-page', (e, result) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('find-result', result); });

  view.webContents.on('media-started-playing', () => {
    playingTabs.set(id, { title: view.webContents.getTitle(), url: view.webContents.getURL(), workspaceId: wsId });
    updatePowerSaveBlocker();
    broadcastMediaState();
  });
  view.webContents.on('media-paused', () => {
    playingTabs.delete(id);
    updatePowerSaveBlocker();
    broadcastMediaState();
  });

  // YouTube fullscreen support
  view.webContents.on('enter-html-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('html-fullscreen', true);
      view.setBounds({ x: 0, y: 0, width: mainWindow.getBounds().width, height: mainWindow.getBounds().height });
    }
  });
  view.webContents.on('leave-html-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('html-fullscreen', false);
      syncViews();
    }
  });

  // OAuth/SSO targets become linked popups (window.opener + shared session),
  // everything else opens in a new tab — see handleWindowOpen().
  view.webContents.setWindowOpenHandler((details) => handleWindowOpen(view.webContents, details));

  setupContextMenu(view.webContents);

  tabs.push({ id, view, url, title: '', favicon: '' });
  setCurrentTabs(tabs);
  // Newly created tab becomes active immediately (content + highlight + URL bar)
  setActiveId(currentWorkspace, id);
  if (silent) return id;
  syncViews();
  broadcastTabs();
  emitTabActivated(currentWorkspace, id);
  saveUserTabsPersist();
  return id;
}

// Restore all tabs for a workspace from DB in original order, landing on the
// previously active tab. silent=true skips per-tab saves (single save at end).
function restoreWorkspaceFromDb(wsId, opts) {
  const silent = !(opts && opts.save === true);
  const shouldShow = (opts && opts.show) || wsId === currentWorkspace;
  const saved = getTabsDb(currentUser, wsId);
  const state = getWorkspaceState(currentUser, wsId);
  workspaceTabs[wsId] = [];
  if (!saved || saved.length === 0) {
    const prev = currentWorkspace;
    currentWorkspace = wsId;
    const id = addTab('https://www.google.com', undefined, true);
    setActiveId(wsId, id);
    currentWorkspace = prev;
    if (shouldShow) {
      const p2 = currentWorkspace;
      currentWorkspace = wsId;
      syncViews();
      broadcastTabs();
      emitTabActivated(wsId, id);
      currentWorkspace = p2;
      if (p2 !== wsId) syncViews();
    }
    if (!silent) saveUserTabsPersist();
    return id;
  }
  const prev = currentWorkspace;
  currentWorkspace = wsId;
  const createdIds = [];
  saved.forEach(s => {
    if (!s.url) return;
    createdIds.push(addTab(s.url, undefined, true));
  });
  // Pick active: saved active_url / active_index, fallback to first
  let activeIdx = 0;
  if (state) {
    if (typeof state.active_index === 'number' && state.active_index >= 0 && state.active_index < createdIds.length) {
      activeIdx = state.active_index;
    }
    if (state.active_url) {
      const byUrl = saved.findIndex(s => s.url === state.active_url);
      if (byUrl >= 0 && byUrl < createdIds.length) activeIdx = byUrl;
    }
  }
  const activeId = createdIds[activeIdx] != null ? createdIds[activeIdx] : createdIds[0];
  setActiveId(wsId, activeId);
  currentWorkspace = prev;
  if (shouldShow) {
    const p2 = currentWorkspace;
    currentWorkspace = wsId;
    syncViews();
    broadcastTabs();
    emitTabActivated(wsId, activeId);
    currentWorkspace = p2;
    if (p2 !== wsId) syncViews();
  }
  if (!silent) saveUserTabsPersist();
  return activeId;
}

// Preload every other workspace in the background so switching later is
// instant (pages already loaded, cookies/session already warm — no reload flash).
function preloadOtherWorkspacesInBackground() {
  if (!currentUser) return;
  try {
    const all = getWorkspaces(currentUser).map(w => w.id);
    const others = all.filter(id => id !== currentWorkspace && !workspaceTabs[id]);
    others.forEach((wsId, i) => {
      setTimeout(() => {
        if (!currentUser || workspaceTabs[wsId]) return;
        try { restoreWorkspaceFromDb(wsId, {}); } catch(e) {}
      }, 900 + i * 600);
    });
  } catch(e) {}
}

function addHistory(url, title, wsId) {
  const id = wsId || currentWorkspace;
  if (!currentUser || !id || !url || url === 'about:blank') return;
  if (isGhostWs(id)) return; // Ghost Workspace: no history rows, ever
  const enc = vaultEncRow('history', { user_pseudo: currentUser, workspace_id: id, url, title: title || url }, currentUser);
  if (!enc) return;
  stmt.historyInsert.run(enc.user_pseudo, enc.workspace_id, enc.url, enc.title, Date.now());
}

function snapshotTabsForWs(wsId, tabs) {
  // Build a clean snapshot: never overwrite a good saved URL with about:blank / empty
  // (happens when save races a fresh addTab before load commits).
  const list = (tabs || []).map(t => {
    let liveUrl = '';
    let liveTitle = '';
    try { liveUrl = t.view.webContents.getURL() || ''; } catch(e) { liveUrl = ''; }
    try { liveTitle = t.view.webContents.getTitle() || ''; } catch(e) { liveTitle = ''; }
    const fallbackUrl = t.url || '';
    const url = (liveUrl && liveUrl !== 'about:blank') ? liveUrl : fallbackUrl;
    if (!url) return null;
    return { url, title: liveTitle || t.title || url };
  }).filter(Boolean);
  return list;
}

function saveUserTabsPersist() {
  if (!currentUser || !db) return;
  try {
    for (const [wsId, tabs] of Object.entries(workspaceTabs)) {
      if (!tabs || tabs.length === 0) continue;
      const list = snapshotTabsForWs(wsId, tabs);
      if (list.length === 0) continue;
      // Active tab: index + URL so restore lands on the same page, same order
      const activeId = getActiveId(wsId);
      let activeIndex = list.length > 0 ? 0 : 0;
      let activeUrl = list[0] ? list[0].url : null;
      if (activeId != null) {
        const liveActive = tabs.find(t => t.id === activeId);
        if (liveActive) {
          let u = '';
          try { u = liveActive.view.webContents.getURL() || liveActive.url || ''; } catch(e) { u = liveActive.url || ''; }
          if (u && u !== 'about:blank') {
            activeUrl = u;
            const idx = list.findIndex(x => x.url === u);
            activeIndex = idx >= 0 ? idx : 0;
          } else {
            const idx = tabs.indexOf(liveActive);
            activeIndex = Math.max(0, Math.min(idx, list.length - 1));
            activeUrl = list[activeIndex] ? list[activeIndex].url : activeUrl;
          }
        }
      }
      saveTabsDb(currentUser, wsId, list, activeUrl, activeIndex);
    }
  } catch(e) { console.error('saveUserTabsPersist error:', e); }
}

let tabSaveDebounce = null;
function scheduleTabSave() {
  if (tabSaveDebounce) clearTimeout(tabSaveDebounce);
  tabSaveDebounce = setTimeout(() => { tabSaveDebounce = null; saveUserTabsPersist(); }, 1200);
}

function getAutoCloseSeconds() {
  if (!currentUser) return null;
  const u = getUser(currentUser);
  if (!u) return null;
  if (u.auto_close === 0) return null;
  const secs = Number(u.auto_close_seconds) || DEFAULT_AUTO_CLOSE_SECONDS;
  return secs > 0 ? secs : DEFAULT_AUTO_CLOSE_SECONDS;
}

function resetIdleTimer() {
  if (idleTimeout) clearTimeout(idleTimeout);
  idleTimeout = null;
  if (!currentUser) return;
  const secs = getAutoCloseSeconds();
  if (!secs) return;
  idleTimeout = setTimeout(() => {
    if (!currentUser) return;
    saveUserTabsPersist();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-login');
  }, secs * 1000);
}

function showTab(id) {
  recordTabSwitch();
  setActiveId(currentWorkspace, id);
  syncViews();
  const tab = getActiveTab(currentWorkspace);
  if (tab && mainWindow && !mainWindow.isDestroyed()) {
    const u = tab.view.webContents.getURL();
    mainWindow.webContents.send('tab-activated', { id, url: u, title: tab.view.webContents.getTitle(), favicon: tab.favicon || '', ws: currentWorkspace });
    if (u && u !== 'about:blank') { ensureSession(); recordVisitStart(id, u, tab.view.webContents.getTitle(), currentWorkspace); }
  }
}

function closeTab(id) {
  const tabs = currentTabs();
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  try { mainWindow.contentView.removeChildView(tab.view); } catch(e) {}
  tab.view.webContents.close();
  playingTabs.delete(id);
  updatePowerSaveBlocker();
  broadcastMediaState();
  const wasActive = getActiveId(currentWorkspace) === id;
  tabs.splice(idx, 1);
  setCurrentTabs(tabs);
  if (wasActive) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    setActiveId(currentWorkspace, next.id);
  }
  syncViews();
  broadcastTabs();
  // New active (next neighbour) takes over immediately
  if (wasActive) emitTabActivated(currentWorkspace, getActiveId(currentWorkspace));
  saveUserTabsPersist();
}

function broadcastTabs() {
  const tabs = currentTabs();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tabs-list', { ws: currentWorkspace, activeId: getActiveId(currentWorkspace), tabs: tabs.map(t => {
    let u = ''; try { u = t.view.webContents.getURL(); } catch(e) { u = t.url || ''; }
    let ti = ''; try { ti = t.view.webContents.getTitle(); } catch(e) { ti = t.title || ''; }
    return { id: t.id, url: u || t.url || '', title: ti || t.title || '', favicon: t.favicon || '' };
  }) });
}

function emitTabActivated(wsId, id) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tabs = workspaceTabs[wsId] || [];
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  let u = ''; let ti = '';
  try { u = tab.view.webContents.getURL(); } catch(e) { u = tab.url || ''; }
  try { ti = tab.view.webContents.getTitle(); } catch(e) { ti = tab.title || ''; }
  mainWindow.webContents.send('tab-activated', { id, url: u || tab.url || '', title: ti || tab.title || '', favicon: tab.favicon || '', ws: wsId });
}

function activeTab() { return getActiveTab(currentWorkspace); }

function hideAllViews() {
  removeShownViews();
}

function showActiveView() { syncViews(); }

function openBrowser(workspaceId) {
  const user = getUser(currentUser);
  if (!user) return;
  ensureDefaultWs(currentUser);
  downloadsByWs = {};
  dlItemsMap = {};
  deletedDlSavePaths.clear();
  deletedDlIds.clear();
  downloadIdCounter = 0;
  const enteringGhost = isGhostWs(workspaceId) && !workspaceTabs[GHOST_WS_ID];
  // Leaving the Ghost Workspace discards its whole in-memory session; entering
  // it fresh starts a brand-new partition so nothing previous can resurface.
  if (!isGhostWs(workspaceId) && isGhostWs(currentWorkspace)) closeGhostWorkspace();
  if (enteringGhost) ghostGeneration++;
  currentWorkspace = workspaceId || user.active_workspace || 'default';
  // The Ghost Workspace has no SQL row: never remember it as the active one.
  if (!isGhostWs(currentWorkspace)) db.prepare('UPDATE users SET active_workspace = ? WHERE pseudo = ?').run(currentWorkspace, currentUser);

  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('fs-change', mainWindow.isFullScreen());
  });
  mainWindow.loadFile('controls.html');
  buildMenu();

  if (!workspaceTabs[currentWorkspace]) {
    restoreWorkspaceFromDb(currentWorkspace, { show: true, save: false });
    syncViews();
    broadcastTabs();
    // Warm up all other workspaces so they open instantly with no reload
    preloadOtherWorkspacesInBackground();
  } else {
    syncViews();
    broadcastTabs();
  }
  resetIdleTimer();
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(saveUserTabsPersist, 30000);
  // Open any links Windows sent us before the browser was ready
  flushPendingExternalUrls();
}

async function switchWorkspace(workspaceId) {
  if (splitMode) { splitMode = false; splitLeft = null; splitRight = null; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-changed', { active: false }); }
  const prevWs = currentWorkspace;
  saveUserTabsPersist();
  hideAllViews();
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads-cleared'); } catch(e) {}
  const user = getUser(currentUser);
  if (!user) return;
  const enteringGhost = isGhostWs(workspaceId) && !workspaceTabs[GHOST_WS_ID];
  if (!isGhostWs(workspaceId) && isGhostWs(prevWs)) closeGhostWorkspace();
  if (enteringGhost) ghostGeneration++;
  currentWorkspace = workspaceId;
  // Ghost has no row to remember it in — keep the last real workspace stored.
  if (!isGhostWs(workspaceId)) db.prepare('UPDATE users SET active_workspace = ? WHERE pseudo = ?').run(workspaceId, currentUser);

  if (!workspaceTabs[workspaceId]) {
    restoreWorkspaceFromDb(workspaceId, { show: true, save: false });
    syncViews();
    broadcastTabs();
  } else {
    const tabs = workspaceTabs[workspaceId];
    if (!tabs.find(t => t.id === getActiveId(workspaceId))) {
      setActiveId(workspaceId, tabs.length > 0 ? tabs[0].id : null);
    }
    syncViews();
    broadcastTabs();
  }
  resetIdleTimer();
  buildMenu();
  const ws = getWorkspace(currentUser, workspaceId);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-switched', { id: workspaceId, name: ws ? ws.name : '', color: ws ? (ws.color || '#4a8bc5') : '#4a8bc5' });
  broadcastMediaState();
}

function destroyAllTabsForUser() {
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => {
      try { mainWindow.contentView.removeChildView(t.view); } catch(e) {}
      t.view.webContents.close();
    });
  });
  workspaceTabs = {};
  activeIdPerWorkspace = {};
  idCounter = 0;
  splitMode = false;
  splitLeft = null;
  splitRight = null;

  playingTabs.clear();
  updatePowerSaveBlocker();
  broadcastMediaState();
}

// ── Context Menu ──

function setupContextMenu(wc) {
  wc.on('context-menu', (e, params) => {
    const template = [];
    if (params.linkURL) {
      template.push({ label: 'Open Link in New Tab', click: () => addTab(params.linkURL) });
      template.push({ label: 'Open Link in New Window', click: () => shell.openExternal(params.linkURL) });
      template.push({ label: 'Save Link As…', click: () => saveUrlAs(wc, params.linkURL) });
      template.push({ label: 'Copy Link Address', click: () => { clipboard.writeText(params.linkURL); scheduleClipboardWipe(params.linkURL); } });
      template.push({ type: 'separator' });
    }
    if (params.mediaType === 'image') {
      template.push({ label: 'Open Image in New Tab', click: () => addTab(params.srcURL) });
      template.push({ label: 'Save Image As…', click: () => saveUrlAs(wc, params.srcURL) });
      template.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) });
      template.push({ label: 'Copy Image Address', click: () => { clipboard.writeText(params.srcURL); scheduleClipboardWipe(params.srcURL); } });
      template.push({ type: 'separator' });
    }
    if (params.mediaType === 'video' || params.mediaType === 'audio') {
      template.push({ label: 'Save Media As…', click: () => saveUrlAs(wc, params.srcURL) });
      template.push({ type: 'separator' });
    }
    if (params.editFlags.canCut && params.selectionText) template.push({ label:'Cut', role:'cut' });
    if (params.editFlags.canCopy && params.selectionText) template.push({ label:'Copy', role:'copy' });
    if (params.editFlags.canPaste) template.push({ label:'Paste', role:'paste' });
    if (params.editFlags.canSelectAll) template.push({ label:'Select All', role:'selectAll' });
    if (params.selectionText) {
      template.push({ type: 'separator' });
      template.push({ label: 'Search Google for "' + params.selectionText.substring(0, 30) + '"', click: () => addTab('https://www.google.com/search?q=' + encodeURIComponent(params.selectionText)) });
    }
    if (template.length) template.push({ type: 'separator' });
    template.push({ label:'Reload', role:'reload' });
    if (!wc.isDevToolsOpened()) template.push({ label:'Inspect Element', role:'toggleDevTools' });
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
}

// ── Downloads ──

let downloadsByWs = {};
let dlItemsMap = {};
let downloadIdCounter = 0;
const deletedDlSavePaths = new Set();
const deletedDlIds = new Set();
const pendingSavePaths = new Map();

function sanitizeFilename(name) {
  return name.replace(/[<>:"\/\\|?*]/g, '_').trim();
}

function filenameFromUrl(u) {
  try {
    const parsed = new URL(u);
    let name = decodeURIComponent(path.basename(parsed.pathname)) || 'download';
    if (!path.extname(name)) name += '.png';
    return sanitizeFilename(name) || 'download.png';
  } catch (e) {
    return 'download_' + Date.now() + '.png';
  }
}

async function saveUrlAs(wc, url) {
  if (!url || /^(blob:|filesystem:)/i.test(url)) return;
  let filePath;
  try {
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(getDlDir(), filenameFromUrl(url)) });
    if (r.canceled || !r.filePath) return;
    filePath = r.filePath;
  } catch (e) { return; }
  try {
    pendingSavePaths.set(url, filePath);
    wc.downloadURL(url);
  } catch (e) {
    pendingSavePaths.delete(url);
  }
}

function handleDownload(item, wsId) {
  const dlWsId = wsId || currentWorkspace || 'default';
  let name = sanitizeFilename(item.getFilename());
  if (!name) name = 'download_' + Date.now();
  const total = item.getTotalBytes();
  const url = item.getURL();
  const dlId = downloadIdCounter++;
  let savePath = path.join(getDlDir(), name);
  if (url && pendingSavePaths.has(url)) {
    savePath = pendingSavePaths.get(url);
    pendingSavePaths.delete(url);
    name = sanitizeFilename(path.basename(savePath)) || name;
  }
  if (!downloadsByWs[dlWsId]) downloadsByWs[dlWsId] = [];
  downloadsByWs[dlWsId].push({ id: dlId, name, total, received: 0, speed: 0, start: Date.now(), done: false, success: false, canceled: false, url, savePath, ws: dlWsId });
  const entry = downloadsByWs[dlWsId][downloadsByWs[dlWsId].length - 1];
  dlItemsMap[dlId] = item;

  try { item.setSavePath(savePath); } catch(e) {}

  // Announce the entry immediately so workspace-wide UIs can show it as
  // "Pending" before the first byte arrives (no waiting for 'updated').
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', {
      id: dlId, name, total, received: 0, speed: 0, start: entry.start, done: false, savePath, ws: dlWsId,
    });
  } catch(e) {}

  item.on('updated', (e, state) => {
    entry.received = item.getReceivedBytes();
    entry.speed = item.getCurrentBytesPerSecond();
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', {
        id: dlId, name, total, received: entry.received, speed: entry.speed, start: entry.start, done: false, savePath, ws: dlWsId,
      });
    } catch(e) {}
  });

  item.on('done', (e, state) => {
    delete dlItemsMap[dlId];
    entry.done = true;
    entry.success = state === 'completed';
    entry.canceled = state === 'cancelled';
    entry.received = item.getReceivedBytes();
    const actualPath = item.getSavePath() || savePath;
    entry.savePath = actualPath;
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', {
        id: dlId, name, total, received: entry.received, speed: 0, start: entry.start, done: true,
        success: entry.success, canceled: entry.canceled, savePath: actualPath, ws: dlWsId,
      });
    } catch(e) {}
    if (currentUser && !isGhostWs(dlWsId)) { // Ghost: no downloads row on disk
      try {
        const denc = vaultEncRow('downloads', { user_pseudo: currentUser, workspace_id: dlWsId, filename: name, url: url, save_path: actualPath }, currentUser);
        if (!denc) return;
        const info = db.prepare('INSERT INTO downloads (workspace_id,user_pseudo,filename,url,save_path,total_bytes,received_bytes,start_time,done,success,canceled) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
          denc.workspace_id, denc.user_pseudo, denc.filename, denc.url, denc.save_path, total, entry.received, entry.start, entry.success ? 1 : 0, entry.success ? 1 : 0, entry.canceled ? 1 : 0
        );
        entry.dbId = Number(info.lastInsertRowid);
      } catch(e) {}
    }
  });
}

// Default folder for ALL downloads. AEGIS_DOWNLOADS_DIR pins it for tests
// (and portable installs); otherwise the folder chosen in Parameters wins,
// falling back to the system Downloads folder.
function getDlDir() {
  if (process.env.AEGIS_DOWNLOADS_DIR) return process.env.AEGIS_DOWNLOADS_DIR;
  const d = dlPrefs.dlDir;
  if (d) { try { if (fs.statSync(d).isDirectory()) return d; } catch (e) {} }
  return app.getPath('downloads');
}

// Destination for YouTube downloads: an explicit folder picked by the user (in
// the popover or in Youtube Download parameters) wins; otherwise YouTube
// downloads follow the default folder from Parameters (getDlDir). AEGIS_DOWNLOADS_DIR
// still wins over everything so tests (and portable installs) stay
// deterministic, and a picked folder that no longer exists falls back.
function ytDownloadDir() {
  if (process.env.AEGIS_DOWNLOADS_DIR) return process.env.AEGIS_DOWNLOADS_DIR;
  const d = dlPrefs.ytDir;
  if (d) { try { if (fs.statSync(d).isDirectory()) return d; } catch (e) {} }
  return getDlDir();
}

function getDlsForWs(wsId) {
  const list = downloadsByWs[wsId];
  if (!list) return [];
  return list.filter(d => {
    if (deletedDlIds.has(d.id)) return false;
    if (deletedDlSavePaths.has(d.savePath)) return false;
    if (deletedDlSavePaths.has(d.savePath.replace(/\\/g, '/'))) return false;
    return true;
  }).map(d => ({
    id: d.id, name: d.name, total: d.total, received: d.received, speed: d.speed,
    start: d.start, done: d.done, success: d.success, canceled: d.canceled, url: d.url, savePath: d.savePath, ws: d.ws,
  }));
}

ipcMain.handle('get-downloads', (e, wsId) => getDlsForWs(wsId || currentWorkspace));

// Every workspace's live downloads — feeds the workspace-wide download shelf,
// which is deliberately not filtered by the active tab or workspace.
ipcMain.handle('get-all-downloads', () => {
  const out = [];
  for (const ws of Object.keys(downloadsByWs)) out.push(...getDlsForWs(ws));
  return out;
});

ipcMain.handle('get-downloads-history', (e, wsId) => {
  const id = wsId || currentWorkspace;
  if (!currentUser || !id) return [];
  try {
    // SELECT * carries user_pseudo + workspace_id, so the AAD is complete and
    // the (plaintext) id stays available for the delete handlers.
    return db.prepare('SELECT * FROM downloads WHERE user_pseudo=? AND workspace_id=? ORDER BY start_time DESC LIMIT 200').all(currentUser, id)
      .map(r => vaultDecRow('downloads', r, currentUser))
      .filter(row => {
        if (deletedDlIds.has(row.id)) return false;
        if (deletedDlSavePaths.has(row.save_path)) return false;
        if (row.save_path && deletedDlSavePaths.has(row.save_path.replace(/\\/g, '/'))) return false;
        return true;
      });
  } catch(e) { return []; }
});

ipcMain.handle('get-download-dir', () => getDlDir());

// YouTube popover: report the folder the next download will be saved to.
ipcMain.handle('yt-download-dir', () => ytDownloadDir());

// Shared native folder picker. Returns the chosen path, or null when cancelled,
// when there is no window to own the dialog — or when AEGIS_DOWNLOADS_DIR pins
// the folder: a pinned mode must never open a dialog that could not change
// where files actually land (automated runs rely on this).
async function pickDirDialog() {
  if (process.env.AEGIS_DOWNLOADS_DIR) return null;
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  let r;
  try {
    r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where to save downloads',
      defaultPath: ytDownloadDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
  } catch (e) { return null; }
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  return r.filePaths[0];
}

// YouTube popover "Change": pick AND apply immediately (the popover row has no
// Save step — the row itself is the confirmation).
ipcMain.handle('yt-pick-dir', async () => {
  const dir = await pickDirDialog();
  if (!dir) return null;
  dlPrefs.ytDir = dir;
  saveDlPrefs();
  return dir;
});

// ── AEGIS menu → Parameters → default download folder ──
// One folder for every download; YouTube downloads follow it too, unless the
// user chose a dedicated folder in Youtube Download parameters (ytDir).
ipcMain.handle('dl-params', () => ({
  dir: getDlDir(),
  pinned: !!process.env.AEGIS_DOWNLOADS_DIR,
}));

ipcMain.handle('set-download-dir', (e, dir) => {
  if (process.env.AEGIS_DOWNLOADS_DIR) {
    return { ok: false, pinned: true, error: 'This folder is fixed by AEGIS_DOWNLOADS_DIR and cannot be changed here.' };
  }
  const d = String(dir || '').trim();
  if (!d) return { ok: false, error: 'Choose a folder first.' };
  try { if (!fs.statSync(d).isDirectory()) throw new Error('not a directory'); }
  catch (err) { return { ok: false, error: 'That folder does not exist.' }; }
  dlPrefs.dlDir = d;
  saveDlPrefs();
  return { ok: true, dir: getDlDir() };
});

// ── AEGIS menu → Youtube Download parameters ──
// The parameters window reads the current state here, lets the user pick a new
// folder (choose-download-dir does NOT persist) and only applies it when Save
// is pressed (yt-set-download-dir persists, after validating the directory).
ipcMain.handle('yt-dl-params', () => ({
  dir: ytDownloadDir(),
  pinned: !!process.env.AEGIS_DOWNLOADS_DIR,
  // A dedicated YouTube folder counts only when the user picked one and the
  // folder is not pinned by the environment.
  custom: !process.env.AEGIS_DOWNLOADS_DIR && !!dlPrefs.ytDir,
  defaultDir: getDlDir(),
}));

ipcMain.handle('choose-download-dir', async () => ({
  path: await pickDirDialog(),
  pinned: !!process.env.AEGIS_DOWNLOADS_DIR,
}));

ipcMain.handle('yt-set-download-dir', (e, dir) => {
  if (process.env.AEGIS_DOWNLOADS_DIR) {
    return { ok: false, pinned: true, error: 'This folder is fixed by AEGIS_DOWNLOADS_DIR and cannot be changed here.' };
  }
  const d = String(dir || '').trim();
  if (!d) return { ok: false, error: 'Choose a folder first.' };
  try { if (!fs.statSync(d).isDirectory()) throw new Error('not a directory'); }
  catch (err) { return { ok: false, error: 'That folder does not exist.' }; }
  dlPrefs.ytDir = d;
  saveDlPrefs();
  return { ok: true, dir: ytDownloadDir() };
});

// Back to "follow the default folder from Parameters".
ipcMain.handle('yt-reset-download-dir', () => {
  if (process.env.AEGIS_DOWNLOADS_DIR) {
    return { ok: false, pinned: true, error: 'This folder is fixed by AEGIS_DOWNLOADS_DIR and cannot be changed here.' };
  }
  dlPrefs.ytDir = '';
  saveDlPrefs();
  return { ok: true, dir: ytDownloadDir() };
});

function toggleDownloads() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-downloads');
}

ipcMain.handle('open-download-folder', (e, savePath) => {
  if (!savePath) return;
  try { shell.showItemInFolder(savePath); } catch(e) { try { shell.openPath(path.dirname(savePath)); } catch(e2) {} }
});

ipcMain.handle('open-download-file', (e, savePath) => {
  if (!savePath) return;
  try { shell.openPath(savePath); } catch(e) {}
});

ipcMain.handle('delete-download', (e, savePath, dlId, deleteFile) => {
  if (!savePath) return;
  const normalized = savePath.replace(/\\/g, '/');
  deletedDlSavePaths.add(savePath);
  deletedDlSavePaths.add(normalized);
  if (dlId != null && !String(dlId).startsWith('hist_')) {
    deletedDlIds.add(dlId);
  }

  // 1. Cancel active download (triggers 'done' synchronously → inserts DB row + sets entry.dbId)
  if (dlId != null && dlItemsMap[dlId]) {
    try { dlItemsMap[dlId].cancel(); } catch(e) {}
    delete dlItemsMap[dlId];
  }

  // 2. Find entry in downloadsByWs, capture the final path (may differ after 'done') and DB primary key
  let entryPath = null, dbRowId = null;
  for (const wsId in downloadsByWs) {
    const list = downloadsByWs[wsId];
    const entry = list.find(d => d.savePath === savePath || d.savePath.replace(/\\/g, '/') === normalized || (dlId != null && d.id === dlId));
    if (entry) {
      entryPath = entry.savePath;
      if (entry.dbId != null) dbRowId = Number(entry.dbId);
      if (entryPath !== savePath && entryPath !== normalized) {
        deletedDlSavePaths.add(entryPath);
        deletedDlSavePaths.add(entryPath.replace(/\\/g, '/'));
      }
      list.splice(list.indexOf(entry), 1);
      if (!list.length) delete downloadsByWs[wsId];
      break;
    }
  }

  // 3. Extract DB row ID from hist_N prefix (for history items from renderer)
  if (dbRowId == null && dlId != null && String(dlId).startsWith('hist_')) {
    const parsed = parseInt(String(dlId).slice(5), 10);
    if (!isNaN(parsed)) dbRowId = parsed;
  }

  // 4. Delete file from disk (only if deleteFile is true, default behaviour preserves file)
  if (deleteFile) {
    try { fs.unlinkSync(savePath); } catch(e) {}
    if (savePath !== normalized) try { fs.unlinkSync(normalized); } catch(e) {}
  }

  // 5. Delete from DB — primary key first, then path fallback
  try {
    if (currentUser) {
      let deleted = false;
      if (dbRowId != null && !isNaN(dbRowId)) {
        const result = db.prepare('DELETE FROM downloads WHERE id=? AND user_pseudo=?').run(dbRowId, currentUser);
        if (result.changes > 0) deleted = true;
      }
      if (!deleted) {
        const pathsToTry = [savePath];
        if (normalized !== savePath) pathsToTry.push(normalized);
        if (entryPath && entryPath !== savePath && entryPath !== normalized) {
          pathsToTry.push(entryPath);
          const eNorm = entryPath.replace(/\\/g, '/');
          if (eNorm !== entryPath) pathsToTry.push(eNorm);
        }
        // save_path is ciphertext — SQL can no longer compare it, so the
        // candidate paths are matched against decrypted rows and the row is
        // deleted by its (plaintext) primary key instead.
        const wanted = new Set(pathsToTry.filter(p => typeof p === 'string'));
        const rows = db.prepare('SELECT id, workspace_id, save_path FROM downloads WHERE user_pseudo=?').all(currentUser);
        for (const r of rows) {
          const dec = vaultDecRow('downloads', { user_pseudo: currentUser, workspace_id: r.workspace_id, save_path: r.save_path }, currentUser);
          if (typeof dec.save_path !== 'string' || !wanted.has(dec.save_path)) continue;
          if (db.prepare('DELETE FROM downloads WHERE id=? AND user_pseudo=?').run(r.id, currentUser).changes > 0) { deleted = true; break; }
        }
      }
      if (!deleted) console.error('delete-download: no DB row matched for id=' + dbRowId + ' path=' + savePath);
    }
  } catch(e) { console.error('delete-download error:', e); }
});

// ── Analytics IPC ──
//
// page_visits.domain / .title are ciphertext (vault matrix above), so SQL can
// no longer GROUP BY domain or take MAX(title): those two reports are pulled
// by column and aggregated in JavaScript over decrypted values. category is a
// plaintext label and every numeric column is untouched, so counts, sums,
// averages and the category GROUP BYs all stay in SQLite where they belong.
function analyticsRows(user, since, cols) {
  const sql = 'SELECT user_pseudo, workspace_id, ' + cols.join(', ') +
    ' FROM page_visits WHERE user_pseudo=?' + (since === null ? '' : ' AND start_time>=?');
  return since === null ? db.prepare(sql).all(user) : db.prepare(sql).all(user, since);
}

// The old `… GROUP BY domain ORDER BY total DESC LIMIT n`, row for row:
// same keys, same order, same MAX(title) rule (greatest title wins), with a
// domain tie-break so the report is at least deterministic across renders.
function analyticsTopSites(user, since, limit, withTitle) {
  const cols = ['domain', 'category', 'duration'].concat(withTitle ? ['title'] : []);
  const rows = analyticsRows(user, since, cols);
  const byDomain = new Map();
  for (const r of rows) {
    const dec = vaultDecRow('page_visits', r, user);
    const key = dec.domain || '';
    let agg = byDomain.get(key);
    if (!agg) {
      agg = { domain: key, category: dec.category, total: 0, visits: 0 };
      if (withTitle) agg.title = '';
      byDomain.set(key, agg);
    }
    agg.total += r.duration || 0;
    agg.visits += 1;
    if (withTitle) {
      const title = dec.title || '';
      if (title > agg.title) agg.title = title; // SQL MAX(title)
    }
  }
  const out = Array.from(byDomain.values());
  out.sort((a, b) => (b.total - a.total) || String(a.domain).localeCompare(String(b.domain)));
  return out.slice(0, limit);
}

// The old `LEFT JOIN workspaces … GROUP BY p.workspace_id`: workspace name is
// ciphertext, so names come from getWorkspaces() (decrypted) instead of a JOIN.
function analyticsWsBreakdown(user, since) {
  const rows = analyticsRows(user, since, ['duration']);
  const totals = new Map();
  for (const r of rows) totals.set(r.workspace_id, (totals.get(r.workspace_id) || 0) + (r.duration || 0));
  const names = new Map();
  for (const w of getWorkspaces(user)) names.set(w.id, w.name);
  const out = [];
  totals.forEach((total, wsId) => out.push({ workspace_id: wsId, name: names.get(wsId) || wsId, total: total }));
  out.sort((a, b) => b.total - a.total);
  return out;
}

ipcMain.handle('get-analytics-today', () => {
  if (!currentUser) return null;
  endCurrentVisit();
  computeDailyMetrics();
  const today = getTodayStr();
  const daily = db.prepare('SELECT * FROM daily_analytics WHERE date=? AND user_pseudo=?').get(today, currentUser);
  const sessions = db.prepare('SELECT COUNT(*) as c FROM browser_sessions WHERE user_pseudo=? AND start_time>=?').get(currentUser, new Date(today).getTime());
  const totalSessions = db.prepare('SELECT COUNT(*) as c FROM browser_sessions WHERE user_pseudo=?').get(currentUser);
  const topSites = analyticsTopSites(currentUser, new Date(today).getTime(), 10, true);
  const catDist = db.prepare(
    'SELECT category, SUM(duration) as total FROM page_visits WHERE user_pseudo=? AND start_time>=? GROUP BY category ORDER BY total DESC'
  ).all(currentUser, new Date(today).getTime());
  const wsBreakdown = analyticsWsBreakdown(currentUser, new Date(today).getTime());
  const dayStart = new Date(today).getTime();
  const hourlyBuckets = db.prepare(
    "SELECT CAST((start_time - ?) / 3600000 AS INTEGER) as hour, SUM(duration) as total FROM page_visits WHERE user_pseudo=? AND start_time>=? AND start_time<? GROUP BY hour ORDER BY hour"
  ).all(dayStart, currentUser, dayStart, dayStart + 86400000);
  return { daily, sessions: sessions.c || 0, totalSessions: totalSessions.c || 0, topSites, catDist, wsBreakdown, hourlyBuckets };
});

ipcMain.handle('get-analytics-weekly', () => {
  if (!currentUser) return null;
  const weekAgo = Date.now() - 7 * 86400000;
  const weekStart = new Date(getTodayStr()).getTime() - 6 * 86400000; // 7 days including today
  const daily = db.prepare('SELECT * FROM daily_analytics WHERE user_pseudo=? AND date >= ? ORDER BY date').all(currentUser, new Date(weekStart).toISOString().slice(0,10));
  const catDist = db.prepare(
    'SELECT category, SUM(duration) as total FROM page_visits WHERE user_pseudo=? AND start_time>=? GROUP BY category ORDER BY total DESC'
  ).all(currentUser, weekAgo);
  const topSites = analyticsTopSites(currentUser, weekAgo, 10, false);
  return { daily, catDist, topSites };
});

ipcMain.handle('get-analytics-all-time', () => {
  if (!currentUser) return null;
  const totalTime = db.prepare('SELECT COALESCE(SUM(duration),0) as t FROM page_visits WHERE user_pseudo=?').get(currentUser);
  const totalVisits = db.prepare('SELECT COUNT(*) as c FROM page_visits WHERE user_pseudo=?').get(currentUser);
  const catDist = db.prepare('SELECT category, SUM(duration) as total FROM page_visits WHERE user_pseudo=? GROUP BY category ORDER BY total DESC').all(currentUser);
  const topSites = analyticsTopSites(currentUser, null, 20, false);
  const wsBreakdown = analyticsWsBreakdown(currentUser, null);
  const sessions = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(duration),0) as total, COALESCE(AVG(duration),0) as avg FROM browser_sessions WHERE user_pseudo=?').get(currentUser);
  return { totalTime: totalTime.t, totalVisits: totalVisits.c, catDist, topSites, wsBreakdown, sessions };
});

ipcMain.handle('get-analytics-week-history', () => {
  if (!currentUser) return [];
  const weekAgo = Date.now() - 7 * 86400000;
  return db.prepare(
    'SELECT user_pseudo, workspace_id, domain, category, title, start_time, duration FROM page_visits WHERE user_pseudo=? AND start_time>=? ORDER BY start_time DESC LIMIT 200'
  ).all(currentUser, weekAgo).map(r => {
    const dec = vaultDecRow('page_visits', r, currentUser);
    return { domain: dec.domain, category: r.category, title: dec.title, start_time: r.start_time, duration: r.duration };
  });
});

ipcMain.handle('analytics-delete-all', () => {
  deleteAllAnalytics();
  return { ok: true };
});

ipcMain.handle('analytics-toggle', (e, enabled) => {
  analyticsEnabled = enabled !== false;
  if (analyticsEnabled) startAnalyticsForUser(); else stopAnalytics();
  return { ok: true };
});

ipcMain.handle('get-analytics-status', () => {
  return { enabled: analyticsEnabled };
});

// ── Dashboard Window ──

let dashboardWindow = null;
ipcMain.on('open-dashboard', () => {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) { dashboardWindow.focus(); return; }
  endCurrentVisit(); computeDailyMetrics();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser-chrome-visibility', false);
  dashboardWindow = new BrowserWindow({
    width: 1100, height: 780, parent: mainWindow,
    title: 'Time Intelligence - AEGIS', backgroundColor: '#0a0a12',
    icon: findIcon() || undefined, resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  dashboardWindow.loadFile('dashboard.html');
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser-chrome-visibility', true);
  });
});

// ── Settings Window ──

let settingsWindow = null;
ipcMain.on('open-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 400, height: 680, parent: mainWindow, modal: true,
    title: 'Settings - AEGIS', backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
});

ipcMain.on('open-parameters', () => { openParameters(); });

// ── Parameters Window ──

let parametersWindow = null;
function openParameters() {
  if (parametersWindow && !parametersWindow.isDestroyed()) {
    // Re-pressing the menu entry must bring the window back — even when it was
    // minimized or lost behind another window — instead of doing nothing.
    try { if (parametersWindow.isMinimized()) parametersWindow.restore(); parametersWindow.show(); parametersWindow.focus(); } catch (e) {}
    return;
  }
  parametersWindow = new BrowserWindow({
    width: 400, height: 560, parent: mainWindow, modal: true,
    // Frameless: the page's .topbar/.header is the drag strip and the QUIT
    // button is the only window control (no native caption buttons).
    frame: false,
    title: 'AEGIS Parameters', backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  // No AEGIS / Workspaces menu bar here: QUIT in the page is the only control.
  stripWindowNav(parametersWindow);
  // Same guard as the Youtube parameters window: never show a silent blank frame.
  parametersWindow.loadFile('parameters.html').catch((err) => {
    console.error('Parameters failed to load parameters.html: ' + (err && err.message));
    if (parametersWindow && !parametersWindow.isDestroyed()) { try { parametersWindow.close(); } catch (e) {} }
  });
  parametersWindow.on('closed', () => { parametersWindow = null; });
}

// ── Youtube Download parameters Window ──
// Opened from the AEGIS menu: shows the current YouTube download folder, lets
// the user choose a new one (draft) and applies it with Save.
let ytParamsWindow = null;
function openYtParams() {
  if (ytParamsWindow && !ytParamsWindow.isDestroyed()) {
    // Re-pressing the menu entry must bring the window back — even when it was
    // minimized or lost behind another window — instead of doing nothing.
    try { if (ytParamsWindow.isMinimized()) ytParamsWindow.restore(); ytParamsWindow.show(); ytParamsWindow.focus(); } catch (e) {}
    return;
  }
  ytParamsWindow = new BrowserWindow({
    width: 440, height: 430, parent: mainWindow, modal: true,
    // Frameless: same custom chrome contract as the Parameters window.
    frame: false,
    title: 'YouTube Download Parameters - AEGIS', backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  // No AEGIS / Workspaces menu bar here: QUIT in the page is the only control.
  stripWindowNav(ytParamsWindow);
  // A page that cannot load (e.g. a packaging gap) must never leave a silent
  // blank window behind: log it and close the window so a re-press retries.
  ytParamsWindow.loadFile('yt-params.html').catch((err) => {
    console.error('Youtube Download parameters failed to load yt-params.html: ' + (err && err.message));
    if (ytParamsWindow && !ytParamsWindow.isDestroyed()) { try { ytParamsWindow.close(); } catch (e) {} }
  });
  ytParamsWindow.on('closed', () => { ytParamsWindow = null; });
}

// ── Auto-Close IPC ──

ipcMain.handle('get-auto-close', () => {
  if (!currentUser) return { enabled: !!DEFAULT_AUTO_CLOSE, seconds: DEFAULT_AUTO_CLOSE_SECONDS };
  const u = getUser(currentUser);
  const enabled = u ? u.auto_close !== 0 : !!DEFAULT_AUTO_CLOSE;
  const seconds = u && u.auto_close_seconds ? Number(u.auto_close_seconds) : DEFAULT_AUTO_CLOSE_SECONDS;
  return { enabled, seconds };
});

ipcMain.handle('set-auto-close', (e, enabled, minutes) => {
  if (!currentUser) return { ok: false, error: 'Not signed in.' };
  let secs = DEFAULT_AUTO_CLOSE_SECONDS;
  if (minutes !== undefined && minutes !== null) {
    const n = Number(minutes);
    if (!isNaN(n) && n > 0) secs = Math.round(n * 60);
  }
  db.prepare('UPDATE users SET auto_close=?, auto_close_seconds=? WHERE pseudo=?').run(enabled ? 1 : 0, secs, currentUser);
  resetIdleTimer();
  return { ok: true };
});

// ── Default Browser IPC ──

const APP_PROGID = 'AEGISURL.HTTP';

function regQuery(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key], { windowsHide: true }, (err, stdout) => resolve(err ? null : (stdout || null)));
  });
}

function regAdd(args) {
  return new Promise((resolve) => {
    execFile('reg', ['add'].concat(args), { windowsHide: true }, (err) => resolve(!err));
  });
}

async function getUserChoiceProgId(proto) {
  const out = await regQuery('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\' + proto + '\\UserChoice');
  if (!out) return null;
  const m = out.match(/ProgId\s+REG_SZ\s+(\S+)/i);
  return m ? m[1] : null;
}

ipcMain.handle('get-default-browser-status', async () => {
  if (process.platform !== 'win32') return { isDefault: false, supported: false };
  const httpId = await getUserChoiceProgId('http');
  const httpsId = await getUserChoiceProgId('https');
  const isDefault = httpId === APP_PROGID || httpsId === APP_PROGID;
  // No UserChoice recorded (older setups): check who owns the http open command
  if (!isDefault && !httpId) {
    const out = await regQuery('HKCU\\Software\\Classes\\http\\shell\\open\\command');
    const exeName = path.basename(process.execPath).toLowerCase();
    if (out && out.toLowerCase().indexOf(exeName) !== -1) return { isDefault: true, supported: true };
  }
  return { isDefault, supported: true };
});

ipcMain.handle('set-default-browser', async () => {
  try { app.setAsDefaultProtocolClient('http'); } catch (e) {}
  try { app.setAsDefaultProtocolClient('https'); } catch (e) {}
  if (process.platform === 'win32') {
    const exe = process.execPath;
    // Register a proper ProgId + capabilities entry so Windows Settings can
    // list AEGIS and deep-link straight to its default-apps page
    await regAdd(['HKCU\\Software\\Classes\\' + APP_PROGID, '/ve', '/d', 'AEGIS URL', '/f']);
    await regAdd(['HKCU\\Software\\Classes\\' + APP_PROGID, '/v', 'URL Protocol', '/d', '', '/f']);
    await regAdd(['HKCU\\Software\\Classes\\' + APP_PROGID + '\\shell\\open\\command', '/ve', '/d', '"' + exe + '" "%1"', '/f']);
    await regAdd(['HKCU\\Software\\AEGIS\\Capabilities', '/v', 'ApplicationName', '/d', 'AEGIS', '/f']);
    await regAdd(['HKCU\\Software\\AEGIS\\Capabilities', '/v', 'ApplicationDescription', '/d', 'AEGIS Privacy Browser', '/f']);
    await regAdd(['HKCU\\Software\\AEGIS\\Capabilities\\URLAssociations', '/v', 'http', '/d', APP_PROGID, '/f']);
    await regAdd(['HKCU\\Software\\AEGIS\\Capabilities\\URLAssociations', '/v', 'https', '/d', APP_PROGID, '/f']);
    await regAdd(['HKCU\\Software\\RegisteredApplications', '/v', 'AEGIS', '/d', 'Software\\AEGIS\\Capabilities', '/f']);
    // Windows 10/11 protect defaults: the user confirms the choice once in Windows Settings
    try { await shell.openExternal('ms-settings:defaultapps?registeredApp=AEGIS'); }
    catch (e) { try { await shell.openExternal('ms-settings:defaultapps'); } catch (e2) {} }
  }
  return { ok: true };
});

// ── Network speed IPC ──

ipcMain.handle('get-net-prefs', () => ({ secureDns: !!netPrefs.secureDns }));

ipcMain.handle('set-net-prefs', (e, prefs) => {
  try {
    if (prefs && typeof prefs.secureDns === 'boolean') netPrefs.secureDns = prefs.secureDns;
    fs.writeFileSync(NET_PREFS_PATH, JSON.stringify(netPrefs));
    return { ok: true, secureDns: !!netPrefs.secureDns };
  } catch (err) { return { ok: false, error: 'Could not save network settings.' }; }
});

// ── Aegis Shield IPC ──
// Prefs + live session stats for the Settings card, and the synchronous
// bootstrap fp-preload.js pulls at document start (enabled flag + per-run
// farbling seed). sendSync needs ipcMain.on with e.returnValue.
ipcMain.handle('shield-get-prefs', () => shield.getPrefs());
ipcMain.handle('shield-set-prefs', (e, p) => shield.setPrefs(p));
ipcMain.handle('shield-get-stats', () => shield.getStats());
ipcMain.on('shield-fp-bootstrap', (e) => { e.returnValue = shield.fpBootstrap(); });

// ── Clipboard auto-wipe ──────────────────────────────────────────────────────
// Anything copied while AEGIS runs — from the context menu, from copy-text,
// from a page via navigator.clipboard, or from a plain Ctrl+C inside a tab —
// is cleared once it has sat on the clipboard for the configured delay. One
// rule keeps it honest: only text that is STILL EXACTLY what we saw is
// cleared. If the user copied something newer in the meantime, the newer copy
// is the one now on the hook and the old one is never touched.
//
// Two mechanisms, same rule:
//   scheduleClipboardWipe(text)  armed by every write the main process makes
//                                (the three copy sites), so those arms start
//                                at the instant of the copy;
//   a 1.5 s poller              catches writes AEGIS never sees — page script
//                                writes, Ctrl+C, copies from other apps.
// At startup the current clipboard is taken as a BASELINE, not as a fresh
// copy: it existed before this session and is left alone.
//
// Known limitation (stated in Settings and the README): Windows' clipboard
// history (Win+V) keeps its own copy of every entry. That is the OS's store,
// outside the reach of any application — clearing it from AEGIS would mean
// clearing the user's whole Win+V list, which is not ours to wipe.
const CLIP_PREFS_PATH = path.join(app.getPath('userData'), 'clipboard-prefs.json');
const CLIP_DEFAULTS = { enabled: true, seconds: 20 };
const CLIP_POLL_MS = 1500;
const CLIP_MIN_SECONDS = 5;
const CLIP_MAX_SECONDS = 600;
let clipPrefs = Object.assign({}, CLIP_DEFAULTS);
let clipBaseline = null; // clipboard text at startup — never armed, never wiped
let clipWatched = null;  // exact text being watched (null = nothing to wipe)
let clipLive = false;    // true only for copies made DURING this session — the
                         // startup baseline is watched (so a later change is
                         // noticed) but never armed, so neither the timer may
                         // ever clear it
let clipTimer = null;
let clipPoll = null;

function clipLoadPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(CLIP_PREFS_PATH, 'utf8'));
    clipPrefs = {
      enabled: p.enabled !== false,
      seconds: Math.min(CLIP_MAX_SECONDS, Math.max(CLIP_MIN_SECONDS, Number(p.seconds) || CLIP_DEFAULTS.seconds)),
    };
  } catch (e) { clipPrefs = Object.assign({}, CLIP_DEFAULTS); }
}
clipLoadPrefs();

function clipRead() { try { return clipboard.readText(); } catch (e) { return null; } }

function clipDisarm() {
  if (clipTimer) { clearTimeout(clipTimer); clipTimer = null; }
}

function clipArm() {
  clipDisarm();
  if (!clipPrefs.enabled || clipWatched === null) return;
  clipTimer = setTimeout(() => {
    clipTimer = null;
    const now = clipRead();
    if (clipLive && clipWatched !== null && now === clipWatched && now !== '') {
      try { clipboard.writeText(''); } catch (e) {}
    }
    // Deadline spent. A NEWER copy (if any) is picked up by the next poll
    // tick, which re-arms it under its own clock.
    clipWatched = null;
    clipLive = false;
  }, clipPrefs.seconds * 1000);
}

// Called by every copy the main process performs itself.
function scheduleClipboardWipe(text) {
  if (typeof text !== 'string') text = String(text == null ? '' : text);
  if (!clipPrefs.enabled || !text) return;
  clipWatched = text;
  clipLive = true; // a copy THIS session made — the only kind we may clear
  clipArm();
}

function clipPollTick() {
  if (!clipPrefs.enabled) return;
  const t = clipRead();
  if (t === null) return;
  if (t === '') { clipWatched = null; clipLive = false; clipDisarm(); return; } // nothing to wipe
  if (t !== clipWatched) { clipWatched = t; clipLive = true; clipArm(); }       // a copy we did not make
}

function clipStartPolling() {
  if (clipPoll) return;
  // Baseline: whatever is on the clipboard right now was copied before AEGIS
  // started (or is empty) — remembered so the first tick does not arm it, and
  // kept as the reference the quit wipe uses to tell session content apart
  // from content that predates the session.
  clipBaseline = clipRead() || null;
  clipWatched = clipBaseline;
  clipLive = false;
  clipPoll = setInterval(clipPollTick, CLIP_POLL_MS);
  if (clipPoll.unref) clipPoll.unref();
}

// Quit: content copied DURING this session must not outlive the session.
// Anything on the clipboard that differs from the startup baseline is session
// content — including a copy the 1.5 s poll had not observed yet — so the rule
// does not depend on the poller having caught up. The baseline itself (and an
// empty clipboard) is left alone.
function clipWipeOnQuit() {
  const now = clipRead();
  if (now !== null && now !== '' && now !== clipBaseline) {
    try { clipboard.writeText(''); } catch (e) {}
  }
  clipWatched = null;
  clipLive = false;
  clipDisarm();
}

ipcMain.handle('clip-get-prefs', () => ({ enabled: !!clipPrefs.enabled, seconds: clipPrefs.seconds }));

ipcMain.handle('clip-set-prefs', (e, prefs) => {
  try {
    const next = { enabled: !!clipPrefs.enabled, seconds: clipPrefs.seconds };
    if (prefs && typeof prefs.enabled === 'boolean') next.enabled = prefs.enabled;
    if (prefs && prefs.seconds !== undefined && prefs.seconds !== null && prefs.seconds !== '') {
      const s = Math.round(Number(prefs.seconds));
      if (!Number.isFinite(s)) return { ok: false, error: 'Clipboard delay must be a number of seconds.' };
      next.seconds = Math.min(CLIP_MAX_SECONDS, Math.max(CLIP_MIN_SECONDS, s));
    }
    clipPrefs = next;
    try { fs.writeFileSync(CLIP_PREFS_PATH, JSON.stringify(clipPrefs)); } catch (err) { /* read-only profile */ }
    // Re-arm under the new rules immediately: a longer delay must not leave a
    // pending wipe on the old clock, and disabling must cancel it outright.
    if (!clipPrefs.enabled) { clipWatched = null; clipLive = false; clipDisarm(); }
    else if (clipLive && clipWatched !== null) clipArm();
    return { ok: true, enabled: clipPrefs.enabled, seconds: clipPrefs.seconds };
  } catch (err) { return { ok: false, error: 'Could not save clipboard settings.' }; }
});

// ── External links (AEGIS registered as default browser) ──

let pendingExternalUrls = [];
function isWebUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u.trim()); }
function extractUrlFromArgv(argv) {
  for (const a of (argv || [])) { if (isWebUrl(a)) return a.trim(); }
  return null;
}
function browserReady() {
  return !!(currentUser && currentWorkspace && mainWindow && !mainWindow.isDestroyed() && workspaceTabs[currentWorkspace]);
}
function handleExternalUrl(url) {
  if (!isWebUrl(url)) return;
  if (browserReady()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    addTab(url);
  } else {
    // Still on the login/workspace screen — open once the browser is ready
    pendingExternalUrls.push(url);
  }
}
function flushPendingExternalUrls() {
  if (!pendingExternalUrls.length || !browserReady()) return;
  const urls = pendingExternalUrls;
  pendingExternalUrls = [];
  urls.forEach(u => addTab(u));
}
const startupExternalUrl = extractUrlFromArgv(process.argv);
if (startupExternalUrl) pendingExternalUrls.push(startupExternalUrl);

app.whenReady().then(() => {
  // Cover the default session too: tabs opened without a workspace partition
  // (login, landing, restored URLs) run here, and an unconfigured session would
  // silently allow geolocation without ever consulting a handler.
  setupSession(session.defaultSession, null);
  initDB(); prepareStatements(); createWindow();
  clipStartPolling(); // clipboard auto-wipe: baseline now, 1.5 s cadence after
});

// ── Auth IPC ──

ipcMain.handle('register', (e, pseudo, password) => {
  if (!pseudo || !password || pseudo.length < 2 || password.length < 3) return { ok: false, error: 'Pseudonym (min 2 chars) and password (min 3 chars) required.' };
  if (userExists(pseudo)) return { ok: false, error: 'User already exists.' };
  registerUser(pseudo, password);
  clearWipeNotice();          // a fresh account means the user has seen the wipe message
  return { ok: true };
});

// ── Login security: 3 wrong passwords wipe every trace of local data ──
// The counter lives in the main process (and on disk), so neither the
// renderer nor an app restart can reset it. Only a successful login clears it.
const LOGIN_ATTEMPTS_PATH = path.join(app.getPath('userData'), 'login-attempts.json');
const MAX_LOGIN_ATTEMPTS = 3;

function readLoginAttempts() {
  try {
    const n = JSON.parse(fs.readFileSync(LOGIN_ATTEMPTS_PATH, 'utf8'));
    return (typeof n.count === 'number' && n.count >= 0) ? n.count : 0;
  } catch (e) { return 0; }
}
function writeLoginAttempts(count) {
  // Write-then-rename so an interrupted write can never leave truncated JSON
  // behind — readLoginAttempts() treats unreadable JSON as 0, which would
  // silently reset the counter and undo the protection.
  const tmp = LOGIN_ATTEMPTS_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ count: count, updated: Date.now() }));
    fs.renameSync(tmp, LOGIN_ATTEMPTS_PATH);
  } catch (e) {
    try { fs.writeFileSync(LOGIN_ATTEMPTS_PATH, JSON.stringify({ count: count, updated: Date.now() })); } catch (e2) {}
    try { fs.unlinkSync(tmp); } catch (e3) {}
  }
}
function clearLoginAttempts() { try { fs.unlinkSync(LOGIN_ATTEMPTS_PATH); } catch (e) {} }

// DESTRUCTIVE. Erases accounts, history, bookmarks, downloads, cookies,
// localStorage, workspace partitions and the whole browser profile, then
// rebuilds an empty database so the login screen is usable again.
async function wipeAllData() {
  // 0. Markers FIRST: written before a single byte is deleted, so they survive
  //    even if this run dies halfway. pending-wipe.json makes the next launch
  //    finish the job (Chromium holds locks on some profile files while it is
  //    running, and re-flushes Preferences/Local State when it exits);
  //    wipe-notice.json keeps telling the user what happened afterwards.
  try { fs.writeFileSync(PENDING_WIPE_PATH, JSON.stringify({ at: Date.now() })); } catch (e) {}
  try { fs.writeFileSync(WIPE_NOTICE_PATH, JSON.stringify({ at: Date.now(), msg: WIPED_MSG })); } catch (e) {}

  // 1. Close any open tab views (normally none — login runs from the login screen)
  try { closeGhostWorkspace(); } catch (e) {}
  try {
    Object.keys(workspaceTabs).forEach(wsId => {
      workspaceTabs[wsId].forEach(t => {
        try { mainWindow.contentView.removeChildView(t.view); } catch (e) {}
        try { t.view.webContents.close(); } catch (e) {}
      });
    });
  } catch (e) {}
  workspaceTabs = {}; activeIdPerWorkspace = {}; idCounter = 0;
  playingTabs.clear();
  currentUser = null; currentUserLabel = null; decoyOwnerPseudo = null; currentWorkspace = null;
  vaultDeactivate(); // the profile is about to be shredded — drop the DEK first
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
  invalidateBookmarkCache();

  // 2. In-memory state of every workspace session that was ever opened:
  //    cookie jars, caches and HTTP auth live here, not only on disk.
  for (const p of usedPartitions) {
    try {
      const s = session.fromPartition(p);
      await s.clearStorageData(); await s.clearCache(); await s.clearAuthCache();
    } catch (e) {}
  }
  usedPartitions.clear();

  // 3. Database + WAL/SHM/journal sidecars
  if (db) { try { db.close(); } catch (e) {} db = null; }
  [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm', DB_PATH + '-journal'].forEach(f => rmrf(f));

  // 4. Default session (login window): cache, storage, HTTP auth
  try { await session.defaultSession.clearCache(); } catch (e) {}
  try { await session.defaultSession.clearStorageData(); } catch (e) {}
  try { await session.defaultSession.clearAuthCache(); } catch (e) {}

  // 5. On disk: the entire Chromium profile and the AEGIS data folder
  //    (database, legacy JSON store, network prefs, attempt counter, cookies,
  //    localStorage, IndexedDB, Preferences, Local State, DIPS, InterestGroups…)
  wipeDataFolders();

  // 6. Fresh, empty database so login/registration still work
  initDB();
  prepareStatements();
  invalidateBookmarkCache();
}

// Serializes login attempts: a double-click on Sign In must not race the
// read-modify-write of the counter (two simultaneous failures would count as
// one) and must not start two wipes.
let loginQueue = Promise.resolve();

function handleLogin(pseudo, password) {
  if (!pseudo || !password) return { ok: false, error: 'Enter pseudonym and password.' };
  const result = loginUser(pseudo, password);
  if (result === true) {
    clearLoginAttempts();
    clearWipeNotice();
    return { ok: true };
  }
  // Right password, broken keystore: an honest error that does NOT spend an
  // attempt — counting it would erase the whole profile over a damaged row.
  if (result && result.vaultError) return { ok: false, error: result.vaultError };

  // Failed attempt — 3 strikes and all local data is erased.
  const attempts = readLoginAttempts() + 1;
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    writeLoginAttempts(attempts);          // persisted first: survives even if the wipe fails
    return wipeAllData()
      .catch(err => {
        console.error('wipeAllData failed:', err);
        // Best-effort recovery so the login screen still accepts a fresh registration
        try { if (!db) { initDB(); prepareStatements(); } } catch (e2) { console.error('re-init failed:', e2); }
      })
      .then(() => {
        clearLoginAttempts();
        return { ok: false, wiped: true, error: WIPED_MSG };
      });
  }

  writeLoginAttempts(attempts);
  const left = MAX_LOGIN_ATTEMPTS - attempts;
  return {
    ok: false,
    attemptsLeft: left,
    error: 'Invalid credentials. ' + left + (left === 1 ? ' attempt left' : ' attempts left') + ' before all data is erased.'
  };
}

ipcMain.handle('login', (e, pseudo, password) => {
  const job = loginQueue.then(() => handleLogin(pseudo, password), () => handleLogin(pseudo, password));
  loginQueue = job.then(() => {}, () => {});
  return job;
});

// The login screen asks this on load: if a wipe happened (even in an earlier
// run, even if the renderer crashed before the answer arrived), say so instead
// of letting the user think their password is wrong.
ipcMain.handle('wipe-notice', () =>
  fs.existsSync(WIPE_NOTICE_PATH)
    ? (() => { try { const n = JSON.parse(fs.readFileSync(WIPE_NOTICE_PATH, 'utf8')); return { wiped: true, at: n.at, msg: n.msg || WIPED_MSG }; } catch (e) { return { wiped: true, msg: WIPED_MSG }; } })()
    : { wiped: false });

ipcMain.handle('logout', () => {
  saveUserTabsPersist();
  closeGhostWorkspace(); // Ghost: drop its in-memory session on the way out
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} t.view.webContents.close(); });
  });
  workspaceTabs = {};
  activeIdPerWorkspace = {};
  playingTabs.clear();
  updatePowerSaveBlocker();
  currentUser = null;
  currentUserLabel = null;
  decoyOwnerPseudo = null;
  currentWorkspace = null;
  idCounter = 0;
  splitMode = false; splitLeft = null; splitRight = null;
  invalidateBookmarkCache();
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
  stopEmailWatch();
  // Key lifecycle: the DEK dies with the session (flush above already ran with
  // it), so nothing in memory can decrypt this account until the next login.
  vaultDeactivate();
  Menu.setApplicationMenu(null);
  return { ok: true };
});

ipcMain.handle('get-user', () => {
  if (!currentUser) return null;
  const user = getUser(currentUser);
  // guest: Anonymous mode ("Continue without account") — the UI shows the
  // Ghost Mode badge only for these accounts.
  // pseudo: the name typed at login (never the decoy's derived key).
  // duress: true while browsing inside a decoy session.
  // duressSet: whether this account has a duress password configured.
  return user ? {
    pseudo: currentUserLabel || user.pseudo,
    photo: user.photo || null,
    guest: !!user.is_guest,
    duress: !!decoyOwnerPseudo,
    duressSet: !decoyOwnerPseudo && !!user.duress_password,
  } : null;
});

ipcMain.handle('change-password', (e, oldPw, newPw) => {
  if (!currentUser) return { ok: false, error: 'Not logged in.' };
  const user = getUser(currentUser);
  if (!user) return { ok: false, error: 'User not found.' };
  // Inside a decoy session the "current password" is never the one typed here:
  // the ordinary failure message is the whole answer — no hint of a decoy.
  if (decoyOwnerPseudo) return { ok: false, error: 'Current password is incorrect.' };
  if (!verifyPassword(oldPw, user.salt, user.password)) return { ok: false, error: 'Current password is incorrect.' };
  if (!newPw || newPw.length < 3) return { ok: false, error: 'New password must be at least 3 characters.' };
  const { salt, hash } = hashPassword(newPw);
  // Password hash and vault re-wrap commit together: there is no moment when
  // the account says "new password" while the data key is still wrapped for
  // the old one (vaultRekey re-wraps the SAME DEK — no row is re-encrypted).
  try {
    db.transaction(() => {
      db.prepare('UPDATE users SET password=?,salt=? WHERE pseudo=?').run(hash, salt, currentUser);
      vaultRekey(currentUser, newPw);
    })();
  } catch (err) {
    console.error('change-password failed:', err);
    return { ok: false, error: 'Could not update your password.' };
  }
  return { ok: true };
});

// ── Duress password setup (Settings → Profile card) ──
// Setting or removing it always answers with the same ordinary error inside a
// decoy session, exactly like change-password does.
ipcMain.handle('set-duress-password', (e, newPw) => {
  if (!currentUser) return { ok: false, error: 'Not logged in.' };
  if (decoyOwnerPseudo) return { ok: false, error: 'Current password is incorrect.' };
  const user = getUser(currentUser);
  if (!user) return { ok: false, error: 'User not found.' };
  if (newPw === null || newPw === '') {
    db.prepare('UPDATE users SET duress_password=NULL, duress_salt=NULL, duress_decoy_key=NULL WHERE pseudo=?').run(currentUser);
    return { ok: true, set: false };
  }
  if (typeof newPw !== 'string' || newPw.length < 3) return { ok: false, error: 'Duress password must be at least 3 characters.' };
  if (verifyPassword(newPw, user.salt, user.password)) return { ok: false, error: 'Duress password must be different from your main password.' };
  const { salt, hash } = hashPassword(newPw);
  db.prepare('UPDATE users SET duress_password=?, duress_salt=? WHERE pseudo=?').run(hash, salt, currentUser);
  return { ok: true, set: true };
});

ipcMain.handle('upload-photo', (e, base64) => {
  if (!currentUser) return { ok: false };
  db.prepare('UPDATE users SET photo=? WHERE pseudo=?').run(base64, currentUser);
  return { ok: true };
});

ipcMain.handle('verify-password', (e, password) => {
  if (!currentUser) return false;
  if (decoyOwnerPseudo) {
    // Decoy session: the panels (History / Notes) unlock with the duress
    // password — the only credential the person at the keyboard knows.
    const owner = getUser(decoyOwnerPseudo);
    return !!(owner && owner.duress_password && verifyPassword(password, owner.duress_salt, owner.duress_password));
  }
  const user = getUser(currentUser);
  return user ? verifyPassword(password, user.salt, user.password) : false;
});

ipcMain.handle('login-guest', async () => {
  saveUserTabsPersist();
  closeGhostWorkspace(); // Ghost: nothing survives into guest mode either
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} t.view.webContents.close(); });
  });
  workspaceTabs = {};
  activeIdPerWorkspace = {};
  idCounter = 0;
  splitMode = false; splitLeft = null; splitRight = null;

  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
  stopEmailWatch();
  vaultDeactivate(); // guest mode has no password → no key; guest data stays plain
  if (db) { try { db.close(); } catch(e) {} }
  try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch(e) {}
  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearAuthCache();
  initDB();
  prepareStatements();
  invalidateBookmarkCache();
  const guestPseudo = 'Guest_' + Date.now().toString(36);
  const key = guestPseudo.toLowerCase();
  const { salt, hash } = hashPassword('guest');
  db.prepare('INSERT INTO users (pseudo,password,salt,created,photo,active_workspace,is_guest) VALUES (?,?,?,?,?,?,1)').run(key, hash, salt, Date.now(), null, 'default');
  db.prepare('INSERT INTO workspaces (id,user_pseudo,name,created) VALUES (?,?,?,?)').run('default', key, vaultEncRow('workspaces', { id: 'default', user_pseudo: key, name: 'Default' }, key).name, Date.now());
  currentUser = key;
  currentUserLabel = null; // guest shows its generated pseudonym
  decoyOwnerPseudo = null;
  currentWorkspace = 'default';
  resetIdleTimer();
  startAnalyticsForUser();
  Menu.setApplicationMenu(null);
  return { ok: true };
});

ipcMain.handle('get-history', (e, wsId) => {
  const id = wsId || currentWorkspace;
  if (!currentUser || !id) return [];
  return getHistDb(currentUser, id);
});

ipcMain.handle('clear-history', (e, wsId) => {
  const id = wsId || currentWorkspace;
  if (!currentUser || !id) return { ok: false };
  db.prepare('DELETE FROM history WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
  return { ok: true };
});

// ── Bookmarks IPC ──

ipcMain.handle('get-bookmarks', () => {
  if (!currentUser || !currentWorkspace) return [];
  return getBmDb(currentUser, currentWorkspace);
});

ipcMain.handle('add-bookmark', (e, url, title) => {
  if (!currentUser || !currentWorkspace) return { ok: false };
  if (isGhostWs(currentWorkspace)) return { ok: false, error: 'Bookmarks are not saved in the Ghost Workspace.' };
  if (findBookmarkId(currentUser, currentWorkspace, url) !== null) return { ok: false, error: 'Already bookmarked.' };
  const enc = vaultEncRow('bookmarks', { user_pseudo: currentUser, workspace_id: currentWorkspace, url, title: title || url }, currentUser);
  if (!enc) return { ok: false, error: 'Could not save the bookmark.' };
  stmt.bookmarkInsert.run(enc.user_pseudo, enc.workspace_id, enc.url, enc.title, Date.now());
  invalidateBookmarkCache();
  return { ok: true };
});

ipcMain.handle('remove-bookmark', (e, url) => {
  if (!currentUser || !currentWorkspace) return { ok: false };
  const id = findBookmarkId(currentUser, currentWorkspace, url);
  if (id !== null) stmt.bookmarkDelete.run(id, currentUser);
  invalidateBookmarkCache();
  return { ok: true };
});

ipcMain.handle('is-bookmarked', (e, url) => {
  if (!currentUser || !currentWorkspace) return false;
  const key = bookmarkKey(currentUser, currentWorkspace, url);
  if (bookmarkCache.has(key)) return bookmarkCache.get(key);
  const v = findBookmarkId(currentUser, currentWorkspace, url) !== null;
  bookmarkCache.set(key, v);
  return v;
});

// ── Notes ──
// Every note belongs to a workspace: the side bar shows one workspace's notes
// at a time, exactly like History/Downloads.

function notesReady() { return !!currentUser && !!db && !!stmt.noteList; }
function notesWsId(wsId) { return wsId || currentWorkspace; }

ipcMain.handle('get-notes', (e, wsId) => {
  if (!notesReady()) return [];
  const ws = notesWsId(wsId);
  if (!ws) return [];
  try {
    // Same three columns in, same three columns out — the AAD needs the
    // workspace id, which this projection does not select, so it is supplied
    // by hand and stripped again from the payload.
    return stmt.noteList.all(currentUser, ws).map(r => {
      const dec = vaultDecRow('notes', { user_pseudo: currentUser, workspace_id: ws, content: r.content }, currentUser);
      return { id: r.id, content: dec.content, created: r.created, updated: r.updated };
    });
  } catch(e) { return []; }
});

ipcMain.handle('add-note', (e, content, wsId) => {
  const text = (content || '').trim();
  if (!notesReady()) return { ok: false, error: 'Not logged in.' };
  if (!text) return { ok: false, error: 'Note is empty.' };
  const ws = notesWsId(wsId);
  if (!ws) return { ok: false, error: 'No active workspace.' };
  if (isGhostWs(ws)) return { ok: false, error: 'Notes are not saved in the Ghost Workspace.' };
  const now = Date.now();
  try {
    const enc = vaultEncRow('notes', { user_pseudo: currentUser, workspace_id: ws, content: text }, currentUser);
    if (!enc) return { ok: false, error: 'Could not save the note.' };
    const info = stmt.noteInsert.run(enc.user_pseudo, enc.workspace_id, enc.content, now, now);
    return { ok: true, note: { id: info.lastInsertRowid, workspaceId: ws, content: text, created: now, updated: now } };
  } catch(err) { return { ok: false, error: 'Could not save the note.' }; }
});

ipcMain.handle('update-note', (e, id, content) => {
  const text = (content || '').trim();
  if (!notesReady()) return { ok: false, error: 'Not logged in.' };
  if (!text) return { ok: false, error: 'Note is empty.' };
  try {
    // The note's OWN workspace defines its AAD — not the panel's: get-notes
    // accepts a wsId, so an edit can target a workspace that is not active.
    const row = db.prepare('SELECT workspace_id FROM notes WHERE id=? AND user_pseudo=?').get(id, currentUser);
    if (!row) return { ok: false, error: 'Could not update the note.' };
    const enc = vaultEncRow('notes', { user_pseudo: currentUser, workspace_id: row.workspace_id, content: text }, currentUser);
    if (!enc) return { ok: false, error: 'Could not update the note.' };
    const info = stmt.noteUpdate.run(enc.content, Date.now(), id, currentUser);
    return { ok: info.changes > 0 };
  } catch(err) { return { ok: false, error: 'Could not update the note.' }; }
});

ipcMain.handle('delete-note', (e, id) => {
  if (!notesReady()) return { ok: false, error: 'Not logged in.' };
  try {
    const info = stmt.noteDelete.run(id, currentUser);
    if (info.changes > 0) return { ok: true };
    return { ok: false, error: 'Could not delete the note.' };
  } catch(err) { return { ok: false, error: 'Could not delete the note.' }; }
});

// ── Workspace IPC ──

ipcMain.handle('get-workspaces', () => {
  if (!currentUser) return [];
  ensureDefaultWs(currentUser);
  const tabCounts = db.prepare('SELECT workspace_id, COUNT(*) as cnt FROM tabs WHERE user_pseudo=? GROUP BY workspace_id').all(currentUser);
  const countMap = Object.create(null);
  tabCounts.forEach(r => countMap[r.workspace_id] = r.cnt);
  const rows = getWorkspaces(currentUser).map(w => ({ id: w.id, name: w.name, created: w.created, color: w.color || '#4a8bc5', tabCount: countMap[w.id] || 0, google_email: w.google_email || null }));
  // The Ghost Workspace is always the first card: it has no SQL row (no tab
  // list to count, nothing to restore), so it is synthesized here only.
  rows.unshift({ id: GHOST_WS_ID, name: GHOST_WS_NAME, created: 0, color: GHOST_WS_COLOR, tabCount: (workspaceTabs[GHOST_WS_ID] || []).length, google_email: null, ghost: true });
  return rows;
});

ipcMain.handle('get-active-workspace', () => {
  if (!currentUser) return null;
  const user = getUser(currentUser);
  if (!user) return null;
  // Prefer the live workspace: the Ghost Workspace is never stored as
  // active_workspace (it has no row), but the badge must still name it.
  const id = currentWorkspace || user.active_workspace || 'default';
  const ws = getWorkspace(currentUser, id);
  return { id, name: ws ? ws.name : 'Default', color: ws ? (ws.color || '#4a8bc5') : '#4a8bc5', ghost: isGhostWs(id) };
});

// ── Google account detection (per-workspace session) ──
// Every workspace runs in its own isolated Chromium partition, so Google auth
// cookies (SID, __Secure-1PSID, ...) live in that partition's cookie jar.
const GOOGLE_AUTH_COOKIES = ['SID','HSID','SSID','APISID','SAPISID','LSID','__Secure-1PSID','__Secure-3PSID','__Secure-1PAPISID','__Secure-3PAPISID','__Secure-1PSIDTS'];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const googleEmailCache = new Map();

function googlePartitionFor(wsId) { return partitionFor(wsId); }

async function googleAccountSignedIn(wsId) {
  if (!currentUser) return false;
  try {
    const cookies = await session.fromPartition(googlePartitionFor(wsId)).cookies.get({});
    return cookies.some(c => GOOGLE_AUTH_COOKIES.includes(c.name) && /(^|\.)google\.com$/.test(c.domain || ''));
  } catch (e) { return false; }
}

function emailFromText(s) { const m = (s || '').match(EMAIL_RE); return m ? m[0] : null; }

// Runs inside the page: Gmail puts the signed-in address in <title>
// ("Inbox - user@gmail.com - Gmail"); fall back to account elements.
function extractGoogleEmailInPage() {
  var RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var m = (document.title || '').match(RE);
  if (m) return m[0];
  var el = document.querySelector('[data-email]') || document.querySelector('[email]');
  var v = el && (el.getAttribute('data-email') || el.getAttribute('email'));
  if (v) { m = v.match(RE); if (m) return m[0]; }
  var labels = document.querySelectorAll('[aria-label]');
  for (var i = 0; i < labels.length; i++) {
    m = (labels[i].getAttribute('aria-label') || '').match(RE);
    if (m) return m[0];
  }
  return null;
}
const EXTRACT_GOOGLE_EMAIL_JS = '(' + extractGoogleEmailInPage.toString() + ')()';

async function readEmailFromWebContents(wc) {
  try {
    const fromTitle = emailFromText(wc.getTitle());
    if (fromTitle) return fromTitle;
  } catch (e) {}
  try {
    const email = await wc.executeJavaScript(EXTRACT_GOOGLE_EMAIL_JS, true);
    return email || null;
  } catch (e) { return null; }
}

// No Gmail tab open — load Gmail once in a hidden window sharing the
// workspace's session, read the address, then throw the window away.
function loadGoogleEmailHidden(wsId) {
  return new Promise((resolve) => {
    let settled = false;
    let win;
    const finish = (email) => {
      if (settled) return;
      settled = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
      resolve(email || null);
    };
    try {
      win = new BrowserWindow({
        show: false, width: 960, height: 720,
        webPreferences: { partition: googlePartitionFor(wsId), sandbox: true, spellcheck: false, backgroundThrottling: false },
      });
    } catch (e) { return finish(null); }
    const wc = win.webContents;
    // Every session AEGIS browses with gets the centralized policy (ad
    // blocklist + permission handlers) — the Google auth partition included,
    // so no partition can open a site outside the permission framework.
    setupSession(wc.session, wsId);
    const poll = async () => {
      if (settled) return;
      try {
        const url = wc.getURL() || '';
        // Signed out or session revoked — no point waiting for Gmail.
        if (/accounts\.google\./.test(url) && /ServiceLogin|signin|signout/i.test(url)) return finish(null);
      } catch (e) {}
      const email = await readEmailFromWebContents(wc);
      if (email) return finish(email);
      setTimeout(poll, 500);
    };
    wc.on('did-finish-load', () => setTimeout(poll, 600));
    wc.on('did-fail-load', (e, code) => { if (code !== -3) finish(null); }); // -3 = aborted, keep waiting
    win.loadURL('https://mail.google.com/mail/u/0/').catch(() => finish(null));
    setTimeout(() => finish(null), 45000); // hard stop
  });
}

ipcMain.handle('get-google-accounts', async () => {
  if (!currentUser) return {};
  const out = {};
  await Promise.all(getWorkspaces(currentUser).map(async (w) => {
    watchGoogleEmailCookies(w.id);
    out[w.id] = await googleAccountSignedIn(w.id);
  }));
  startEmailWatch(); // workspace screen is up: watch for account changes
  return out;
});

// ── Stored email (SQL) + background watcher ──
// The address shown on the workspace card is persisted in
// workspaces.google_email so it survives restarts and can be viewed without
// re-reading the session. While the app runs, a watcher re-reads the open
// Gmail tabs (cheap: never opens hidden windows on its own) so another — or a
// newly opened — account on a workspace is detected and stored automatically.

function storeWorkspaceEmail(wsId, email) {
  // True when the stored value actually changed.
  try {
    if (!currentUser || !db || !email) return false;
    if (isGhostWs(wsId)) return false; // Ghost: nothing persisted
    const w = getWorkspace(currentUser, wsId);
    if (!w || (w.google_email || null) === email) return false;
    const encEmail = vaultEncRow('workspaces', { id: wsId, user_pseudo: currentUser, google_email: email }, currentUser);
    if (!encEmail) return false;
    db.prepare('UPDATE workspaces SET google_email=? WHERE user_pseudo=? AND id=?').run(encEmail.google_email, currentUser, wsId);
    return true;
  } catch (e) { return false; }
}

function applyWorkspaceEmail(wsId, email) {
  googleEmailCache.set(googlePartitionFor(wsId), email);
  if (storeWorkspaceEmail(wsId, email) && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('google-email-changed', { wsId, email });
  }
  return email;
}

// Read the address from an already-open Gmail tab (no hidden window).
async function emailFromOpenGmailTabs(wsId) {
  const tabs = workspaceTabs[wsId] || [];
  for (const t of tabs) {
    try {
      const wc = t.view.webContents;
      if ((wc.getURL() || '').includes('mail.google.com')) {
        const email = await readEmailFromWebContents(wc);
        if (email) return email;
      }
    } catch (e) {}
  }
  return null;
}

ipcMain.handle('get-google-email', async (e, wsId) => {
  if (!currentUser) return { ok: false, error: 'Not logged in.' };
  const id = (wsId || '').toString();
  const w = getWorkspace(currentUser, id);
  if (!w) return { ok: false, error: 'Unknown workspace.' };
  if (!(await googleAccountSignedIn(id))) return { ok: false, error: 'No Google account opened on this workspace.' };
  const key = googlePartitionFor(id);
  if (googleEmailCache.has(key)) return { ok: true, email: googleEmailCache.get(key) };
  // Fast path: a Gmail tab is already open in this workspace
  const fromTabs = await emailFromOpenGmailTabs(id);
  if (fromTabs) return { ok: true, email: applyWorkspaceEmail(id, fromTabs) };
  // First read for this workspace: load Gmail once in a hidden window.
  const email = await loadGoogleEmailHidden(id);
  if (email) return { ok: true, email: applyWorkspaceEmail(id, email) };
  // Signed in but unreadable right now — fall back to the stored address.
  if (w.google_email) return { ok: true, email: w.google_email, cached: true };
  return { ok: false, error: 'Could not read the account email.' };
});

// ── Background Google-email watcher ──
// Every 90s — and shortly after Google auth cookies change in a workspace
// partition (sign-in / account switch) — the open Gmail tabs are re-read; a
// different address is stored in SQL and pushed to the workspace screen.
let emailWatchTimer = null;
const emailCookieTimers = Object.create(null);
const emailCookieWatched = new Set();

function startEmailWatch() {
  if (emailWatchTimer) return;
  emailWatchTimer = setInterval(checkGoogleEmails, 90000);
}

function stopEmailWatch() {
  if (emailWatchTimer) { clearInterval(emailWatchTimer); emailWatchTimer = null; }
}

async function checkGoogleEmails() {
  if (!currentUser || !db) return;
  let wss = [];
  try { wss = getWorkspaces(currentUser); } catch (e) { return; }
  for (const w of wss) {
    try {
      watchGoogleEmailCookies(w.id);
      if (!(await googleAccountSignedIn(w.id))) continue;
      const email = await emailFromOpenGmailTabs(w.id);
      if (email) applyWorkspaceEmail(w.id, email);
    } catch (e) {}
  }
}

// Auth cookies changed in a workspace partition: re-read the open Gmail tabs
// once things settle (debounced; tab reads only — no hidden Gmail window, so
// routine cookie refreshes can never trigger a Gmail load storm).
function watchGoogleEmailCookies(wsId) {
  const key = googlePartitionFor(wsId);
  if (emailCookieWatched.has(key)) return;
  emailCookieWatched.add(key);
  try {
    session.fromPartition(key).cookies.on('changed', () => {
      if (!currentUser) return;
      clearTimeout(emailCookieTimers[wsId]);
      emailCookieTimers[wsId] = setTimeout(async () => {
        try {
          if (!currentUser || !getWorkspace(currentUser, wsId)) return;
          if (!(await googleAccountSignedIn(wsId))) return;
          const email = await emailFromOpenGmailTabs(wsId);
          if (email) applyWorkspaceEmail(wsId, email);
        } catch (e) {}
      }, 8000);
    });
  } catch (e) {}
}

ipcMain.handle('create-workspace', (e, name) => {
  if (!currentUser) return { ok: false, error: 'Not logged in.' };
  const id = 'ws_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const wsColors = ['#4a8bc5','#7a5db5','#48bb78','#e5834a','#e56a6a','#4ac5b5','#c5a84a','#9b5de5'];
  const existing = getWorkspaces(currentUser).length;
  const color = wsColors[existing % wsColors.length];
  const enc = vaultEncRow('workspaces', { id, user_pseudo: currentUser, name }, currentUser);
  if (!enc) return { ok: false, error: 'Could not create the workspace.' };
  db.prepare('INSERT INTO workspaces (id,user_pseudo,name,created,color) VALUES (?,?,?,?,?)').run(id, currentUser, enc.name, Date.now(), color);
  // Keep a currently-shown AEGIS/Workspaces menu in sync with the new entry.
  // (On the workspace screen the menu is intentionally cleared — the guard
  // leaves it cleared; openBrowser() builds it fresh on the way back.)
  if (Menu.getApplicationMenu()) buildMenu();
  return { ok: true, id, color };
});

ipcMain.handle('rename-workspace', (e, id, name) => {
  if (!currentUser) return { ok: false };
  if (isGhostWs(id)) return { ok: false, error: 'The Ghost Workspace cannot be renamed.' };
  if (!getWorkspace(currentUser, id)) return { ok: false };
  const enc = vaultEncRow('workspaces', { id, user_pseudo: currentUser, name }, currentUser);
  if (!enc) return { ok: false, error: 'Could not rename the workspace.' };
  db.prepare('UPDATE workspaces SET name=? WHERE id=? AND user_pseudo=?').run(enc.name, id, currentUser);
  if (Menu.getApplicationMenu()) buildMenu(); // menu label follows the rename
  return { ok: true };
});

ipcMain.handle('delete-workspace', (e, id) => {
  if (!currentUser) return { ok: false };
  if (isGhostWs(id)) return { ok: false, error: 'The Ghost Workspace cannot be deleted — it is simply discarded.' };
  const wss = getWorkspaces(currentUser);
  if (wss.length <= 1) return { ok: false, error: 'Cannot delete the last workspace.' };
  if (!getWorkspace(currentUser, id)) return { ok: false };
  if (workspaceTabs[id]) {
    workspaceTabs[id].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} t.view.webContents.close(); playingTabs.delete(t.id); });
    delete workspaceTabs[id];
  }
  for (const [tabId, info] of playingTabs) { if (info.workspaceId === id) playingTabs.delete(tabId); }
  updatePowerSaveBlocker();
  broadcastMediaState();
  db.transaction(() => {
    db.prepare('DELETE FROM tabs WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
    db.prepare('DELETE FROM history WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
    db.prepare('DELETE FROM bookmarks WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
    db.prepare('DELETE FROM notes WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
    db.prepare('DELETE FROM workspaces WHERE id=? AND user_pseudo=?').run(id, currentUser);
  })();
  invalidateBookmarkCache();
  const user = getUser(currentUser);
  if (user && user.active_workspace === id) {
    const remaining = getWorkspaces(currentUser);
    const nextId = remaining.length ? remaining[0].id : 'default';
    db.prepare('UPDATE users SET active_workspace=? WHERE pseudo=?').run(nextId, currentUser);
    if (currentWorkspace === id) currentWorkspace = nextId;
  }
  if (Menu.getApplicationMenu()) buildMenu(); // drop the deleted entry from the menu
  return { ok: true };
});

ipcMain.handle('select-workspace', (e, id) => {
  if (!currentUser) return { ok: false };
  if (!getWorkspace(currentUser, id)) return { ok: false };
  openBrowser(id);
  return { ok: true };
});

ipcMain.handle('switch-workspace', async (e, id) => {
  if (!currentUser) return { ok: false };
  if (!getWorkspace(currentUser, id)) return { ok: false };
  await switchWorkspace(id);
  return { ok: true };
});

// ── Split View ──

function enterSplitMode(rightWsId) {
  if (!currentUser || !currentWorkspace) return false;
  if (splitMode) return false;
  if (rightWsId === currentWorkspace) return false;
  // Split view is for two persistent workspaces: the Ghost Workspace's
  // in-memory session is never shared into a second pane.
  if (isGhostWs(rightWsId) || isGhostWs(currentWorkspace)) return false;
  if (!getWorkspace(currentUser, rightWsId)) return false;
  if (!workspaceTabs[rightWsId]) {
    const savedTabs = getTabsDb(currentUser, rightWsId);
    const st = getWorkspaceState(currentUser, rightWsId);
    workspaceTabs[rightWsId] = [];
    savedTabs.forEach(t => { if (t.url) addTabToSplit(t.url, rightWsId); });
    if (workspaceTabs[rightWsId].length === 0) addTabToSplit('https://www.google.com', rightWsId);
    // Restore previously active tab for consistency
    if (st && st.active_url) {
      const idx = (savedTabs || []).findIndex(s => s.url === st.active_url);
      if (idx >= 0 && workspaceTabs[rightWsId][idx]) setActiveId(rightWsId, workspaceTabs[rightWsId][idx].id);
      else if (!getActiveId(rightWsId)) setActiveId(rightWsId, workspaceTabs[rightWsId][0]?.id);
    } else if (!getActiveId(rightWsId)) setActiveId(rightWsId, workspaceTabs[rightWsId][0]?.id);
  }
  splitMode = true;
  splitLeft = currentWorkspace;
  splitRight = rightWsId;
  syncViews();
  buildMenu();
  const lWs = getWorkspace(currentUser, splitLeft);
  const rWs = getWorkspace(currentUser, splitRight);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-changed', { active: true, left: splitLeft, right: splitRight, leftName: lWs ? lWs.name : 'Left', rightName: rWs ? rWs.name : 'Right', focused: 'left' });
  return true;
}

function exitSplitMode() {
  if (!splitMode) return false;
  splitMode = false;
  currentWorkspace = splitLeft;
  splitLeft = null;
  splitRight = null;
  syncViews();
  broadcastTabs();
  buildMenu();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-changed', { active: false });
  return true;
}

ipcMain.handle('enter-split', (e, rightWsId) => ({ ok: enterSplitMode(rightWsId) }));

ipcMain.handle('exit-split', () => ({ ok: exitSplitMode() }));

ipcMain.handle('set-split-ratio', (e, ratio) => {
  splitRatio = Math.max(0.2, Math.min(0.8, ratio));
  syncViews();
  return { ok: true };
});

ipcMain.handle('focus-split-pane', (e, side) => {
  if (!splitMode) return;
  if (side === 'left' && splitLeft) currentWorkspace = splitLeft;
  else if (side === 'right' && splitRight) currentWorkspace = splitRight;
  broadcastTabs();
  const lWs = getWorkspace(currentUser, splitLeft);
  const rWs = getWorkspace(currentUser, splitRight);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-changed', { active: true, left: splitLeft, right: splitRight, leftName: lWs ? lWs.name : 'Left', rightName: rWs ? rWs.name : 'Right', focused: side });
});

ipcMain.handle('save-tabs', () => { saveUserTabsPersist(); return { ok: true }; });

function addTabToSplit(url, wsId) {
  const tabs = workspaceTabs[wsId] || [];
  const id = idCounter++;
  const splitPartition = partitionFor(wsId);
  usedPartitions.add(splitPartition);
  const view = new WebContentsView({
    webPreferences: contentWebPreferences(splitPartition),
  });
  const ses = view.webContents.session;
  setupSession(ses, wsId);
  view.setBounds({ x:0, y:TOP, width:100, height:100 });
  safeLoadURL(view.webContents, url);
  setupF11Handler(view.webContents);
  const emit = (event, extra) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, { id, title: view.webContents.getTitle(), url: view.webContents.getURL(), ws: wsId, ...extra });
  };
  function emitNav() { emit('nav-state', { canGoBack: view.webContents.navigationHistory.canGoBack(), canGoForward: view.webContents.navigationHistory.canGoForward(), ws: wsId }); }
  function updatePlayingTabMeta() {
    if (playingTabs.has(id)) {
      // Spread the existing entry: it also carries workspaceId, which the
      // "jump to the playing workspace" pill depends on.
      playingTabs.set(id, { ...playingTabs.get(id), title: view.webContents.getTitle(), url: view.webContents.getURL() });
      broadcastMediaState();
    }
  }
  view.webContents.on('page-title-updated', (e, t) => { emit('tab-updated', { title: t, ws: wsId }); updatePlayingTabMeta(); scheduleTabSave(); });
  view.webContents.on('page-favicon-updated', (e, favicons) => { if (favicons && favicons.length > 0) { const tab = tabs.find(t => t.id === id); if (tab) tab.favicon = favicons[0]; emit('tab-updated', { favicon: favicons[0], ws: wsId }); } });
  function resetFavicon() { const tab = tabs.find(t => t.id === id); if (tab) tab.favicon = ''; }
  view.webContents.on('did-navigate', (e, u) => { resetFavicon(); emit('tab-updated', { url: u, favicon: '', ws: wsId }); emitNav(); addHistory(u, view.webContents.getTitle(), wsId); saveUserTabsPersist(); if (u && u !== 'about:blank') { ensureSession(); recordVisitStart(id, u, view.webContents.getTitle(), wsId); } });
  view.webContents.on('did-navigate-in-page', (e, u) => { if (e.isMainFrame) { resetFavicon(); emit('tab-updated', { url: u, favicon: '', ws: wsId }); emitNav(); addHistory(u, view.webContents.getTitle(), wsId); scheduleTabSave(); if (u && u !== 'about:blank') { ensureSession(); recordVisitStart(id, u, view.webContents.getTitle(), wsId); } } });
  view.webContents.on('did-start-loading', () => emit('tab-loading', { loading: true }));
  view.webContents.on('did-stop-loading', () => { emit('tab-loading', { loading: false }); emitNav(); });
  view.webContents.on('update-target-url', (e, u) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status-url', u || ''); });
  view.webContents.on('found-in-page', (e, result) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('find-result', result); });
  view.webContents.on('media-started-playing', () => {
    playingTabs.set(id, { title: view.webContents.getTitle(), url: view.webContents.getURL(), workspaceId: wsId });
    updatePowerSaveBlocker();
    broadcastMediaState();
  });
  view.webContents.on('media-paused', () => {
    playingTabs.delete(id);
    updatePowerSaveBlocker();
    broadcastMediaState();
  });
  view.webContents.on('enter-html-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('html-fullscreen', true);
      view.setBounds({ x: 0, y: 0, width: mainWindow.getBounds().width, height: mainWindow.getBounds().height });
    }
  });
  view.webContents.on('leave-html-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('html-fullscreen', false);
      syncViews();
    }
  });
  view.webContents.setWindowOpenHandler((details) => handleWindowOpen(view.webContents, details));
  setupContextMenu(view.webContents);
  tabs.push({ id, view, url, title: '', favicon: '' });
  workspaceTabs[wsId] = tabs;
  setActiveId(wsId, id);
  return id;
}

// ── Browser IPC ──

ipcMain.handle('cleanup-tabs', () => {
  saveUserTabsPersist();
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  });
  closeGhostWorkspace(); // Ghost: discard its session before the screen goes away
  currentWorkspace = null;
  splitMode = false; splitLeft = null; splitRight = null;

  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  Menu.setApplicationMenu(null);
  broadcastMediaState();
  return { ok: true };
});

ipcMain.on('clear-menu', () => Menu.setApplicationMenu(null));

ipcMain.on('enter-browser', () => {
  if (!getUser(currentUser)) return;
  ensureDefaultWs(currentUser);
  Menu.setApplicationMenu(null);
  mainWindow.loadFile('workspace.html');
});

function tabForWorkspace(wsId) {
  const tabs = workspaceTabs[wsId];
  if (!tabs) return null;
  const id = getActiveId(wsId);
  return tabs.find(t => t.id === id) || (tabs.length > 0 ? tabs[0] : null);
}

ipcMain.on('navigate', (e, url) => { const t = activeTab(); if (t) t.view.webContents.loadURL(url); });
ipcMain.on('navigate-workspace', (e, wsId, url) => { const t = tabForWorkspace(wsId); if (t) t.view.webContents.loadURL(url); });
ipcMain.on('navigate-new-tab', (e, url) => addTab(url || 'https://www.google.com'));
ipcMain.on('new-tab', (e, u) => addTab(u || 'https://www.google.com'));
ipcMain.on('new-tab-workspace', (e, wsId, u) => {
  const prev = currentWorkspace;
  currentWorkspace = wsId;
  addTab(u || 'https://www.google.com');
  currentWorkspace = prev;
  syncViews();
});
ipcMain.on('close-tab', (e, id) => closeTab(id));
ipcMain.on('close-tab-workspace', (e, wsId, id) => {
  const prev = currentWorkspace;
  currentWorkspace = wsId;
  closeTab(id);
  currentWorkspace = prev;
  syncViews();
});
ipcMain.on('activate-tab', (e, id) => showTab(id));
ipcMain.on('tab-context-menu', (e, id, wsId) => {
  const tabs = wsId ? workspaceTabs[wsId] : currentTabs();
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  const isMuted = t.view.webContents.audioMuted;
  const template = [
    { label: isMuted ? 'Unmute Tab' : 'Mute Tab', click: () => t.view.webContents.audioMuted = !isMuted },
    { label: 'Duplicate Tab', click: () => { if (wsId) { const prev = currentWorkspace; currentWorkspace = wsId; addTab(t.view.webContents.getURL()); currentWorkspace = prev; syncViews(); } else addTab(t.view.webContents.getURL()); } },
    { type: 'separator' },
    { label: 'Close Tab', click: () => closeTab(id) }
  ];
  Menu.buildFromTemplate(template).popup({ window: mainWindow });
});
ipcMain.on('activate-tab-workspace', (e, wsId, id) => {
  const prev = currentWorkspace;
  currentWorkspace = wsId;
  showTab(id);
  currentWorkspace = prev;
  if (splitMode) syncViews();
});
ipcMain.on('go-back', () => { const t = activeTab(); if (t) t.view.webContents.goBack(); });
ipcMain.on('go-back-workspace', (e, wsId) => { const t = tabForWorkspace(wsId); if (t) t.view.webContents.goBack(); });
ipcMain.on('go-forward', () => { const t = activeTab(); if (t) t.view.webContents.goForward(); });
ipcMain.on('go-forward-workspace', (e, wsId) => { const t = tabForWorkspace(wsId); if (t) t.view.webContents.goForward(); });
ipcMain.on('reload', () => { const t = activeTab(); if (t) t.view.webContents.reload(); });
ipcMain.on('reload-workspace', (e, wsId) => { const t = tabForWorkspace(wsId); if (t) t.view.webContents.reload(); });
ipcMain.on('stop', () => { const t = activeTab(); if (t) t.view.webContents.stop(); });
ipcMain.on('stop-workspace', (e, wsId) => { const t = tabForWorkspace(wsId); if (t) t.view.webContents.stop(); });
ipcMain.on('resize-content', () => syncViews());
ipcMain.on('panel-toggle', (e, open) => { panelOpen = open; syncViews(); });

// Workspace-wide download shelf: controls.html reserves a bottom strip (like
// panelOpen reserves a right strip) so the shelf's progress cards render in
// chrome-owned pixels above every page view, on every tab.
ipcMain.on('dl-shelf-reserve', (e, h) => {
  const v = Math.max(0, Math.round(Number(h) || 0));
  if (v === shelfReserve) return;
  shelfReserve = v;
  syncViews();
});
ipcMain.on('open-history', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('show-history'); });
ipcMain.handle('get-tabs', () => {
  const tabs = currentTabs().map(t => {
    let u = ''; try { u = t.view.webContents.getURL(); } catch(e) { u = t.url || ''; }
    let ti = ''; try { ti = t.view.webContents.getTitle(); } catch(e) { ti = t.title || ''; }
    return { id: t.id, url: u || t.url || '', title: ti || t.title || '' };
  });
  return { tabs, activeId: getActiveId(currentWorkspace) };
});

ipcMain.handle('get-tabs-for-workspace', (e, wsId) => {
  const tabs = workspaceTabs[wsId];
  if (!tabs) return { tabs: [], activeId: getActiveId(wsId) };
  const list = tabs.map(t => {
    let u = ''; try { u = t.view.webContents.getURL(); } catch(e) { u = t.url || ''; }
    let ti = ''; try { ti = t.view.webContents.getTitle(); } catch(e) { ti = t.title || ''; }
    return { id: t.id, url: u || t.url || '', title: ti || t.title || '' };
  });
  return { tabs: list, activeId: getActiveId(wsId) };
});

ipcMain.handle('get-media-state', () => mediaStatePayload());

let suggestAbort = null;
ipcMain.handle('fetch-suggestions', async (e, q) => {
  if (!q || !q.trim()) return [];
  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();
  try {
    const res = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&q=' + encodeURIComponent(q), { signal: suggestAbort.signal, cache: 'force-cache' });
    const data = await res.json();
    return data[1] || [];
  } catch(e) { return []; }
});

// ── Connection info (public IP, country, governorate, ISP) ──
// Fetched on demand when the user opens the Connection panel. Keyless HTTPS
// geo-IP endpoints, tried in order; result cached 5 min so re-opening the
// panel doesn't re-hit the network. Nothing is stored on disk.
let connInfoCache = null; // { at, data }
ipcMain.handle('get-connection-info', async (e, force) => {
  if (!force && connInfoCache && (Date.now() - connInfoCache.at) < 300000) return connInfoCache.data;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  const grab = async (url, map) => {
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return map(await res.json());
  };
  try {
    let data = null;
    // Primary: ipwho.is — IP, country, gouvernorat, ISP/ASN in one keyless call
    try {
      data = await grab('https://ipwho.is/', d => (d && d.success !== false && d.ip ? {
        ok: true, ip: d.ip, type: d.type || '', country: d.country || '', countryCode: d.country_code || '',
        flag: (d.flag && d.flag.emoji) || '', region: d.region || '', city: d.city || '',
        isp: (d.connection && (d.connection.isp || d.connection.org)) || '', org: (d.connection && d.connection.org) || '',
        asn: (d.connection && d.connection.asn) || '', domain: (d.connection && d.connection.domain) || '',
        timezone: (d.timezone && d.timezone.id) || '', utc: (d.timezone && d.timezone.utc) || '',
        source: 'ipwho.is'
      } : null));
    } catch (err) { data = null; }
    // Fallback: freeipapi.com — same essentials if the primary is unreachable
    if (!data) {
      data = await grab('https://freeipapi.com/api/json', d => (d && d.ipAddress ? {
        ok: true, ip: d.ipAddress, type: d.ipVersion === 6 ? 'IPv6' : 'IPv4', country: d.countryName || '', countryCode: d.countryCode || '',
        flag: '', region: d.regionName || '', city: d.cityName || '',
        isp: d.asnOrganization || '', org: d.asnOrganization || '',
        asn: d.asn || '', domain: '', timezone: (d.timeZones && d.timeZones[0]) || '', utc: '',
        source: 'freeipapi.com'
      } : null));
    }
    if (!data) throw new Error('empty response');
    connInfoCache = { at: Date.now(), data };
    return data;
  } catch (err) {
    return { ok: false, error: (err && err.name === 'AbortError') ? 'The lookup timed out' : 'Could not reach the IP lookup service' };
  } finally { clearTimeout(t); }
});

// ── Internet speed test ("Test Internet speed" in the Connection panel) ──
// Latency and jitter come from tiny no-store requests; download and upload
// stream a payload from public keyless test endpoints, tried in order. It all
// runs in the main process (the renderer never touches the network) and progress
// is streamed back on 'speed-progress' while the invoke is still pending. Only
// dummy test files move — no user data is sent and nothing is stored on disk.
let speedTestRunning = false;
const SPEED_PING_URLS = [
  'https://speed.cloudflare.com/__down?bytes=0',
  'https://cp.cloudflare.com/generate_204',
  'https://www.gstatic.com/generate_204'
];
const SPEED_DOWN_SOURCES = [
  { label: 'Cloudflare', url: 'https://speed.cloudflare.com/__down?bytes=25000000' },
  { label: 'OVH', url: 'https://proof.ovh.net/files/10Mb.dat' },
  { label: 'Hetzner', url: 'https://ash-speed.hetzner.com/10MB.bin' }
];
const SPEED_UP_SOURCES = [
  { label: 'Cloudflare', url: 'https://speed.cloudflare.com/__up' },
  { label: 'HTTPBin', url: 'https://httpbin.org/post' }
];

// Mbps over the transfer, skipping the first ~700 ms of ramp-up so the
// handshake doesn't drag the number down.
function speedRate(bytes, ms, warmT, warmB) {
  let t = 0, b = 0;
  if (warmT != null && (ms - warmT) > 150) { t = warmT; b = warmB; }
  const secs = (ms - t) / 1000;
  if (secs <= 0 || bytes <= b) return 0;
  return (bytes - b) * 8 / secs / 1e6;
}

// Average round-trip over up to 4 samples (first one dropped as warm-up) plus
// the mean sample-to-sample variation = jitter. Throws only if nothing answered.
async function speedPing(send) {
  const rtts = [];
  const deadline = Date.now() + 12000;
  for (let u = 0; u < SPEED_PING_URLS.length && rtts.length < 4 && Date.now() < deadline; u++) {
    const base = SPEED_PING_URLS[u];
    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    const hit = async () => {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 4000);
      const t0 = Date.now();
      try {
        const res = await fetch(base + sep + 'r=' + Math.random().toString(36).slice(2), { cache: 'no-store', signal: ac.signal });
        await res.arrayBuffer();
        return Date.now() - t0;
      } finally { clearTimeout(to); }
    };
    let rtt;
    try { rtt = await hit(); } catch (err) { continue; } // dead host — try the next one
    rtts.push(rtt);
    send({ phase: 'ping', pct: 3 + Math.round((rtts.length / 4) * 17), label: 'Measuring latency', live: rtt + ' ms round-trip' });
    // Same host answered, so the rest of the samples are cheap: reuse it.
    for (let i = 1; i < 4 && rtts.length < 4 && Date.now() < deadline; i++) {
      try { const r2 = await hit(); rtts.push(r2);
        send({ phase: 'ping', pct: 3 + Math.round((rtts.length / 4) * 17), label: 'Measuring latency', live: r2 + ' ms round-trip' });
      } catch (err) { break; }
    }
    if (rtts.length >= 3) break;
  }
  if (!rtts.length) throw new Error('no latency sample');
  const use = rtts.length > 3 ? rtts.slice(1) : rtts.slice();
  const avg = Math.round(use.reduce((a, b) => a + b, 0) / use.length);
  let jitter = 0;
  if (use.length >= 2) {
    let d = 0;
    for (let i = 1; i < use.length; i++) d += Math.abs(use[i] - use[i - 1]);
    jitter = Math.round(d / (use.length - 1));
  }
  return { ping: avg, jitter, samples: use.length };
}

// Streams up to 7 s (or 15 MB) of payload, reporting progress per chunk.
// Falls through to the next source when a host yields nothing usable.
async function speedDownload(send) {
  let lastErr = null;
  for (const src of SPEED_DOWN_SOURCES) {
    const ac = new AbortController();
    const hard = setTimeout(() => ac.abort(), 25000);
    let reader = null, bytes = 0, t0 = 0, warmT = null, warmB = 0, broke = false;
    try {
      const res = await fetch(src.url, { cache: 'no-store', signal: ac.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      reader = (res.body && res.body.getReader) ? res.body.getReader() : null;
      if (!reader) throw new Error('streaming unsupported');
      let lastSent = 0;
      while (true) {
        let chunk;
        try { chunk = await reader.read(); } catch (err) { broke = true; break; } // hard timeout: keep what we got
        if (chunk.done) break;
        if (!t0) t0 = Date.now();
        if (chunk.value) bytes += chunk.value.length;
        const el = Date.now() - t0;
        if (warmT === null && el >= 700) { warmT = el; warmB = bytes; }
        // Throttled: a fast link hands over hundreds of chunks per second and
        // each one would otherwise become an IPC round-trip.
        if (Date.now() - lastSent >= 200) {
          lastSent = Date.now();
          const frac = Math.min(1, Math.max(el / 7000, bytes / 15000000));
          send({ phase: 'download', pct: 20 + Math.round(frac * 45), label: 'Measuring download speed',
                 live: '↓ ' + speedRate(bytes, el, warmT, warmB).toFixed(1) + ' Mbps — ' + (bytes / 1e6).toFixed(1) + ' MB' });
        }
        if (el >= 7000) break;
      }
      clearTimeout(hard);
      try { if (reader && !broke) reader.cancel(); } catch (err) {}
      if (!t0 || bytes < 20000) throw new Error('no usable data');
      const mbps = speedRate(bytes, Date.now() - t0, warmT, warmB);
      if (!(mbps > 0)) throw new Error('bad rate');
      return { mbps: +mbps.toFixed(2), bytes, ms: Date.now() - t0, server: src.label };
    } catch (err) {
      lastErr = err;
      clearTimeout(hard);
      try { if (reader) reader.cancel(); } catch (e) {}
    }
  }
  throw lastErr || new Error('no download source reachable');
}

// Upload has no stream progress, so the tick only reports elapsed time while
// the request is in flight. Never fatal: a blocked upload still yields a report.
async function speedUpload(send, dlMbps) {
  const size = dlMbps == null ? 4000000 : dlMbps >= 25 ? 8000000 : dlMbps >= 5 ? 4000000 : 1000000;
  let payload;
  try { payload = crypto.randomBytes(size); } catch (e) { return null; }
  const budgetEnd = Date.now() + 25000; // shared across every source, so the test never stalls
  for (const src of SPEED_UP_SOURCES) {
    const left = budgetEnd - Date.now();
    if (left < 3000) break;
    const ac = new AbortController();
    const hard = setTimeout(() => ac.abort(), left);
    const t0 = Date.now();
    let tick = null;
    try {
      tick = setInterval(() => {
        const el = Date.now() - t0;
        send({ phase: 'upload', pct: Math.round(Math.min(88, 65 + (el / 15000) * 23)), label: 'Measuring upload speed',
               live: '↑ ' + (payload.length / 1e6).toFixed(1) + ' MB — ' + (el / 1000).toFixed(1) + ' s' });
      }, 250);
      send({ phase: 'upload', pct: 66, label: 'Measuring upload speed', live: '↑ sending ' + (payload.length / 1e6).toFixed(1) + ' MB…' });
      const res = await fetch(src.url, { method: 'POST', cache: 'no-store', signal: ac.signal,
        headers: { 'content-type': 'application/octet-stream' }, body: payload });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await res.arrayBuffer();
      const el = Math.max(1, Date.now() - t0);
      return { mbps: +(payload.length * 8 / (el / 1000) / 1e6).toFixed(2), bytes: payload.length, server: src.label };
    } catch (err) { /* try the next source */ }
    finally { if (tick) clearInterval(tick); clearTimeout(hard); }
  }
  return null;
}

// 0–100 sub-scores. A score of 0 always means "not measured", never "terrible".
function speedDlScore(v) {
  if (v == null) return 0;
  if (v >= 300) return 100; if (v >= 100) return 96; if (v >= 50) return 88; if (v >= 25) return 75;
  if (v >= 10) return 60; if (v >= 5) return 45; if (v >= 1) return 30; return 10;
}
function speedUlScore(v) {
  if (v == null) return 0;
  if (v >= 200) return 100; if (v >= 50) return 90; if (v >= 20) return 80; if (v >= 10) return 68;
  if (v >= 5) return 55; if (v >= 2) return 40; if (v >= 0.5) return 25; return 10;
}
function speedPingScore(v) {
  if (v == null) return 0;
  if (v <= 10) return 100; if (v <= 20) return 95; if (v <= 40) return 85; if (v <= 60) return 75;
  if (v <= 100) return 55; if (v <= 150) return 40; if (v <= 250) return 22; return 8;
}
function speedJitterScore(v) {
  if (v == null) return 0;
  if (v <= 2) return 100; if (v <= 5) return 90; if (v <= 10) return 75; if (v <= 20) return 60;
  if (v <= 40) return 40; return 18;
}

// What the connection is actually good for, one row per use case.
function speedUses(dl, ul, ping, jitter) {
  const lvl = (v, a, b, c) => (v == null ? 'bad' : v >= a ? 'good' : v >= b ? 'ok' : v >= c ? 'mid' : 'bad');
  const order = ['bad', 'mid', 'ok', 'good'];
  const down = (s) => order[Math.max(0, order.indexOf(s) - 1)];
  let call = lvl(ul, 10, 3, 1);
  if (dl != null && dl < 3) call = down(call);
  if (ping != null && ping > 150) call = down(call);
  let game;
  if (ping == null) game = 'bad';
  else if (ping <= 30 && (jitter == null || jitter <= 10)) game = 'good';
  else if (ping <= 60 && (jitter == null || jitter <= 25)) game = 'ok';
  else if (ping <= 120 && (jitter == null || jitter <= 50)) game = 'mid';
  else game = 'bad';
  const labels = { good: 'Excellent', ok: 'Good', mid: 'Fair', bad: 'Poor' };
  const rows = [
    { name: 'Browsing & web apps', state: lvl(dl, 25, 8, 2) },
    { name: 'HD streaming (1080p)', state: lvl(dl, 40, 8, 3) },
    { name: '4K / UHD streaming', state: lvl(dl, 120, 40, 15) },
    { name: 'Video calls (Meet, Zoom)', state: call },
    { name: 'Online gaming', state: game },
    { name: 'Large file downloads', state: lvl(dl, 100, 25, 6) }
  ];
  return rows.map(r => ({ name: r.name, state: r.state, label: labels[r.state] }));
}

function speedTips(dl, ul, ping, jitter) {
  const t = [];
  if (ping != null && ping > 100) t.push('Latency is high (' + ping + ' ms) — prefer a wired connection, or move closer to your router and away from interference.');
  else if (ping != null && ping > 60) t.push('Latency is a bit high (' + ping + ' ms) for fast-paced games and crystal-clear calls.');
  if (jitter != null && jitter > 20) t.push('Jitter is high (' + jitter + ' ms) — the connection is unstable, so calls and games will hiccup.');
  if (ul != null && ul < 3) t.push('Upload is limited (' + ul + ' Mbps) — video calls may freeze or blur and sharing files will be slow.');
  if (dl != null && dl < 5) t.push('Download is slow (' + dl + ' Mbps) — close apps that sync, stream or update, and check other devices using the network.');
  if (ul == null && dl != null) t.push('Upload could not be measured — a firewall or proxy may be blocking the test.');
  if (!t.length) t.push('Nothing looks weak: this connection comfortably handles streaming, downloads, gaming and calls together.');
  return t.slice(0, 3);
}

const SPEED_VERDICTS = {
  'Excellent': 'Ready for 4K streaming, cloud gaming and large downloads — even with several people online at once.',
  'Very good': 'Comfortably handles several HD/4K streams, video calls and fast downloads at the same time.',
  'Good': 'Good for full-HD streaming, video calls and everyday work across a few devices.',
  'Fair': 'Fine for browsing and HD video, but heavy downloads, big uploads and long calls will feel limited.',
  'Poor': 'Best for light browsing and messaging — streaming, calls and downloads will often stall.',
  'Very poor': 'The connection is very weak — expect buffering, timeouts and pages that fail to load.'
};

function speedEvaluate(down, up, lat) {
  const dl = down ? down.mbps : null;
  const ul = up ? up.mbps : null;
  const ping = lat ? lat.ping : null;
  const jitter = lat ? lat.jitter : null;
  const parts = [[speedDlScore(dl), 0.40], [speedUlScore(ul), 0.20], [speedPingScore(ping), 0.25], [speedJitterScore(jitter), 0.15]];
  let score = 0, wsum = 0;
  for (const [s, w] of parts) if (s > 0) { score += s * w; wsum += w; }
  score = wsum ? Math.round(score / wsum) : 0;
  const rating = score >= 88 ? 'Excellent' : score >= 76 ? 'Very good' : score >= 62 ? 'Good'
    : score >= 46 ? 'Fair' : score >= 30 ? 'Poor' : 'Very poor';
  return {
    ok: true, score, rating, verdict: SPEED_VERDICTS[rating],
    download: dl, upload: ul, ping, jitter,
    server: (down && down.server) || '', uses: speedUses(dl, ul, ping, jitter),
    tips: speedTips(dl, ul, ping, jitter), at: Date.now()
  };
}

ipcMain.handle('test-internet-speed', async (e) => {
  const send = (d) => { try { if (e && e.sender && !e.sender.isDestroyed()) e.sender.send('speed-progress', d); } catch (err) {} };
  if (speedTestRunning) return { ok: false, error: 'A speed test is already running' };
  speedTestRunning = true;
  try {
    send({ phase: 'ping', pct: 2, label: 'Measuring latency', live: 'Contacting a test server…' });
    let latency = null;
    try { latency = await speedPing(send); } catch (err) { latency = null; }
    send({ phase: 'download', pct: 20, label: 'Measuring download speed', live: '…' });
    const down = await speedDownload(send); // throws when no source answers
    const up = await speedUpload(send, down.mbps);
    const out = speedEvaluate(down, up, latency);
    send({ phase: 'done', pct: 100, label: 'Test complete', live: '' });
    return out;
  } catch (err) {
    send({ phase: 'error', pct: 0, label: 'Test failed', live: '' });
    return { ok: false, error: (err && err.name === 'AbortError')
      ? 'The test timed out — the connection looks too slow or blocked'
      : 'Could not reach any speed-test server — check your connection, firewall or proxy' };
  } finally { speedTestRunning = false; }
});

// ── YouTube video download ──
// A "Download" button appears in the toolbar while a YouTube page is open.
// Probing formats and downloading run in the MAIN process through yt-dlp
// (+ ffmpeg to merge the separate 1080p video and audio tracks); both tools
// are located or auto-provisioned once by yt-tools.js. The renderer only asks
// for probe results and start/cancel, matching the Connection-panel rule that
// the renderer never touches the network itself.
let ytToolsReady = null;               // provisioning promise (retried after failure)
// Every in-flight YouTube download, keyed by its shared download id. Jobs are
// independent: each mirrors its own progress into the downloads list and its
// own yt-progress events, so the toolbar popover, the workspace-wide shelf and
// several tabs can drive downloads at the same time without duplication.
const ytJobs = new Map();
const ytProbeInflight = new Map();     // videoId -> pending probe promise
const ytInfoCache = new Map();         // videoId -> { at, info }
const YT_INFO_TTL = 15 * 60 * 1000;

function ytSend(d) {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('yt-progress', d); } catch (e) {}
}

function ytSetupLabel(p) {
  const mb = (n) => (n > 0 ? (n / 1048576).toFixed(1) + ' MB' : '');
  if (p.state === 'installed') return p.tool + ' ready';
  if (p.total > 0) return 'Preparing ' + p.tool + ' — ' + mb(p.received) + ' of ' + mb(p.total);
  return 'Preparing ' + p.tool + '… ' + mb(p.received);
}

function ytEnsureTools() {
  if (!ytToolsReady) {
    let lastTick = 0;
    const stepBase = { 'yt-dlp': 0, ffmpeg: 0.5 };
    ytToolsReady = ytEngine.ensureTools({
      onProgress: (p) => {
        const done = p.state === 'installed';
        const now = Date.now();
        if (!done && now - lastTick < 200) return; // throttled; phase changes are never dropped
        lastTick = now;
        const base = stepBase[p.tool] != null ? stepBase[p.tool] : 0;
        const frac = done ? 0.5 : Math.min(0.4999, (p.pct || 0) / 200);
        ytSend({ phase: 'setup', tool: p.tool, state: p.state, pct: Math.round((base + frac) * 100),
                 label: ytSetupLabel(p), received: p.received || 0, total: p.total || 0 });
      },
    }).catch((err) => { ytToolsReady = null; throw err; });
  }
  return ytToolsReady;
}

// spawn() with streamed stdout/stderr, optional wall-clock timeout and child
// handle callback (the download job needs it for cancel/quit kills).
function ytRun(bin, args, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); } catch (e) { return reject(e); }
    if (o.onSpawn) { try { o.onSpawn(child); } catch (e) {} }
    let out = '', err = '', killed = false;
    const timer = o.timeoutMs ? setTimeout(() => { killed = true; try { child.kill(); } catch (e) {} }, o.timeoutMs) : null;
    child.stdout.on('data', (b) => {
      const s = b.toString();
      if (out.length < 40000000) out += s;
      if (o.onStdout) { try { o.onStdout(s); } catch (e) {} }
    });
    child.stderr.on('data', (b) => { if (err.length < 4000000) err += b.toString(); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout: out, stderr: err, killed }); });
  });
}

function ytErrorFrom(r) {
  const text = (r.stderr || '') + '\n' + (r.stdout || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^ERROR:\s*(.+)$/);
    if (m) return m[1].slice(0, 300);
  }
  return null;
}

// Qualities at or below 1080p, biggest first. Sizes are estimates: the best
// video format per height (mp4 preferred for compatibility) plus the best
// separate audio track when the video format carries none. Many YouTube
// formats report no filesize at all, so fall back to bitrate x duration.
function ytBuildQualities(info) {
  const dur = Number(info.duration) || 0;
  // bytes for one format: known size first, else bitrate (kbps) x duration.
  const fBytes = (f, br) => {
    const known = f.filesize || f.filesize_approx;
    if (known) return known;
    const kbps = br || f.tbr || f.vbr || f.abr || 0;
    return (kbps > 0 && dur > 0) ? Math.round(kbps * 1000 * dur / 8) : 0;
  };
  const fmts = (info.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none');
  const audio = (info.formats || [])
    .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0] || null;
  const audioSize = audio ? fBytes(audio, audio.abr) : 0;
  // Prefer mp4 (compatibility), then a format that reports a real filesize
  // (so the shown estimate matches the file that will actually be fetched),
  // then bitrate.
  const score = (x) => (x.ext === 'mp4' ? 2 : x.ext === 'webm' ? 1 : 0) * 1000000
    + ((x.filesize || x.filesize_approx) ? 100000 : 0) + (x.tbr || 0);
  const byH = new Map();
  for (const f of fmts) {
    const h = f.height;
    if (!h || h > 1080) continue;
    const prev = byH.get(h);
    if (!prev || score(f) > score(prev)) byH.set(h, f);
  }
  const qualities = [];
  byH.forEach((f, h) => {
    const muxed = !!(f.acodec && f.acodec !== 'none');
    const size = fBytes(f) + (muxed ? 0 : audioSize);
    qualities.push({ h, size: size > 0 ? size : null, ext: f.ext || 'mp4', muxed });
  });
  qualities.sort((a, b) => b.h - a.h);
  return qualities;
}

async function ytProbeInfo(rawUrl) {
  const vid = ytEngine.videoId(rawUrl);
  if (!vid) return { ok: false, error: 'This is not a YouTube video link' };
  const hit = ytInfoCache.get(vid);
  if (hit && Date.now() - hit.at < YT_INFO_TTL) return hit.info;
  if (ytProbeInflight.has(vid)) return ytProbeInflight.get(vid);
  const pending = (async () => {
    const tools = await ytEnsureTools();
    ytSend({ phase: 'probe', pct: 0, label: 'Reading video details…' });
    const r = await ytRun(tools.ytdlp, ['-J', '--no-playlist', '--no-warnings', rawUrl], { timeoutMs: 90000 });
    if (r.killed) throw new Error('Reading the video details timed out');
    if (r.code !== 0) throw new Error(ytErrorFrom(r) || 'Could not read this video');
    let info;
    try { info = JSON.parse(r.stdout.replace(/^\uFEFF/, '')); } catch (e) { throw new Error('Could not read this video'); }
    if (info && info.is_live) throw new Error('Live streams cannot be downloaded');
    const qualities = ytBuildQualities(info || {});
    if (!qualities.length) throw new Error('No downloadable quality was found for this video');
    const data = {
      ok: true, id: vid, title: info.title || vid, channel: info.channel || info.uploader || '',
      thumbnail: info.thumbnail || '', duration: info.duration || 0,
      qualities, // highest first
      defaultH: qualities.some((q) => q.h === 1080) ? 1080 : qualities[0].h, // always 1080p when offered
    };
    ytInfoCache.set(vid, { at: Date.now(), info: data });
    return data;
  })().finally(() => ytProbeInflight.delete(vid));
  ytProbeInflight.set(vid, pending);
  return pending;
}

ipcMain.handle('yt-video-info', async (e, url) => {
  try { return await ytProbeInfo(url); }
  catch (err) { return { ok: false, error: (err && err.message) || 'Could not read this video' }; }
});

// "80.00MiB" -> bytes.
function ytSizeBytes(s) {
  const m = String(s || '').match(/([\d.]+)\s*([KMG]?I?B)/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1000, KIB: 1024, MB: 1e6, MIB: 1048576, GB: 1e9, GIB: 1073741824 };
  return Math.round(parseFloat(m[1]) * (mult[m[2].toUpperCase()] || 1));
}

// "1.23MiB/s" -> bytes per second (for the shared downloads list).
function ytRateBytes(s) {
  return ytSizeBytes(String(s == null ? '' : s).replace(/\/s$/i, ''));
}

// The --print line gives the final path after the merge; fall back to a scan
// of the target folder (skipping leftover .f123.partial-format files).
function ytResolveOutput(outDir, vid, printed) {
  if (printed && printed.length < 400 && fs.existsSync(printed)) return printed;
  try {
    const tag = '[' + vid + ']';
    let best = null;
    for (const n of fs.readdirSync(outDir)) {
      if (n.indexOf(tag) === -1) continue;
      if (/\.\d+f\d+\./i.test(n)) continue;
      if (!/\.(mp4|mkv|webm|m4v|mov|avi)$/i.test(n)) continue;
      const p = path.join(outDir, n);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
    }
    return best ? best.path : null;
  } catch (e) { return null; }
}

// A killed/failed yt-dlp leaves .part / .f123 fragment / .ytdl files behind;
// sweep this video's leftovers so Downloads only holds finished files.
function ytCleanupPartials(outDir, vid) {
  const tag = '[' + vid + ']';
  let names = [];
  try { names = fs.readdirSync(outDir); } catch (e) { return; }
  for (const n of names) {
    if (n.indexOf(tag) === -1) continue;
    if (!/\.(part|ytdl|temp)$/i.test(n) && !/\.f\d+\./i.test(n)) continue;
    try { fs.unlinkSync(path.join(outDir, n)); } catch (e) {}
  }
}

function ytKillTree(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch (e) { try { child.kill(); } catch (e2) {} }
}

// Mirror the job into the shared per-workspace downloads list so the regular
// Downloads panel shows it live (same event shape as handleDownload).
function ytMirror(job, patch) {
  const entry = job.entry;
  if (patch) Object.assign(entry, patch);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', {
      id: entry.id, name: entry.name, total: entry.total, received: entry.received, speed: entry.speed,
      start: entry.start, done: entry.done, success: entry.success, canceled: entry.canceled,
      savePath: entry.savePath, ws: entry.ws,
    });
  } catch (e) {}
}

function ytMirrorDb(job, success) {
  const entry = job.entry;
  if (!currentUser) return;
  if (isGhostWs(entry.ws)) return; // Ghost Workspace: never persist downloads
  try {
    const denc = vaultEncRow('downloads', { user_pseudo: currentUser, workspace_id: entry.ws, filename: entry.name, url: job.url, save_path: entry.savePath }, currentUser);
    if (!denc) return;
    const info = db.prepare('INSERT INTO downloads (workspace_id,user_pseudo,filename,url,save_path,total_bytes,received_bytes,start_time,done,success,canceled) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      denc.workspace_id, denc.user_pseudo, denc.filename, denc.url, denc.save_path, entry.total, entry.received, entry.start,
      success ? 1 : 0, success ? 1 : 0, entry.canceled ? 1 : 0
    );
    entry.dbId = Number(info.lastInsertRowid);
  } catch (e) {}
}

// Tag every job event with the job id (and the download-list entry id) so the
// renderer can tell "my download" from "someone else's download". Tool-setup
// events are global and stay untagged. A job may also carry a direct
// onProgress hook (the playlist queue uses it to drive its per-video row
// without going through IPC).
function ytJobSend(job, d) {
  if (typeof job.onProgress === 'function') { try { job.onProgress(d); } catch (e) {} }
  ytSend(Object.assign({ jobId: job.id, id: job.entry.id, ws: job.entry.ws, title: job.title }, d));
}

// Starts ONE video download and returns immediately with its job id plus a
// `done` promise that settles with the terminal state ({phase:'done' |
// 'error' | 'canceled', ...}). The IPC handler below is a thin wrapper (a
// promise cannot cross structured clone); the playlist queue drives this
// function directly so it can AWAIT each video before starting the next one.
async function ytStartJob(opts) {
  opts = opts || {};
  const url = String(opts.url || '');
  const vid = ytEngine.videoId(url);
  if (!vid) return { ok: false, error: 'This is not a YouTube video link' };
  const height = Math.max(144, Math.min(1080, parseInt(opts.height, 10) || 1080));

  // One job per video per workspace: a tab that is re-activated (or a second
  // popover) pressing Download again must NOT spawn a duplicate yt-dlp for a
  // video that is already downloading in this workspace.
  for (const j of ytJobs.values()) {
    if (j.vid === vid && j.entry.ws === (opts.ws || currentWorkspace || 'default')) {
      return { ok: true, id: j.id, existing: true, done: j.done };
    }
  }

  let tools;
  try { tools = await ytEnsureTools(); } catch (err) { return { ok: false, error: (err && err.message) || 'Could not prepare the downloader' }; }

  // Probe (usually served from cache) for the display name and the number of
  // sequential file transfers to expect — video + audio needs two.
  let info = null;
  try { info = await ytProbeInfo(url); } catch (err) { info = null; }
  const title = (info && info.title) || vid;
  let parts = 2, estSize = 0;
  if (info && info.qualities) {
    const q = info.qualities.find((x) => x.h <= height);
    if (q) { parts = q.muxed ? 1 : 2; estSize = q.size || 0; }
  }
  // The folder chosen in the popover (persisted in dl-prefs.json) — falling
  // back to the default Downloads folder, and created if it is missing.
  let outDir = ytDownloadDir();
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { outDir = getDlDir(); }
  const entry = {
    id: downloadIdCounter++, name: sanitizeFilename(title).slice(0, 120) + ' [' + vid + '].mp4',
    total: estSize, received: 0, speed: 0, start: Date.now(), done: false, success: false, canceled: false,
    url, savePath: '', ws: opts.ws || currentWorkspace || 'default',
  };
  if (!downloadsByWs[entry.ws]) downloadsByWs[entry.ws] = [];
  downloadsByWs[entry.ws].push(entry);

  const job = { id: entry.id, entry, url, vid, height, parts, part: 1, lastPct: -1, lastSend: 0, proc: null, canceled: false, finalLine: '', outDir,
                baseReceived: 0, fileTotal: 0, title,
                onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null };
  // Terminal-state promise: resolves when this job finishes, fails or is
  // canceled. The playlist queue awaits it — this is what guarantees the
  // next queued video never starts before this one has fully finished.
  job.done = new Promise((res) => { job.settleDone = res; });
  ytJobs.set(job.id, job);
  ytJobSend(job, { phase: 'started', pct: 0, label: 'Starting download', name: entry.name, height, parts });
  // The workspace-wide shelf learns about the download immediately, before any
  // byte moves — it renders this as "Pending".
  ytMirror(job, { speed: 0 });

  const args = [
    '-f', 'bv*[height<=' + height + '][ext=mp4]+ba[ext=m4a]/bv*[height<=' + height + ']+ba/b[height<=' + height + ']/b',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', tools.ffmpeg,
    '-o', path.join(outDir, '%(title).120s [%(id)s].%(ext)s'),
    '--newline', '--progress', '--print', 'after_move:filepath',
    '--no-playlist', '--no-warnings',
    url,
  ];

  let run;
  try {
    run = ytRun(tools.ytdlp, args, {
      onSpawn: (child) => { job.proc = child; },
      onStdout: (chunk) => {
        for (const line of chunk.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          const m = t.match(/^\[download\]\s+([\d.]+)%/);
          if (m) {
            const pct = parseFloat(m[1]);
            // A second [download] run after ~100% means the audio file started:
            // bank the finished part's bytes and restart the per-file count.
            if (pct < 10 && job.lastPct > 90 && job.part < job.parts) {
              job.baseReceived += job.fileTotal;
              job.fileTotal = 0;
              job.part++;
            }
            job.lastPct = pct;
            const of = t.match(/of\s+([\d.]+\s*[KMGT]?I?B)/i);
            if (of) job.fileTotal = ytSizeBytes(of[1]);
            const sp = t.match(/\bat\s+([\d.]+\s*[KMGT]?I?B)\/s/i);
            const eta = t.match(/ETA\s+([0-9:]+)/);
            const speed = sp ? ytRateBytes(sp[1] + '/s') : 0;
            const received = job.baseReceived + Math.round(job.fileTotal * (pct / 100));
            const overall = Math.min(99, Math.round(((job.part - 1 + pct / 100) / job.parts) * 100));
            const merging = job.part >= job.parts && pct >= 99.5;
            const now = Date.now();
            if (merging && now - job.lastSend >= 100) {
              job.lastSend = now;
              ytJobSend(job, { phase: 'merge', pct: 99, label: 'Merging video and audio…' });
              ytMirror(job, { speed: 0, received, total: job.baseReceived + job.fileTotal });
            } else if (now - job.lastSend >= 200) {
              job.lastSend = now;
              ytJobSend(job, { phase: 'download', pct: overall, label: merging ? 'Merging video and audio…' : 'Downloading video',
                       speed, eta: eta ? eta[1] : '', received });
              ytMirror(job, { speed, received, total: job.baseReceived + job.fileTotal });
            }
          } else if (/^([A-Za-z]:[\\/]|\/)/.test(t)) {
            job.finalLine = t; // --print after_move:filepath line (absolute path)
          }
        }
      },
    });
  } catch (err) {
    ytJobs.delete(job.id);
    ytMirror(job, { done: true, success: false });
    ytJobSend(job, { phase: 'error', pct: 0, label: 'Download failed', message: (err && err.message) || 'Could not start yt-dlp' });
    if (job.settleDone) job.settleDone({ phase: 'error', message: (err && err.message) || 'Could not start yt-dlp' });
    return { ok: false, error: (err && err.message) || 'Could not start yt-dlp' };
  }

  // Hand the result handling to a background task so the invoke returns the
  // job id immediately: the renderer does not have to hold an open promise per
  // download, and several downloads can be in flight at once. Terminal state
  // still reaches the renderer through yt-progress (and the mirror event).
  (async () => {
    const r = await run;
    if (!ytJobs.has(job.id)) { // already finalized elsewhere (defensive)
      if (job.settleDone) job.settleDone({ phase: 'error', message: 'Download failed' });
      return;
    }
    ytJobs.delete(job.id);

    if (job.canceled) {
      ytCleanupPartials(outDir, vid);
      ytMirror(job, { done: true, success: false, canceled: true, speed: 0 });
      ytMirrorDb(job, false);
      ytJobSend(job, { phase: 'canceled', pct: 0, label: 'Download canceled' });
      if (job.settleDone) job.settleDone({ phase: 'canceled' });
      return;
    }
    if (r.code !== 0) {
      ytCleanupPartials(outDir, vid);
      const msg = ytErrorFrom(r) || (r.killed ? 'The download timed out' : 'Download failed');
      ytMirror(job, { done: true, success: false, speed: 0 });
      ytJobSend(job, { phase: 'error', pct: 0, label: 'Download failed', message: msg });
      if (job.settleDone) job.settleDone({ phase: 'error', message: msg });
      return;
    }
    const finalPath = ytResolveOutput(outDir, vid, (job.finalLine || '').trim());
    let size = 0;
    if (finalPath) { try { size = fs.statSync(finalPath).size; } catch (err) {} }
    if (!finalPath || size <= 0) {
      ytMirror(job, { done: true, success: false, speed: 0 });
      ytJobSend(job, { phase: 'error', pct: 0, label: 'Download failed', message: 'The download finished but the file could not be found' });
      if (job.settleDone) job.settleDone({ phase: 'error', message: 'The download finished but the file could not be found' });
      return;
    }
    ytMirror(job, { done: true, success: true, canceled: false, speed: 0,
                    savePath: finalPath, name: path.basename(finalPath), total: size, received: size });
    ytMirrorDb(job, true);
    ytJobSend(job, { phase: 'done', pct: 100, label: 'Download complete', savePath: finalPath,
             name: path.basename(finalPath), size, height });
    if (job.settleDone) job.settleDone({ phase: 'done', savePath: finalPath, name: path.basename(finalPath), size, height });
  })().catch(() => {});

  return { ok: true, id: job.id, done: job.done };
}

// One video at a time through the shared engine. The renderer never sees the
// `done` promise — terminal state still reaches it through yt-progress.
ipcMain.handle('yt-start-download', async (e, opts) => {
  const r = await ytStartJob(opts);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, id: r.id, existing: !!r.existing };
});

// Cancels one download by job id. With no id it cancels the newest running
// job, keeping the old single-argument callers working.
ipcMain.handle('yt-cancel-download', (e, jobId) => {
  let job = null;
  if (jobId != null) job = ytJobs.get(jobId) || null;
  if (!job) { const last = [...ytJobs.values()]; job = last.length ? last[last.length - 1] : null; }
  if (!job) return { ok: false, error: 'No download is running' };
  job.canceled = true;
  ytKillTree(job.proc);
  return { ok: true, id: job.id };
});

// ── Download Full Playlist ────────────────────────────────────────────────
// A "Download Full Playlist" button appears in the toolbar only while a
// complete YouTube playlist page (youtube.com/playlist?list=…) is open. It
// opens playlist.html — a dedicated, frameless AEGIS window — which lists the
// playlist's videos (streamed from yt-dlp in this process), lets the user
// select them, and hands the selection to the playlist queue below.
//
// The queue is the single-worker state machine in playlist-queue.js: exactly
// ONE video downloads at a time, the next one starts only after the current
// one has completely finished (or failed), and pause/resume/skip/cancel/
// retry all go through the same machine. Every video runs through ytStartJob
// — the exact same yt-dlp engine as the toolbar's individual Download
// button — so progress, the download shelf, the Downloads panel and the DB
// mirror all keep working unchanged.

// ── Playlist window ──
let playlistWindow = null;
let plOpenOpts = null; // last {url, ws} handed to the window (state on reopen)

function openPlaylistWindow() {
  if (playlistWindow && !playlistWindow.isDestroyed()) {
    // Pressing the toolbar button again must bring the window back — even
    // when minimized or behind another window — with the new playlist URL.
    try {
      if (playlistWindow.isMinimized()) playlistWindow.restore();
      playlistWindow.show();
      playlistWindow.focus();
      playlistWindow.webContents.send('playlist-window-open', plOpenOpts || {});
    } catch (e) {}
    return;
  }
  playlistWindow = new BrowserWindow({
    width: 940, height: 680, minWidth: 640, minHeight: 460,
    // Frameless: same custom chrome contract as the Parameters windows
    // (drag region on top, QUIT closes this window only).
    frame: false,
    title: 'Download Full Playlist - AEGIS', backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined, resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  stripWindowNav(playlistWindow);
  // A page that cannot load (e.g. a packaging gap) must never leave a silent
  // blank window behind: log it and close so a re-press retries.
  playlistWindow.loadFile('playlist.html').catch((err) => {
    console.error('Download Full Playlist failed to load playlist.html: ' + (err && err.message));
    if (playlistWindow && !playlistWindow.isDestroyed()) { try { playlistWindow.close(); } catch (e) {} }
  });
  playlistWindow.on('closed', () => { playlistWindow = null; });
}

// ── Playlist detection (mirrors controls.html) ──
// A valid playlist page is a YouTube host + the /playlist path + a non-empty
// list id. Ordinary video pages (watch?v=…) never match — the toolbar button
// must not appear there.
function ytPlaylistListId(u) {
  try {
    const x = new URL(String(u || ''));
    if (!/^https?:$/.test(x.protocol)) return null;
    const h = x.hostname.replace(/^www\./i, '').toLowerCase();
    if (h !== 'youtube.com' && !h.endsWith('.youtube.com')) return null;
    const p = x.pathname.replace(/\/+$/, '');
    if (p !== '/playlist') return null;
    const list = (x.searchParams.get('list') || '').trim();
    return list || null;
  } catch (e) { return null; }
}

// One flat-playlist entry from `yt-dlp --flat-playlist --dump-json` → what
// the selection UI and the queue consume. Rows without a valid 11-char video
// id can never be downloaded and are dropped; unavailable rows keep their
// id and are shown with a proper availability badge instead.
function ytNormalizeEntry(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const vid = String(obj.id || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return null;
  const title = String(obj.title || vid);
  let availability = String(obj.availability || '').trim().toLowerCase();
  if (!availability) {
    const t = title.trim();
    if (/^\[private video\]$/i.test(t)) availability = 'private';
    else if (/^\[deleted video\]$/i.test(t)) availability = 'deleted';
    else if (/^\[unavailable video\]$/i.test(t)) availability = 'unavailable';
    else availability = 'public';
  }
  let thumb = String(obj.thumbnail || '');
  if (!thumb && Array.isArray(obj.thumbnails) && obj.thumbnails.length) {
    thumb = String(obj.thumbnails[obj.thumbnails.length - 1].url || '');
  }
  if (!thumb) thumb = 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg';
  return {
    vid: vid,
    url: 'https://www.youtube.com/watch?v=' + vid,
    title: title,
    thumb: thumb,
    duration: Number(obj.duration) || 0,
    availability: availability,
    live: String(obj.live_status || '') === 'is_live',
  };
}

// ── Playlist listing (streamed) ────────────────────────────────────────────
// `yt-dlp --flat-playlist --dump-json` prints one JSON entry per line; lines
// are parsed as they arrive and pushed to the requesting window in batches,
// so a 5000-video playlist shows up progressively and the UI never waits on
// (or freezes under) one giant string.
let plListings = new Map(); // sender.id -> { child, listId, canceled }
let plListSeq = 0;

ipcMain.handle('yt-playlist-videos', async (e, opts) => {
  const u = String((opts && opts.url) || '');
  const listId = ytPlaylistListId(u);
  if (!listId) return { ok: false, error: 'This is not a YouTube playlist link' };
  const sender = e.sender;
  if (!sender || sender.isDestroyed()) return { ok: false, error: 'The window is gone' };
  const senderId = sender.id;
  const send = (payload) => { try { if (!sender.isDestroyed()) sender.send('playlist-videos', payload); } catch (err) {} };

  // Latest request wins: kill a listing this window already has in flight.
  const prev = plListings.get(senderId);
  if (prev) { prev.canceled = true; ytKillTree(prev.child); }

  let tools;
  try { tools = await ytEnsureTools(); } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not prepare the downloader' };
  }

  const mine = 'pl' + (++plListSeq);
  const rec = { child: null, listId: mine, canceled: false };
  plListings.set(senderId, rec);

  let buf = '', batch = [], got = 0, metaSent = false;
  const flush = () => { if (batch.length) { const v = batch; batch = []; send({ type: 'batch', listId: mine, videos: v }); } };
  // Partial batches are flushed on a timer too, so a slow playlist still
  // trickles in instead of waiting for 64 entries to pile up.
  const flushTimer = setInterval(() => { if (batch.length) flush(); }, 500);

  const runP = ytRun(tools.ytdlp, ['--flat-playlist', '--dump-json', '--ignore-errors', '--no-warnings', u], {
    timeoutMs: 900000, // enumerating a huge playlist may legitimately take minutes
    onSpawn: (child) => { rec.child = child; if (rec.canceled) ytKillTree(child); },
    onStdout: (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const t = line.trim();
        if (!t || t[0] !== '{') continue;
        let obj;
        try { obj = JSON.parse(t); } catch (err) { continue; }
        if (!metaSent && obj && obj.playlist_title) {
          metaSent = true;
          send({ type: 'meta', listId: mine, title: String(obj.playlist_title), channel: String(obj.playlist_uploader || '') });
        }
        const v = ytNormalizeEntry(obj);
        if (!v) continue;
        got++;
        batch.push(v);
        if (batch.length >= 64) flush();
      }
    },
  });

  (async () => {
    let r;
    try { r = await runP; } catch (err) { r = { code: -1, stdout: '', stderr: (err && err.message) || '' }; }
    clearInterval(flushTimer);
    if (plListings.get(senderId) === rec) plListings.delete(senderId);
    if (rec.canceled) { flush(); send({ type: 'canceled', listId: mine }); return; }
    flush();
    if (r.code !== 0 && got === 0) {
      send({ type: 'error', listId: mine, error: ytErrorFrom(r) || 'Could not read this playlist' });
      return;
    }
    send({ type: 'done', listId: mine, count: got });
  })().catch(() => {});

  return { ok: true, listId: mine };
});

// Cancel button while the listing is still loading.
ipcMain.handle('yt-playlist-videos-cancel', (e) => {
  const rec = plListings.get(e.sender.id);
  if (!rec) return { ok: false };
  rec.canceled = true;
  ytKillTree(rec.child);
  return { ok: true };
});

// ── The playlist queue (ONE video at a time) ──
let plQueue = null;          // current queue — one at a time, by design
let plQueueHeight = 1080;    // quality chosen in the selection view
let plQueueWs = 'default';   // workspace the queue downloads into
let plActiveJobId = null;    // job id of the playlist video downloading right now
let plCancelIntent = false;  // skip/cancel arrived while the job was still spawning

function plSend(payload) {
  try {
    if (playlistWindow && !playlistWindow.isDestroyed() && !playlistWindow.webContents.isDestroyed()) {
      playlistWindow.webContents.send('playlist-progress', payload);
    }
  } catch (e) {}
}

// Runs ONE queued video through the exact same engine as the toolbar button.
// The returned promise settles only when the job reached a terminal state —
// playlist-queue.js awaits it before even looking at the next video.
async function plStartVideo(item) {
  plCancelIntent = false;
  let r;
  try {
    r = await ytStartJob({
      url: item.url, height: plQueueHeight, ws: plQueueWs,
      onProgress: (d) => { if (plQueue) plQueue.onItemProgress(item, d); },
    });
  } catch (err) { return { ok: false, error: (err && err.message) || 'Could not start the download' }; }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Could not start the download' };
  plActiveJobId = r.id;
  // A cancel/skip that arrived while this video was being probed: the job
  // exists now, so kill it before any byte moves.
  if (plCancelIntent) {
    const j = ytJobs.get(r.id);
    if (j && !j.canceled) { j.canceled = true; ytKillTree(j.proc); }
  }
  let done;
  try { done = await r.done; } catch (err) { done = { phase: 'error', message: 'Download failed' }; }
  if (plActiveJobId === r.id) plActiveJobId = null;
  if (done.phase === 'done') return { ok: true, size: done.size || 0, savePath: done.savePath || '' };
  if (done.phase === 'canceled') return { ok: false, canceled: true };
  return { ok: false, error: done.message || 'Download failed' };
}

function plCancelCurrent() {
  plCancelIntent = true;
  if (plActiveJobId != null) {
    const j = ytJobs.get(plActiveJobId);
    if (j && !j.canceled) { j.canceled = true; ytKillTree(j.proc); }
  }
}

// Open (or focus) the playlist window for the given playlist page URL.
ipcMain.handle('yt-playlist-window', (e, opts) => {
  const url = String((opts && opts.url) || '');
  if (!ytPlaylistListId(url)) return { ok: false, error: 'This is not a YouTube playlist page' };
  plOpenOpts = { url: url, ws: String((opts && opts.ws) || currentWorkspace || 'default') };
  openPlaylistWindow();
  return { ok: true };
});

// Queue the selected videos (validated + deduped, playlist order kept) and
// start the single worker immediately.
ipcMain.handle('yt-playlist-start', (e, opts) => {
  opts = opts || {};
  if (plQueue && plQueue.isBusy()) {
    return { ok: false, error: 'A playlist download is already running — cancel it before starting another.' };
  }
  if (!ytPlaylistListId(String(opts.url || ''))) return { ok: false, error: 'This is not a YouTube playlist link' };
  const videos = Array.isArray(opts.videos) ? opts.videos : [];
  if (!videos.length) return { ok: false, error: 'No videos were selected' };

  plQueueHeight = Math.max(144, Math.min(1080, parseInt(opts.height, 10) || 1080));
  plQueueWs = String(opts.ws || currentWorkspace || 'default');
  plActiveJobId = null;
  plCancelIntent = false;

  const q = createPlaylistQueue({ startVideo: plStartVideo, cancelCurrent: plCancelCurrent, emit: plSend });
  const enq = q.enqueue(videos);
  if (!enq.ok) return { ok: false, error: enq.error };
  if (!enq.added) return { ok: false, error: 'None of the selected videos are valid' };
  plQueue = q;
  q.start();
  return { ok: true, added: enq.added, duplicates: enq.duplicates, invalid: enq.invalid, state: q.snapshot() };
});

// Full state for a (re)opening window: last playlist URL + live queue.
ipcMain.handle('yt-playlist-state', () => ({
  open: plOpenOpts,
  queue: plQueue ? plQueue.snapshot() : null,
}));

// Queue controls: pause / resume / cancel / skip / remove / retry(-all).
// Every action funnels into playlist-queue.js, so none of them can start a
// download on its own.
ipcMain.handle('yt-playlist-control', (e, opts) => {
  opts = opts || {};
  const q = plQueue;
  if (!q) return { ok: false, error: 'No playlist queue' };
  switch (String(opts.action || '')) {
    case 'pause': return { ok: q.pause() };
    case 'resume': return { ok: q.resume() };
    case 'cancel': return { ok: q.cancel() };
    case 'skip': return { ok: q.skip() };
    case 'remove': return { ok: q.remove(opts.itemId) };
    case 'retry': return { ok: q.retry(opts.itemId) };
    case 'retry-all': return { ok: q.retryAll() };
    default: return { ok: false, error: 'Unknown queue action' };
  }
});

ipcMain.handle('copy-text', (e, text) => {
  try {
    const s = String(text == null ? '' : text);
    clipboard.writeText(s);
    scheduleClipboardWipe(s); // the renderer's copies are wiped like our own
    return true;
  } catch (err) { return false; }
});
// The suggestion menu floats in its own overlay WebContentsView (see below) and
// must NEVER push the page down. The layout reserve is therefore pinned to 0
// unconditionally — a stale renderer asking for a push is ignored.
ipcMain.on('suggest-toggle', () => {
  suggestHeight = 0;
  syncViews();
});

// ── Suggestion overlay ──
// The dropdown renders in its own transparent WebContentsView added ABOVE the
// page views, so it floats over the page without pushing the layout down
// (suggestHeight stays 0 in overlay mode). suggestToggle above remains only as
// a fallback for when the overlay view cannot be created/loaded.
let suggestOverlayView = null;
let suggestOverlayLoad = null;
let suggestOverlaySeq = 0; // latest request wins: kills opens stuck awaiting first load

function hideSuggestOverlayView() {
  if (suggestOverlayView && !suggestOverlayView.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.contentView.removeChildView(suggestOverlayView); } catch (err) {}
  }
}

function ensureSuggestOverlayView() {
  if (suggestOverlayView && !suggestOverlayView.webContents.isDestroyed()) return suggestOverlayView;
  suggestOverlayView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
      webviewTag: false, backgroundThrottling: false,
    },
  });
  suggestOverlayView.setBackgroundColor('#00000000'); // transparent over the page
  suggestOverlayView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  suggestOverlayLoad = suggestOverlayView.webContents.loadFile('suggest-overlay.html');
  // Only hides when actually attached — loadFile's own did-navigate must not
  // kill the very open that is awaiting this load.
  suggestOverlayView.webContents.on('did-navigate', () => {
    if (mainWindow && mainWindow.contentView.children.includes(suggestOverlayView)) hideSuggestOverlayView();
  });
  return suggestOverlayView;
}

ipcMain.handle('suggest-overlay', async (e, data) => {
  const seq = ++suggestOverlaySeq;
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (!data || !data.open) { hideSuggestOverlayView(); return true; }
    const view = ensureSuggestOverlayView();
    if (suggestOverlayLoad) {
      try { await suggestOverlayLoad; } catch (err) {
        // Load failed (e.g. first-run race): drop the dead view + rejected
        // promise so the NEXT attempt recreates the overlay from scratch.
        try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch (e2) {}
        hideSuggestOverlayView();
        suggestOverlayView = null;
        suggestOverlayLoad = null;
        console.warn('[suggest-overlay] load failed, will recreate on next open:', err && err.message);
        return false;
      }
      suggestOverlayLoad = null;
    }
    // A close/chrome-navigation superseded us while the first load was pending
    if (seq !== suggestOverlaySeq) return true;
    const wc = view.webContents;
    if (wc.isDestroyed()) return false;
    const r = data.rect || {};
    const cardW = Math.max(80, Math.round(r.width || 240));
    const cardH = Math.max(24, Math.round(data.height || 120));
    view.setBounds({
      x: Math.max(0, Math.round(r.x || 0) - 8),
      y: Math.max(0, Math.round(r.y || 0)),
      width: cardW + 16,   // 8px each side: room for the drop shadow
      height: cardH + 20,  // 4px top gap + 16px below: shadow room
    });
    const kids = mainWindow.contentView.children;
    if (kids[kids.length - 1] !== view) mainWindow.contentView.addChildView(view);
    wc.send('suggest-data', { items: data.items || [], sel: (typeof data.sel === 'number' ? data.sel : -1), accent: data.accent === 'purple' ? 'purple' : 'blue' });
    mainWindow.webContents.focus(); // typing stays in the URL bar
    return true;
  } catch (err) {
    console.warn('[suggest-overlay] open failed:', err && err.message);
    return false;
  }
});

ipcMain.on('suggest-pick', (e, idx) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('suggest-picked', typeof idx === 'number' ? idx : -1);
  mainWindow.webContents.focus(); // click left the chrome webContents: give it back
});

// ── Floating YouTube download popover ──
// controls.html owns the popover (probe, quality list, progress, buttons) and
// mirrors its markup into this transparent WebContentsView, which is added ABOVE
// the page views exactly like the suggestion dropdown. Without it the popover
// would sit under the page's WebContentsView and only its toolbar-side sliver
// would be visible.
const YT_PAD = 24; // shadow room around the mirrored card
let ytOverlayView = null;
let ytOverlayLoad = null;
let ytOverlaySeq = 0; // latest request wins (same discipline as suggest-overlay)

function hideYtOverlayView() {
  if (ytOverlayView && !ytOverlayView.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.contentView.removeChildView(ytOverlayView); } catch (err) {}
  }
}

function ensureYtOverlayView() {
  if (ytOverlayView && !ytOverlayView.webContents.isDestroyed()) return ytOverlayView;
  ytOverlayView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
      webviewTag: false, backgroundThrottling: false,
    },
  });
  ytOverlayView.setBackgroundColor('#00000000'); // transparent over the page
  ytOverlayView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  // Attach to the window BEFORE loading: a view that is not in the content view
  // hierarchy has no reason to finish loading promptly — the first open of this
  // menu used to wait ~20s for yt-overlay.html and every request queued behind it.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.contentView.addChildView(ytOverlayView); } catch (err) {}
  }
  ytOverlayLoad = ytOverlayView.webContents.loadFile('yt-overlay.html');
  ytOverlayView.webContents.on('did-navigate', () => {
    if (mainWindow && mainWindow.contentView.children.includes(ytOverlayView)) hideYtOverlayView();
  });
  return ytOverlayView;
}

function ytRect(r) {
  r = r || {};
  return {
    x: Math.round(Number(r.x) || 0),
    y: Math.round(Number(r.y) || 0),
    w: Math.max(40, Math.round(Number(r.w || r.width) || 0)),
    h: Math.max(24, Math.round(Number(r.h || r.height) || 0)),
  };
}

// Paints one request: geometry, layer order (above the page views) and markup.
// Returns false when the request has been superseded or the view is gone.
function applyYtOverlay(view, data, seq) {
  if (seq !== ytOverlaySeq) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const wc = view.webContents;
  if (wc.isDestroyed()) return false;

  let vx, vy, vw, vh, card;
  if (data.mode === 'return') {
    const f = ytRect(data.from), t = ytRect(data.to);
    const x0 = Math.min(f.x, t.x), y0 = Math.min(f.y, t.y);
    const x1 = Math.max(f.x + f.w, t.x + t.w), y1 = Math.max(f.y + f.h, t.y + t.h);
    vx = Math.max(0, x0 - YT_PAD);
    vy = Math.max(0, y0 - YT_PAD);
    vw = Math.ceil(x1 - vx + YT_PAD);
    vh = Math.ceil(y1 - vy + YT_PAD);
    card = { left: f.x - vx, top: f.y - vy, toLeft: t.x - vx, toTop: t.y - vy, w: f.w };
  } else {
    const r = ytRect(data.rect);
    vx = Math.max(0, r.x - YT_PAD);
    vy = Math.max(0, r.y - YT_PAD);
    vw = Math.ceil(r.x - vx + r.w + YT_PAD);
    vh = Math.ceil(r.y - vy + r.h + YT_PAD);
    card = { left: r.x - vx, top: r.y - vy, w: r.w };
  }
  view.setBounds({ x: vx, y: vy, width: Math.max(1, vw), height: Math.max(1, vh) });
  // Re-attaching an existing child lifts it above the page views.
  const kids = mainWindow.contentView.children;
  if (kids[kids.length - 1] !== view) mainWindow.contentView.addChildView(view);
  wc.send('yt-overlay-render', Object.assign({ html: data.html, mode: data.mode || 'sync' }, card));
  if (data.mode === 'open') mainWindow.webContents.focus(); // typing/clicks stay in chrome
  return true;
}

// mode: 'open' (first paint + focus chrome) | 'sync' (content/geometry update)
//       | 'return' (animate the card back onto the toolbar anchor)
ipcMain.handle('yt-overlay', async (e, data) => {
  const seq = ++ytOverlaySeq;
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (!data || !data.open) {
      hideYtOverlayView();
      return true;
    }
    const view = ensureYtOverlayView();
    // The mirror page can still be loading. Never hold the caller hostage to it:
    // answer within a beat, and repaint the moment the page lands if it has not
    // (a send made before the document exists would simply be dropped).
    if (ytOverlayLoad) {
      const load = ytOverlayLoad;
      const ready = await Promise.race([
        load.then(() => true, () => false),
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (ready === false) { // page failed to load: chrome falls back to its own copy
        try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch (e2) {}
        hideYtOverlayView();
        ytOverlayView = null;
        ytOverlayLoad = null;
        return false;
      }
      if (ready !== true) {
        const s = seq;
        applyYtOverlay(view, data, seq); // best effort while the page warms up
        load.then(() => { if (s === ytOverlaySeq) applyYtOverlay(view, data, s); }, () => {});
        return true;
      }
      ytOverlayLoad = null;
    }
    const ok = applyYtOverlay(view, data, seq);
    // Focus even when superseded: attaching the mirror must never leave the
    // keyboard typing into an invisible overlay instead of the chrome.
    if (data.mode === 'open') { try { mainWindow.webContents.focus(); } catch (e) {} }
    return ok;
  } catch (err) {
    console.warn('[yt-overlay] render failed:', err && err.message);
    return false;
  }
});

// The mirrored copy forwards user gestures back to controls.html, which owns the
// real popover DOM — one implementation, one set of handlers.
ipcMain.handle('yt-overlay-action', (e, a) => {
  if (!ytOverlayView || e.sender !== ytOverlayView.webContents) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.webContents.send('yt-overlay-action', a);
  mainWindow.webContents.focus(); // the gesture left the chrome webContents
  return true;
});

ipcMain.on('yt-overlay-hover', (e, hovering) => {
  if (!ytOverlayView || e.sender !== ytOverlayView.webContents) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('yt-overlay-hover', !!hovering);
});


// ── Zoom (global) ──

ipcMain.on('zoom-in', () => {
  zoomLevel = Math.min(zoomLevel + 0.5, 5);
  currentTabs().forEach(t => t.view.webContents.setZoomLevel(zoomLevel));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zoom-changed', zoomLevel);
});
ipcMain.on('zoom-out', () => {
  zoomLevel = Math.max(zoomLevel - 0.5, -5);
  currentTabs().forEach(t => t.view.webContents.setZoomLevel(zoomLevel));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zoom-changed', zoomLevel);
});
ipcMain.on('zoom-reset', () => {
  zoomLevel = 0;
  currentTabs().forEach(t => t.view.webContents.setZoomLevel(0));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zoom-changed', 0);
});

// ── Find in Page ──

ipcMain.on('find-start', (e, text) => { const t = activeTab(); if (t && text) t.view.webContents.findInPage(text); });
ipcMain.on('find-next', (e, text) => { const t = activeTab(); if (t && text) t.view.webContents.findInPage(text, { findNext: true }); });
ipcMain.on('find-stop', () => { const t = activeTab(); if (t) t.view.webContents.stopFindInPage('clearSelection'); });

// ── Shortcuts & Quit Confirmation ──

let quitConfirmWindow = null;

function confirmQuit() {
  if (quitConfirmWindow && !quitConfirmWindow.isDestroyed()) {
    quitConfirmWindow.focus();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    app.quit();
    return;
  }

  quitConfirmWindow = new BrowserWindow({
    width: 420,
    height: 205,
    parent: mainWindow,
    modal: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: '#00000000',
    icon: findIcon() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  quitConfirmWindow.loadFile('confirm-quit.html');

  quitConfirmWindow.once('ready-to-show', () => {
    if (quitConfirmWindow && !quitConfirmWindow.isDestroyed()) {
      quitConfirmWindow.show();
      quitConfirmWindow.focus();
    }
  });

  quitConfirmWindow.on('closed', () => {
    quitConfirmWindow = null;
  });
}

ipcMain.on('confirm-quit-action', (event, action) => {
  if (action === 'quit') {
    if (quitConfirmWindow && !quitConfirmWindow.isDestroyed()) {
      quitConfirmWindow.close();
    }
    app.quit();
  } else if (action === 'cancel') {
    if (quitConfirmWindow && !quitConfirmWindow.isDestroyed()) {
      quitConfirmWindow.close();
    }
  }
});

function setupF11Handler(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
    if ((input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) && input.type === 'keyDown') {
      event.preventDefault();
      wc.toggleDevTools();
    }
    if (input.key === 'Escape' && input.type === 'keyDown') {
      event.preventDefault();
      confirmQuit();
    }
  });
}

ipcMain.on('toggle-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ── Home ──

ipcMain.on('go-home', () => { const t = activeTab(); if (t) t.view.webContents.loadURL('https://www.google.com'); });

// ── Idle ──

ipcMain.on('reset-idle', () => { if (currentUser) resetIdleTimer(); });

// ── Lifecycle ──

ipcMain.on('return-to-workspaces-req', () => { saveUserTabsPersist(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-workspaces'); });
ipcMain.on('return-to-login-req', () => { saveUserTabsPersist(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-login'); });

ipcMain.on('quit-app', () => confirmQuit());

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
function flushSessionsSync() {
  try { saveUserTabsPersist(); } catch(e) {}
  // Flush debounced save that may still be pending (<1.2s old navigation)
  try { if (tabSaveDebounce) { clearTimeout(tabSaveDebounce); tabSaveDebounce = null; saveUserTabsPersist(); } } catch(e) {}
  // Durability: checkpoint WAL so reopen sees everything even after crash/kill
  try { if (db) db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) {}
  try { endCurrentVisit(); } catch(e) {}
  try { if (sessionStartTime) endSession(); } catch(e) {}
  try { if (db) computeDailyMetrics(); } catch(e) {}
  try { if (db) db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e) {}
}
app.on('before-quit', () => {
  // Every video download runs as a child process tree — take them all down
  // and sweep their partial files so the next launch starts clean.
  if (ytJobs.size) {
    for (const j of ytJobs.values()) { try { ytKillTree(j.proc); } catch (e) {} try { ytCleanupPartials(j.outDir, j.vid); } catch (e) {} }
    ytJobs.clear();
  }
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  try { closeGhostWorkspace(); } catch (e) {} // Ghost: nothing to flush — it was never on disk
  flushSessionsSync();
  try { clipWipeOnQuit(); } catch (e) {}       // a session copy does not outlive the session
  try { vaultDeactivate(); } catch (e) {}     // flush above needed the key; the exit does not
});

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', (e, argv) => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    // A link clicked while AEGIS is already running opens in a new tab
    handleExternalUrl(extractUrlFromArgv(argv));
  });
}
