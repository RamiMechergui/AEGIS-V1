const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, dialog, shell, clipboard, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

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

const TOP = 78;
const BOTTOM = 22;
const DB_PATH = path.join(app.getPath('userData'), 'ghostview.db');

app.commandLine.appendSwitch('disable-features', 'MediaRouter,ChromeWhatsNewUI');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-features', 'msWebOOUI');
app.setAsDefaultProtocolClient('ghostview');

let mainWindow;
let workspaceTabs = {};
let activeIdPerWorkspace = {};
let idCounter = 0;
let currentUser = null;
let currentWorkspace = null;
let autoSaveInterval = null;
let idleTimeout = null;
const IDLE_TIMEOUT_MS = 300000;
let panelOpen = false;
const PANEL_WIDTH = 400;
let zoomLevel = 0;
let downloadsWindow = null;
let splitMode = false;
let splitLeft = null;
let splitRight = null;
let splitRatio = 0.5;
let db;
let playingTabs = new Map();
let powerSaveId = null;

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

function syncViews() {
  Object.values(workspaceTabs).forEach(tabs => {
    tabs.forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const isFS = mainWindow.isFullScreen();
  const b = mainWindow.getBounds();
  const pw = panelOpen ? PANEL_WIDTH : 0;
  const top = TOP;
  const h = b.height - top - (isFS ? 0 : BOTTOM);
  if (splitMode && splitLeft && splitRight) {
    const gap = 4;
    const handleW = 6;
    const totalW = b.width - pw;
    const leftW = Math.floor(totalW * splitRatio);
    const rightW = totalW - leftW - handleW - gap;
    const lt = getActiveTab(splitLeft);
    if (lt) { lt.view.setBounds({ x:0, y:top, width:leftW, height:h }); mainWindow.contentView.addChildView(lt.view); }
    const rt = getActiveTab(splitRight);
    if (rt) { rt.view.setBounds({ x:leftW + gap + handleW, y:top, width:rightW, height:h }); mainWindow.contentView.addChildView(rt.view); }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-bounds', { left: leftW, right: rightW, handleX: leftW + gap, total: totalW });
  } else if (currentWorkspace) {
    const t = getActiveTab(currentWorkspace);
    if (t) { t.view.setBounds({ x:0, y:top, width:b.width-pw, height:h }); mainWindow.contentView.addChildView(t.view); }
  }
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
  `);
  try { db.exec('ALTER TABLE downloads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT \'\''); } catch(e) {}
  try { db.exec('UPDATE downloads SET workspace_id = \'default\' WHERE workspace_id = \'\''); } catch(e) {}
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
  const info = db.prepare(
    'INSERT INTO page_visits (user_pseudo,workspace_id,url,domain,category,title,start_time) VALUES (?,?,?,?,?,?,?)'
  ).run(currentUser, wsId || currentWorkspace, url.slice(0, 2048), domain, category, title || '', now);
  currentVisit = { visitId: info.lastInsertRowid, tabId, url, domain, category, startTime: now };
  sessionDomains.add(domain);
}

function endCurrentVisit() {
  if (!currentVisit || !currentUser) return;
  const now = Date.now();
  const dur = now - currentVisit.startTime;
  db.prepare('UPDATE page_visits SET end_time=?,duration=? WHERE id=?').run(now, dur, currentVisit.visitId);
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
  }, 60000);
}

function startAnalyticsForUser() {
  analyticsEnabled = true;
  sessionStartTime = null;
  currentVisit = null;
  sessionDomains = new Set();
  sessionTabSwitches = 0;
  initAnalyticsTimers();
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
function getTabsDb(p, wsId) { return db.prepare('SELECT url, title FROM tabs WHERE user_pseudo=? AND workspace_id=?').all(p, wsId); }
function saveTabsDb(p, wsId, list) {
  const del = db.prepare('DELETE FROM tabs WHERE user_pseudo=? AND workspace_id=?');
  const ins = db.prepare('INSERT INTO tabs (user_pseudo,workspace_id,url,title) VALUES (?,?,?,?)');
  db.transaction(() => { del.run(p, wsId); list.forEach(t => ins.run(p, wsId, t.url, t.title)); })();
}
function getHistDb(p, wsId) { return db.prepare('SELECT url,title,timestamp FROM history WHERE user_pseudo=? AND workspace_id=? ORDER BY timestamp DESC LIMIT 200').all(p, wsId); }
function getBmDb(p, wsId) { return db.prepare('SELECT url,title,timestamp FROM bookmarks WHERE user_pseudo=? AND workspace_id=? ORDER BY timestamp DESC').all(p, wsId); }
function ensureDefaultWs(p) { if (!getWorkspace(p, 'default')) db.prepare('INSERT OR IGNORE INTO workspaces (id,user_pseudo,name,created) VALUES (?,?,?,?)').run('default', p, 'Default', Date.now()); }

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
      { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => toggleDownloads() },
      { type: 'separator' },
      { label: 'Split', submenu: splitItems },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Escape', click: () => app.quit() },
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
  return { x: 0, y: TOP, width: b.width - pw, height: b.height - TOP - BOTTOM };
}

function addTab(url, partition) {
  const tabs = currentTabs();
  const id = idCounter++;
  const wsPartition = partition || (currentWorkspace ? 'persist:ws_' + currentWorkspace : undefined);
  const view = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, partition: wsPartition, disableHtmlFullscreenWindowResize: false, backgroundThrottling: false },
  });

  const ses = view.webContents.session;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  const wsId = currentWorkspace;
  ses.on('will-download', (e, item) => handleDownload(item, wsId));

  view.setBounds(contentBounds());
  view.webContents.loadURL(url);
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
  view.webContents.on('page-title-updated', (e, t) => { emit('tab-updated', { title: t, ws: currentWorkspace }); updatePlayingTabMeta(); saveUserTabsPersist(); });
  view.webContents.on('page-favicon-updated', (e, favicons) => { if (favicons && favicons.length > 0) { const tab = tabs.find(t => t.id === id); if (tab) tab.favicon = favicons[0]; emit('tab-updated', { favicon: favicons[0], ws: currentWorkspace }); } });
  function resetFavicon() { const tab = tabs.find(t => t.id === id); if (tab) tab.favicon = ''; }
  view.webContents.on('did-navigate', (e, u) => { resetFavicon(); emit('tab-updated', { url: u, favicon: '', ws: currentWorkspace }); emitNav(); addHistory(u, view.webContents.getTitle()); saveUserTabsPersist(); if (u && u !== 'about:blank') { ensureSession(); recordVisitStart(id, u, view.webContents.getTitle(), currentWorkspace); } });
  view.webContents.on('did-navigate-in-page', (e, u) => { if (e.isMainFrame) { resetFavicon(); emit('tab-updated', { url: u, favicon: '', ws: currentWorkspace }); emitNav(); addHistory(u, view.webContents.getTitle()); saveUserTabsPersist(); if (u && u !== 'about:blank') { ensureSession(); recordVisitStart(id, u, view.webContents.getTitle(), currentWorkspace); } } });
  view.webContents.on('did-start-loading', () => emit('tab-loading', { loading: true }));
  view.webContents.on('did-stop-loading', () => { emit('tab-loading', { loading: false }); emitNav(); });
  view.webContents.on('update-target-url', (e, u) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status-url', u || ''); });
  view.webContents.on('found-in-page', (e, result) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('find-result', result); });

  view.webContents.on('media-started-playing', () => {
    playingTabs.set(id, { title: view.webContents.getTitle(), url: view.webContents.getURL(), workspaceId: currentWorkspace });
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
  setActiveId(currentWorkspace, id);
  syncViews();
  broadcastTabs();
  saveUserTabsPersist();
  return id;
}

function addHistory(url, title, wsId) {
  const id = wsId || currentWorkspace;
  if (!currentUser || !id || !url || url === 'about:blank') return;
  db.prepare('INSERT INTO history (user_pseudo,workspace_id,url,title,timestamp) VALUES (?,?,?,?,?)').run(currentUser, id, url, title||url, Date.now());
}

function saveUserTabsPersist() {
  const tabs = currentTabs();
  if (!currentUser || !currentWorkspace || !tabs.length) return;
  saveTabsDb(currentUser, currentWorkspace, tabs.map(t => ({ url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() })));
}

function resetIdleTimer() {
  if (idleTimeout) clearTimeout(idleTimeout);
  idleTimeout = setTimeout(() => {
    if (!currentUser) return;
    saveUserTabsPersist();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-login');
  }, IDLE_TIMEOUT_MS);
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
  tabs.splice(idx, 1);
  setCurrentTabs(tabs);
  if (getActiveId(currentWorkspace) === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    setActiveId(currentWorkspace, next.id);
  }
  syncViews();
  broadcastTabs();
  saveUserTabsPersist();
}

function broadcastTabs() {
  const tabs = currentTabs();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tabs-list', { ws: currentWorkspace, tabs: tabs.map(t => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), favicon: t.favicon || '' })) });
}

function activeTab() { return getActiveTab(currentWorkspace); }

function hideAllViews() {
  Object.values(workspaceTabs).forEach(tabs => {
    tabs.forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  });
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
    const savedTabs = getTabsDb(currentUser, currentWorkspace);
    workspaceTabs[currentWorkspace] = [];
    if (savedTabs.length > 0) savedTabs.forEach(t => addTab(t.url));
    else addTab('https://www.google.com');
  } else {
    syncViews();
    broadcastTabs();
  }
  resetIdleTimer();
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(saveUserTabsPersist, 30000);
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
    const savedTabs = getTabsDb(currentUser, workspaceId);
    workspaceTabs[workspaceId] = [];
    if (savedTabs.length > 0) savedTabs.forEach(t => addTab(t.url));
    else addTab('https://www.google.com');
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-switched', { id: workspaceId, name: ws ? ws.name : '' });
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
      template.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
      template.push({ type: 'separator' });
    }
    if (params.mediaType === 'image') {
      template.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) });
      template.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
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

function sanitizeFilename(name) {
  return name.replace(/[<>:"\/\\|?*]/g, '_').trim();
}

function handleDownload(item, wsId) {
  const dlWsId = wsId || currentWorkspace || 'default';
  let name = sanitizeFilename(item.getFilename());
  if (!name) name = 'download_' + Date.now();
  const total = item.getTotalBytes();
  const url = item.getURL();
  const dlId = downloadIdCounter++;
  const savePath = path.join(app.getPath('downloads'), name);
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
    width: 400, height: 580, parent: mainWindow, modal: true,
    title: 'Settings - AEGIS', backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
});

app.whenReady().then(() => { initDB(); createWindow(); });

// ── Auth IPC ──

ipcMain.handle('register', (e, pseudo, password) => {
  if (!pseudo || !password || pseudo.length < 2 || password.length < 3) return { ok: false, error: 'Pseudonym (min 2 chars) and password (min 3 chars) required.' };
  if (userExists(pseudo)) return { ok: false, error: 'User already exists.' };
  registerUser(pseudo, password);
  return { ok: true };
});

ipcMain.handle('login', (e, pseudo, password) => {
  if (!pseudo || !password) return { ok: false, error: 'Enter pseudonym and password.' };
  if (!loginUser(pseudo, password)) return { ok: false, error: 'Invalid credentials.' };
  return { ok: true };
});

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

// ── Bookmarks IPC ──

ipcMain.handle('get-bookmarks', () => {
  if (!currentUser || !currentWorkspace) return [];
  return getBmDb(currentUser, currentWorkspace);
});

ipcMain.handle('add-bookmark', (e, url, title) => {
  if (!currentUser || !currentWorkspace) return { ok: false };
  if (db.prepare('SELECT id FROM bookmarks WHERE user_pseudo=? AND workspace_id=? AND url=?').get(currentUser, currentWorkspace, url)) return { ok: false, error: 'Already bookmarked.' };
  db.prepare('INSERT INTO bookmarks (user_pseudo,workspace_id,url,title,timestamp) VALUES (?,?,?,?,?)').run(currentUser, currentWorkspace, url, title||url, Date.now());
  return { ok: true };
});

ipcMain.handle('remove-bookmark', (e, url) => {
  if (!currentUser || !currentWorkspace) return { ok: false };
  db.prepare('DELETE FROM bookmarks WHERE user_pseudo=? AND workspace_id=? AND url=?').run(currentUser, currentWorkspace, url);
  return { ok: true };
});

ipcMain.handle('is-bookmarked', (e, url) => {
  if (!currentUser || !currentWorkspace) return false;
  return !!db.prepare('SELECT id FROM bookmarks WHERE user_pseudo=? AND workspace_id=? AND url=?').get(currentUser, currentWorkspace, url);
});

// ── Workspace IPC ──

ipcMain.handle('get-workspaces', () => {
  if (!currentUser) return [];
  ensureDefaultWs(currentUser);
  return getWorkspaces(currentUser).map(w => ({ id: w.id, name: w.name, created: w.created, tabCount: getTabsDb(currentUser, w.id).length }));
});

ipcMain.handle('get-active-workspace', () => {
  if (!currentUser) return null;
  const user = getUser(currentUser);
  if (!user) return null;
  const id = user.active_workspace || 'default';
  const ws = getWorkspace(currentUser, id);
  return { id, name: ws ? ws.name : 'Default' };
});

ipcMain.handle('create-workspace', (e, name) => {
  if (!currentUser) return { ok: false, error: 'Not logged in.' };
  const id = 'ws_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  db.prepare('INSERT INTO workspaces (id,user_pseudo,name,created) VALUES (?,?,?,?)').run(id, currentUser, name, Date.now());
  return { ok: true, id };
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
  db.prepare('DELETE FROM tabs WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
  db.prepare('DELETE FROM history WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
  db.prepare('DELETE FROM bookmarks WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
  db.prepare('DELETE FROM workspaces WHERE id=? AND user_pseudo=?').run(id, currentUser);
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
    workspaceTabs[rightWsId] = [];
    savedTabs.forEach(t => addTabToSplit(t.url, rightWsId));
    if (workspaceTabs[rightWsId].length === 0) addTabToSplit('https://www.google.com', rightWsId);
    if (!getActiveId(rightWsId)) setActiveId(rightWsId, workspaceTabs[rightWsId][0]?.id);
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
  const view = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, partition: 'persist:ws_' + wsId, disableHtmlFullscreenWindowResize: false, backgroundThrottling: false },
  });
  const ses = view.webContents.session;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  ses.on('will-download', (e, item) => handleDownload(item, wsId));
  view.setBounds({ x:0, y:TOP, width:100, height:100 });
  view.webContents.loadURL(url);
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
  view.webContents.on('page-title-updated', (e, t) => { emit('tab-updated', { title: t, ws: wsId }); updatePlayingTabMeta(); saveUserTabsPersist(); });
  view.webContents.on('page-favicon-updated', (e, favicons) => { if (favicons && favicons.length > 0) { const tab = tabs.find(t => t.id === id); if (tab) tab.favicon = favicons[0]; emit('tab-updated', { favicon: favicons[0], ws: wsId }); } });
  function resetFavicon() { const tab = tabs.find(t => t.id === id); if (tab) tab.favicon = ''; }
  view.webContents.on('did-navigate', (e, u) => { resetFavicon(); emit('tab-updated', { url: u, favicon: '', ws: wsId }); emitNav(); addHistory(u, view.webContents.getTitle(), wsId); saveUserTabsPersist(); if (u && u !== 'about:blank') { ensureSession(); recordVisitStart(id, u, view.webContents.getTitle(), wsId); } });
  view.webContents.on('did-navigate-in-page', (e, u) => { if (e.isMainFrame) { resetFavicon(); emit('tab-updated', { url: u, favicon: '', ws: wsId }); emitNav(); addHistory(u, view.webContents.getTitle(), wsId); saveUserTabsPersist(); if (u && u !== 'about:blank') { ensureSession(); recordVisitStart(id, u, view.webContents.getTitle(), wsId); } } });
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
ipcMain.handle('get-tabs', () => currentTabs().map(t => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() })));

ipcMain.handle('get-tabs-for-workspace', (e, wsId) => {
  const tabs = workspaceTabs[wsId];
  if (!tabs) return [];
  return tabs.map(t => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() }));
});

ipcMain.handle('get-media-state', () => {
  const entries = Array.from(playingTabs.entries()).map(([id, info]) => ({ id, ...info }));
  const byWorkspace = {};
  entries.forEach(t => { if (!byWorkspace[t.workspaceId]) byWorkspace[t.workspaceId] = []; byWorkspace[t.workspaceId].push(t); });
  return { playing: playingTabs.size > 0, tabs: entries, byWorkspace };
});

ipcMain.handle('fetch-suggestions', async (e, q) => {
  if (!q || !q.trim()) return [];
  try {
    const res = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&q=' + encodeURIComponent(q));
    const data = await res.json();
    return data[1] || [];
  } catch(e) { return []; }
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

// ── Fullscreen ──

function setupF11Handler(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
    if (input.key === 'Escape' && input.type === 'keyDown') {
      event.preventDefault();
      app.quit();
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

ipcMain.on('quit-app', () => app.quit());

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', async () => {
  saveUserTabsPersist();
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData();
    if (currentWorkspace) {
      try { const ws = session.fromPartition('persist:ws_' + currentWorkspace); await ws.clearCache(); await ws.clearStorageData(); } catch(e) {}
    }
  } catch(e) {}
});

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}
