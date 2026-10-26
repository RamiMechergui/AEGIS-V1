const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, dialog, shell, clipboard, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { execFile } = require('child_process');

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

let mainWindow;
let workspaceTabs = {};
let activeIdPerWorkspace = {};
let idCounter = 0;
let currentUser = null;
let currentWorkspace = null;
let autoSaveInterval = null;
let idleTimeout = null;
const DEFAULT_AUTO_CLOSE = 1;
const DEFAULT_AUTO_CLOSE_SECONDS = 300;
let panelOpen = false;
const PANEL_WIDTH = 400;
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

// ── Analytics ──
let analyticsEnabled = true;
let currentVisit = null;
let sessionStartTime = null;
let sessionTabSwitches = 0;
let sessionDomains = new Set();
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

function broadcastMediaState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const entries = Array.from(playingTabs.entries()).map(([id, info]) => ({ id, ...info }));
    const byWorkspace = {};
    entries.forEach(t => { if (!byWorkspace[t.workspaceId]) byWorkspace[t.workspaceId] = []; byWorkspace[t.workspaceId].push(t); });
    mainWindow.webContents.send('media-state', { playing: playingTabs.size > 0, tabs: entries, byWorkspace });
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
  const h = Math.max(50, b.height - top - (isFS ? 0 : BOTTOM));
  if (splitMode && splitLeft && splitRight) {
    const gap = 4;
    const handleW = 6;
    const totalW = b.width - pw;
    const leftW = Math.floor(totalW * splitRatio);
    const rightW = totalW - leftW - handleW - gap;
    const boundsKey = `s|${leftW}|${rightW}|${top}|${h}|${pw}`;
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
      const boundsKey = `n|0|${top}|${b.width-pw}|${h}|${pw}`;
      if (boundsKey === lastSyncBounds) return;
      lastSyncBounds = boundsKey;
      removeShownViews();
      t.view.setBounds({ x:0, y:top, width:b.width-pw, height:h }); mainWindow.contentView.addChildView(t.view); shownViews.add(t.view);
    }
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      pseudo TEXT PRIMARY KEY, password TEXT NOT NULL, salt TEXT NOT NULL,
      created INTEGER NOT NULL, photo TEXT, active_workspace TEXT DEFAULT 'default'
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT NOT NULL, user_pseudo TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL,
      color TEXT DEFAULT '#4a8bc5',
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
  `);
  try { db.exec('ALTER TABLE downloads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT \'\''); } catch(e) {}
  try { db.exec('UPDATE downloads SET workspace_id = \'default\' WHERE workspace_id = \'\''); } catch(e) {}
  try { db.exec('ALTER TABLE workspaces ADD COLUMN color TEXT DEFAULT \'#4a8bc5\''); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN auto_close INTEGER NOT NULL DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN auto_close_seconds INTEGER NOT NULL DEFAULT 300"); } catch(e) {}
  // ── Persistent session: tab order + active tab per workspace ──
  try { db.exec('ALTER TABLE tabs ADD COLUMN position INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE workspaces ADD COLUMN active_url TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE workspaces ADD COLUMN active_index INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tabs_user_ws ON tabs(user_pseudo, workspace_id)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_history_user_ws_ts ON history(user_pseudo, workspace_id, timestamp)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_user_ws ON bookmarks(user_pseudo, workspace_id)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_visits_user_start ON page_visits(user_pseudo, start_time)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_visits_user_domain ON page_visits(user_pseudo, domain)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_visits_user_ws ON page_visits(user_pseudo, workspace_id)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_visits_category ON page_visits(user_pseudo, category, start_time)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(user_pseudo, workspace_id, url)'); } catch(e) {}
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
  stmt.bookmarkCheck = db.prepare('SELECT id FROM bookmarks WHERE user_pseudo=? AND workspace_id=? AND url=?');
  stmt.bookmarkInsert = db.prepare('INSERT INTO bookmarks (user_pseudo,workspace_id,url,title,timestamp) VALUES (?,?,?,?,?)');
  stmt.bookmarkDelete = db.prepare('DELETE FROM bookmarks WHERE user_pseudo=? AND workspace_id=? AND url=?');
  stmt.noteList = db.prepare('SELECT id,content,created,updated FROM notes WHERE user_pseudo=? AND workspace_id=? ORDER BY created DESC, id DESC');
  stmt.noteInsert = db.prepare('INSERT INTO notes (user_pseudo,workspace_id,content,created,updated) VALUES (?,?,?,?,?)');
  stmt.noteUpdate = db.prepare('UPDATE notes SET content=?,updated=? WHERE id=? AND user_pseudo=?');
  stmt.noteDelete = db.prepare('DELETE FROM notes WHERE id=? AND user_pseudo=?');
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
  endCurrentVisit();
  const domain = getDomain(url);
  const category = classifyDomain(domain);
  const now = Date.now();
  const info = stmt.visitInsert.run(currentUser, wsId || currentWorkspace, url.slice(0, 2048), domain, category, title || '', now);
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
    db.prepare('INSERT INTO browser_sessions (user_pseudo,workspace_id,start_time) VALUES (?,?,?)').run(currentUser, currentWorkspace, sessionStartTime);
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
function getWorkspaces(p) { return db.prepare('SELECT * FROM workspaces WHERE user_pseudo=?').all(p); }
function getWorkspace(p, id) { return db.prepare('SELECT * FROM workspaces WHERE id=? AND user_pseudo=?').get(id, p); }
function getTabsDb(p, wsId) {
  try {
    return db.prepare('SELECT url, title, position FROM tabs WHERE user_pseudo=? AND workspace_id=? ORDER BY position ASC, rowid ASC').all(p, wsId);
  } catch(e) {
    return db.prepare('SELECT url, title FROM tabs WHERE user_pseudo=? AND workspace_id=?').all(p, wsId);
  }
}
function getWorkspaceState(p, wsId) {
  try { return db.prepare('SELECT active_url, active_index FROM workspaces WHERE id=? AND user_pseudo=?').get(wsId, p); }
  catch(e) { return null; }
}
function saveTabsDb(p, wsId, list, activeUrl, activeIndex) {
  db.transaction(() => {
    stmt.tabDelete.run(p, wsId);
    list.forEach((t, i) => {
      try { stmt.tabInsert.run(p, wsId, t.url, t.title, i); }
      catch(e) { stmt.tabInsert.run(p, wsId, t.url, t.title); }
    });
    try {
      db.prepare('UPDATE workspaces SET active_url=?, active_index=? WHERE id=? AND user_pseudo=?')
        .run(activeUrl || (list[activeIndex || 0] ? list[activeIndex || 0].url : (list[0] ? list[0].url : null)), activeIndex || 0, wsId, p);
    } catch(e) {}
  })();
}
function getHistDb(p, wsId) { return db.prepare('SELECT url,title,timestamp FROM history WHERE user_pseudo=? AND workspace_id=? ORDER BY timestamp DESC LIMIT 200').all(p, wsId); }
function getBmDb(p, wsId) { return db.prepare('SELECT url,title,timestamp FROM bookmarks WHERE user_pseudo=? AND workspace_id=? ORDER BY timestamp DESC').all(p, wsId); }
function ensureDefaultWs(p) { if (!getWorkspace(p, 'default')) db.prepare('INSERT OR IGNORE INTO workspaces (id,user_pseudo,name,created,color) VALUES (?,?,?,?,?)').run('default', p, 'Default', Date.now(), '#4a8bc5'); }

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
  ensureDefaultWs(key);
  return true;
}
function loginUser(pseudo, password) {
  const key = pseudo.toLowerCase();
  const user = getUser(key);
  if (!user || !verifyPassword(password, user.salt, user.password)) return false;
  currentUser = key;
  ensureDefaultWs(key);
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
    const others = wss.filter(w => w.id !== active);
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
      { label: 'Parameters', click: () => openParameters() },
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
  wss.forEach(w => {
    wsMenu.submenu.push({
      label: w.name, type: 'checkbox', checked: w.id === active,
      click: () => { if (w.id !== active) switchWorkspace(w.id); },
    });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([ghostMenu, wsMenu]));
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
  mainWindow.on('enter-full-screen', () => { if (!mainWindow.isDestroyed()) { mainWindow.setMenuBarVisibility(true); buildMenu(); mainWindow.webContents.send('fs-change', true); syncViews(); } });
  mainWindow.on('leave-full-screen', () => { if (!mainWindow.isDestroyed()) { mainWindow.setMenuBarVisibility(true); setTimeout(() => { if (!mainWindow.isDestroyed()) { buildMenu(); mainWindow.setMenuBarVisibility(true); } }, 200); mainWindow.webContents.send('fs-change', false); syncViews(); } });
  mainWindow.on('minimize', () => { if (!mainWindow.isDestroyed()) mainWindow.setMenuBarVisibility(true); });
  mainWindow.on('restore', () => { if (!mainWindow.isDestroyed()) { buildMenu(); mainWindow.setMenuBarVisibility(true); } });
  mainWindow.on('focus', () => { windowFocusedAt = Date.now(); });
  mainWindow.on('blur', () => { endCurrentVisit(); if (sessionStartTime) endSession(); });
  setupF11Handler(mainWindow.webContents);
}

// ── Tab Management ──

function contentBounds() {
  const b = mainWindow.getBounds();
  const pw = panelOpen ? PANEL_WIDTH : 0;
  const top = TOP + suggestHeight;
  return { x: 0, y: top, width: b.width - pw, height: Math.max(50, b.height - top - BOTTOM) };
}

const blockList = ['*://*.doubleclick.net/*', '*://*.google-analytics.com/*', '*://*.facebook.com/tr*', '*://*.twitter.com/i/ads*', '*://*.amazon-adsystem.com/*'];
const permCache = {};

function setupSession(ses, wsId) {
  if (ses._configured) return;
  ses._configured = true;
  ses.webRequest.onBeforeRequest({ urls: blockList }, (details, callback) => callback({ cancel: true }));
  // Check-level gate: geolocation is always refused, so navigator.permissions
  // reports it as 'denied' and no code path can opt into the OS location
  // service. Every other permission is returned exactly as Electron's own
  // default would (granted, except deprecated-sync-clipboard-read), so this
  // handler changes nothing but geolocation.
  ses.setPermissionCheckHandler((wc, perm) => {
    if (perm === 'geolocation') return false;
    return perm !== 'deprecated-sync-clipboard-read';
  });
  ses.setPermissionRequestHandler((wc, perm, cb) => {
    // Geolocation is auto-refused before the cache and before the dialog:
    // a previously allowed site cannot re-enable it and no popup is ever shown.
    if (perm === 'geolocation') return cb(false);
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

function addTab(url, partition, silent) {
  // partition may be omitted; silent may be passed as 2nd arg (boolean)
  if (typeof partition === 'boolean') { silent = partition; partition = undefined; }
  const tabs = currentTabs();
  const id = idCounter++;
  const wsPartition = partition || (currentWorkspace ? 'persist:user_' + currentUser + '_ws_' + currentWorkspace : undefined);
  if (wsPartition) usedPartitions.add(wsPartition);
  const view = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, partition: wsPartition, disableHtmlFullscreenWindowResize: false, backgroundThrottling: false },
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
      playingTabs.set(id, { title: view.webContents.getTitle(), url: view.webContents.getURL() });
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

  // Open links in new tab instead of new window
  view.webContents.setWindowOpenHandler(({ url }) => {
    addTab(url);
    return { action: 'deny' };
  });

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
  stmt.historyInsert.run(currentUser, id, url, title||url, Date.now());
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
  currentWorkspace = workspaceId || user.active_workspace || 'default';
  db.prepare('UPDATE users SET active_workspace = ? WHERE pseudo = ?').run(currentWorkspace, currentUser);

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
  currentWorkspace = workspaceId;
  db.prepare('UPDATE users SET active_workspace = ? WHERE pseudo = ?').run(workspaceId, currentUser);

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
      template.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
      template.push({ type: 'separator' });
    }
    if (params.mediaType === 'image') {
      template.push({ label: 'Open Image in New Tab', click: () => addTab(params.srcURL) });
      template.push({ label: 'Save Image As…', click: () => saveUrlAs(wc, params.srcURL) });
      template.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) });
      template.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
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
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(app.getPath('downloads'), filenameFromUrl(url)) });
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
  let savePath = path.join(app.getPath('downloads'), name);
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
    if (currentUser) {
      try {
        const info = db.prepare('INSERT INTO downloads (workspace_id,user_pseudo,filename,url,save_path,total_bytes,received_bytes,start_time,done,success,canceled) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
          dlWsId, currentUser, name, url, actualPath, total, entry.received, entry.start, entry.success ? 1 : 0, entry.success ? 1 : 0, entry.canceled ? 1 : 0
        );
        entry.dbId = Number(info.lastInsertRowid);
      } catch(e) {}
    }
  });
}

function getDlDir() { return app.getPath('downloads'); }

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

ipcMain.handle('get-downloads-history', (e, wsId) => {
  const id = wsId || currentWorkspace;
  if (!currentUser || !id) return [];
  try {
    return db.prepare('SELECT * FROM downloads WHERE user_pseudo=? AND workspace_id=? ORDER BY start_time DESC LIMIT 200').all(currentUser, id).filter(row => {
      if (deletedDlIds.has(row.id)) return false;
      if (deletedDlSavePaths.has(row.save_path)) return false;
      if (deletedDlSavePaths.has(row.save_path.replace(/\\/g, '/'))) return false;
      return true;
    });
  } catch(e) { return []; }
});

ipcMain.handle('get-download-dir', () => getDlDir());

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
        const stmt = db.prepare('DELETE FROM downloads WHERE save_path=? AND user_pseudo=?');
        for (const p of pathsToTry) if (stmt.run(p, currentUser).changes > 0) { deleted = true; break; }
      }
      if (!deleted) console.error('delete-download: no DB row matched for id=' + dbRowId + ' path=' + savePath);
    }
  } catch(e) { console.error('delete-download error:', e); }
});

// ── Analytics IPC ──

ipcMain.handle('get-analytics-today', () => {
  if (!currentUser) return null;
  endCurrentVisit();
  computeDailyMetrics();
  const today = getTodayStr();
  const daily = db.prepare('SELECT * FROM daily_analytics WHERE date=? AND user_pseudo=?').get(today, currentUser);
  const sessions = db.prepare('SELECT COUNT(*) as c FROM browser_sessions WHERE user_pseudo=? AND start_time>=?').get(currentUser, new Date(today).getTime());
  const totalSessions = db.prepare('SELECT COUNT(*) as c FROM browser_sessions WHERE user_pseudo=?').get(currentUser);
  const topSites = db.prepare(
    'SELECT domain, category, SUM(duration) as total, COUNT(*) as visits, MAX(title) as title FROM page_visits WHERE user_pseudo=? AND start_time>=? GROUP BY domain ORDER BY total DESC LIMIT 10'
  ).all(currentUser, new Date(today).getTime());
  const catDist = db.prepare(
    'SELECT category, SUM(duration) as total FROM page_visits WHERE user_pseudo=? AND start_time>=? GROUP BY category ORDER BY total DESC'
  ).all(currentUser, new Date(today).getTime());
  const wsBreakdown = db.prepare(
    "SELECT p.workspace_id, COALESCE(w.name, p.workspace_id) as name, SUM(p.duration) as total FROM page_visits p LEFT JOIN workspaces w ON w.id=p.workspace_id AND w.user_pseudo=p.user_pseudo WHERE p.user_pseudo=? AND p.start_time>=? GROUP BY p.workspace_id ORDER BY total DESC"
  ).all(currentUser, new Date(today).getTime());
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
  const topSites = db.prepare(
    'SELECT domain, category, SUM(duration) as total, COUNT(*) as visits FROM page_visits WHERE user_pseudo=? AND start_time>=? GROUP BY domain ORDER BY total DESC LIMIT 10'
  ).all(currentUser, weekAgo);
  return { daily, catDist, topSites };
});

ipcMain.handle('get-analytics-all-time', () => {
  if (!currentUser) return null;
  const totalTime = db.prepare('SELECT COALESCE(SUM(duration),0) as t FROM page_visits WHERE user_pseudo=?').get(currentUser);
  const totalVisits = db.prepare('SELECT COUNT(*) as c FROM page_visits WHERE user_pseudo=?').get(currentUser);
  const catDist = db.prepare('SELECT category, SUM(duration) as total FROM page_visits WHERE user_pseudo=? GROUP BY category ORDER BY total DESC').all(currentUser);
  const topSites = db.prepare('SELECT domain, category, SUM(duration) as total, COUNT(*) as visits FROM page_visits WHERE user_pseudo=? GROUP BY domain ORDER BY total DESC LIMIT 20').all(currentUser);
  const wsBreakdown = db.prepare("SELECT p.workspace_id, COALESCE(w.name, p.workspace_id) as name, SUM(p.duration) as total FROM page_visits p LEFT JOIN workspaces w ON w.id=p.workspace_id AND w.user_pseudo=p.user_pseudo WHERE p.user_pseudo=? GROUP BY p.workspace_id ORDER BY total DESC").all(currentUser);
  const sessions = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(duration),0) as total, COALESCE(AVG(duration),0) as avg FROM browser_sessions WHERE user_pseudo=?').get(currentUser);
  return { totalTime: totalTime.t, totalVisits: totalVisits.c, catDist, topSites, wsBreakdown, sessions };
});

ipcMain.handle('get-analytics-week-history', () => {
  if (!currentUser) return [];
  const weekAgo = Date.now() - 7 * 86400000;
  return db.prepare(
    'SELECT domain, category, title, start_time, duration FROM page_visits WHERE user_pseudo=? AND start_time>=? ORDER BY start_time DESC LIMIT 200'
  ).all(currentUser, weekAgo);
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
  if (parametersWindow && !parametersWindow.isDestroyed()) { parametersWindow.focus(); return; }
  parametersWindow = new BrowserWindow({
    width: 400, height: 420, parent: mainWindow, modal: true,
    title: 'Parameters - AEGIS', backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  parametersWindow.loadFile('parameters.html');
  parametersWindow.on('closed', () => { parametersWindow = null; });
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
  currentUser = null; currentWorkspace = null;
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
  if (loginUser(pseudo, password)) {
    clearLoginAttempts();
    clearWipeNotice();
    return { ok: true };
  }

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
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} t.view.webContents.close(); });
  });
  workspaceTabs = {};
  activeIdPerWorkspace = {};
  playingTabs.clear();
  updatePowerSaveBlocker();
  currentUser = null;
  currentWorkspace = null;
  idCounter = 0;
  splitMode = false; splitLeft = null; splitRight = null;
  invalidateBookmarkCache();
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
  Menu.setApplicationMenu(null);
  return { ok: true };
});

ipcMain.handle('get-user', () => {
  if (!currentUser) return null;
  const user = getUser(currentUser);
  return user ? { pseudo: user.pseudo, photo: user.photo || null } : null;
});

ipcMain.handle('change-password', (e, oldPw, newPw) => {
  if (!currentUser) return { ok: false, error: 'Not logged in.' };
  const user = getUser(currentUser);
  if (!user) return { ok: false, error: 'User not found.' };
  if (!verifyPassword(oldPw, user.salt, user.password)) return { ok: false, error: 'Current password is incorrect.' };
  if (!newPw || newPw.length < 3) return { ok: false, error: 'New password must be at least 3 characters.' };
  const { salt, hash } = hashPassword(newPw);
  db.prepare('UPDATE users SET password=?,salt=? WHERE pseudo=?').run(hash, salt, currentUser);
  return { ok: true };
});

ipcMain.handle('upload-photo', (e, base64) => {
  if (!currentUser) return { ok: false };
  db.prepare('UPDATE users SET photo=? WHERE pseudo=?').run(base64, currentUser);
  return { ok: true };
});

ipcMain.handle('verify-password', (e, password) => {
  if (!currentUser) return false;
  const user = getUser(currentUser);
  return user ? verifyPassword(password, user.salt, user.password) : false;
});

ipcMain.handle('login-guest', async () => {
  saveUserTabsPersist();
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} t.view.webContents.close(); });
  });
  workspaceTabs = {};
  activeIdPerWorkspace = {};
  idCounter = 0;
  splitMode = false; splitLeft = null; splitRight = null;

  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
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
  db.prepare('INSERT INTO users (pseudo,password,salt,created,photo,active_workspace) VALUES (?,?,?,?,?,?)').run(key, hash, salt, Date.now(), null, 'default');
  db.prepare('INSERT INTO workspaces (id,user_pseudo,name,created) VALUES (?,?,?,?)').run('default', key, 'Default', Date.now());
  currentUser = key;
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
  if (stmt.bookmarkCheck.get(currentUser, currentWorkspace, url)) return { ok: false, error: 'Already bookmarked.' };
  stmt.bookmarkInsert.run(currentUser, currentWorkspace, url, title||url, Date.now());
  invalidateBookmarkCache();
  return { ok: true };
});

ipcMain.handle('remove-bookmark', (e, url) => {
  if (!currentUser || !currentWorkspace) return { ok: false };
  stmt.bookmarkDelete.run(currentUser, currentWorkspace, url);
  invalidateBookmarkCache();
  return { ok: true };
});

ipcMain.handle('is-bookmarked', (e, url) => {
  if (!currentUser || !currentWorkspace) return false;
  const key = bookmarkKey(currentUser, currentWorkspace, url);
  if (bookmarkCache.has(key)) return bookmarkCache.get(key);
  const v = !!stmt.bookmarkCheck.get(currentUser, currentWorkspace, url);
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
  try { return stmt.noteList.all(currentUser, ws); } catch(e) { return []; }
});

ipcMain.handle('add-note', (e, content, wsId) => {
  const text = (content || '').trim();
  if (!notesReady()) return { ok: false, error: 'Not logged in.' };
  if (!text) return { ok: false, error: 'Note is empty.' };
  const ws = notesWsId(wsId);
  if (!ws) return { ok: false, error: 'No active workspace.' };
  const now = Date.now();
  try {
    const info = stmt.noteInsert.run(currentUser, ws, text, now, now);
    return { ok: true, note: { id: info.lastInsertRowid, workspaceId: ws, content: text, created: now, updated: now } };
  } catch(err) { return { ok: false, error: 'Could not save the note.' }; }
});

ipcMain.handle('update-note', (e, id, content) => {
  const text = (content || '').trim();
  if (!notesReady()) return { ok: false, error: 'Not logged in.' };
  if (!text) return { ok: false, error: 'Note is empty.' };
  try {
    const info = stmt.noteUpdate.run(text, Date.now(), id, currentUser);
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
  return getWorkspaces(currentUser).map(w => ({ id: w.id, name: w.name, created: w.created, color: w.color || '#4a8bc5', tabCount: countMap[w.id] || 0 }));
});

ipcMain.handle('get-active-workspace', () => {
  if (!currentUser) return null;
  const user = getUser(currentUser);
  if (!user) return null;
  const id = user.active_workspace || 'default';
  const ws = getWorkspace(currentUser, id);
  return { id, name: ws ? ws.name : 'Default', color: ws ? (ws.color || '#4a8bc5') : '#4a8bc5' };
});

ipcMain.handle('create-workspace', (e, name) => {
  if (!currentUser) return { ok: false, error: 'Not logged in.' };
  const id = 'ws_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const wsColors = ['#4a8bc5','#7a5db5','#48bb78','#e5834a','#e56a6a','#4ac5b5','#c5a84a','#9b5de5'];
  const existing = getWorkspaces(currentUser).length;
  const color = wsColors[existing % wsColors.length];
  db.prepare('INSERT INTO workspaces (id,user_pseudo,name,created,color) VALUES (?,?,?,?,?)').run(id, currentUser, name, Date.now(), color);
  return { ok: true, id, color };
});

ipcMain.handle('rename-workspace', (e, id, name) => {
  if (!currentUser) return { ok: false };
  if (!getWorkspace(currentUser, id)) return { ok: false };
  db.prepare('UPDATE workspaces SET name=? WHERE id=? AND user_pseudo=?').run(name, id, currentUser);
  return { ok: true };
});

ipcMain.handle('delete-workspace', (e, id) => {
  if (!currentUser) return { ok: false };
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
  const splitPartition = 'persist:user_' + currentUser + '_ws_' + wsId;
  usedPartitions.add(splitPartition);
  const view = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, partition: splitPartition, disableHtmlFullscreenWindowResize: false, backgroundThrottling: false },
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
      playingTabs.set(id, { title: view.webContents.getTitle(), url: view.webContents.getURL() });
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
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (splitMode && currentWorkspace === wsId) addTab(url);
    else addTab(url);
    return { action: 'deny' };
  });
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

ipcMain.handle('get-media-state', () => {
  const entries = Array.from(playingTabs.entries()).map(([id, info]) => ({ id, ...info }));
  const byWorkspace = {};
  entries.forEach(t => { if (!byWorkspace[t.workspaceId]) byWorkspace[t.workspaceId] = []; byWorkspace[t.workspaceId].push(t); });
  return { playing: playingTabs.size > 0, tabs: entries, byWorkspace };
});

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

ipcMain.on('suggest-toggle', (e, { open, height }) => {
  suggestHeight = open ? (height || 200) : 0;
  syncViews();
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
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  flushSessionsSync();
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
