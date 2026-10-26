const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ghost', {
  // Auth
  register: (p, pw) => ipcRenderer.invoke('register', p, pw),
  login: (p, pw) => ipcRenderer.invoke('login', p, pw),
  wipeNotice: () => ipcRenderer.invoke('wipe-notice'),
  logout: () => ipcRenderer.invoke('logout'),
  enterBrowser: () => ipcRenderer.send('enter-browser'),
  clearMenu: () => ipcRenderer.send('clear-menu'),
  openSettings: () => ipcRenderer.send('open-settings'),
  openParameters: () => ipcRenderer.send('open-parameters'),
  getAutoClose: () => ipcRenderer.invoke('get-auto-close'),
  setAutoClose: (enabled, seconds) => ipcRenderer.invoke('set-auto-close', enabled, seconds),
  openHistory: () => ipcRenderer.send('open-history'),
  changePassword: (oldPw, newPw) => ipcRenderer.invoke('change-password', oldPw, newPw),
  uploadPhoto: (base64) => ipcRenderer.invoke('upload-photo', base64),
  verifyPassword: (pw) => ipcRenderer.invoke('verify-password', pw),
  getUser: () => ipcRenderer.invoke('get-user'),
  getHistory: (wsId) => ipcRenderer.invoke('get-history', wsId),
  clearHistory: (wsId) => ipcRenderer.invoke('clear-history', wsId),

  // Workspaces
  getWorkspaces: () => ipcRenderer.invoke('get-workspaces'),
  getActiveWorkspace: () => ipcRenderer.invoke('get-active-workspace'),
  createWorkspace: (name) => ipcRenderer.invoke('create-workspace', name),
  renameWorkspace: (id, name) => ipcRenderer.invoke('rename-workspace', id, name),
  deleteWorkspace: (id) => ipcRenderer.invoke('delete-workspace', id),
  selectWorkspace: (id) => ipcRenderer.invoke('select-workspace', id),
  switchWorkspace: (id) => ipcRenderer.invoke('switch-workspace', id),
  onWorkspaceSwitched: (cb) => ipcRenderer.on('workspace-switched', (e, d) => cb(d)),

  // Bookmarks
  getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
  addBookmark: (url, title) => ipcRenderer.invoke('add-bookmark', url, title),
  removeBookmark: (url) => ipcRenderer.invoke('remove-bookmark', url),
  isBookmarked: (url) => ipcRenderer.invoke('is-bookmarked', url),

  // Notes
  getNotes: () => ipcRenderer.invoke('get-notes'),
  addNote: (content) => ipcRenderer.invoke('add-note', content),
  updateNote: (id, content) => ipcRenderer.invoke('update-note', id, content),
  deleteNote: (id) => ipcRenderer.invoke('delete-note', id),
  onToggleNotes: (cb) => ipcRenderer.on('toggle-notes', () => cb()),

  // Browser
  navigate: (u) => ipcRenderer.send('navigate', u),
  navigateWorkspace: (wsId, u) => ipcRenderer.send('navigate-workspace', wsId, u),
  navigateNewTab: (u) => ipcRenderer.send('navigate-new-tab', u),
  newTab: (u) => ipcRenderer.send('new-tab', u),
  newTabWorkspace: (wsId, u) => ipcRenderer.send('new-tab-workspace', wsId, u),
  closeTab: (id) => ipcRenderer.send('close-tab', id),
  closeTabWorkspace: (wsId, id) => ipcRenderer.send('close-tab-workspace', wsId, id),
  activateTab: (id) => ipcRenderer.send('activate-tab', id),
  activateTabWorkspace: (wsId, id) => ipcRenderer.send('activate-tab-workspace', wsId, id),
  tabContextMenu: (id, wsId) => ipcRenderer.send('tab-context-menu', id, wsId),
  goBack: () => ipcRenderer.send('go-back'),
  goBackWorkspace: (wsId) => ipcRenderer.send('go-back-workspace', wsId),
  goForward: () => ipcRenderer.send('go-forward'),
  goForwardWorkspace: (wsId) => ipcRenderer.send('go-forward-workspace', wsId),
  reload: () => ipcRenderer.send('reload'),
  reloadWorkspace: (wsId) => ipcRenderer.send('reload-workspace', wsId),
  stop: () => ipcRenderer.send('stop'),
  stopWorkspace: (wsId) => ipcRenderer.send('stop-workspace', wsId),
  resizeContent: () => ipcRenderer.send('resize-content'),
  panelToggle: (open) => ipcRenderer.send('panel-toggle', open),
  getTabs: () => ipcRenderer.invoke('get-tabs'),
  getTabsForWorkspace: (wsId) => ipcRenderer.invoke('get-tabs-for-workspace', wsId),
  onTabUpdated: (cb) => ipcRenderer.on('tab-updated', (e, d) => cb(d)),
  onTabLoading: (cb) => ipcRenderer.on('tab-loading', (e, d) => cb(d)),
  onTabActivated: (cb) => ipcRenderer.on('tab-activated', (e, d) => cb(d)),
  onTabsList: (cb) => ipcRenderer.on('tabs-list', (e, d) => cb(d)),
  onStatusUrl: (cb) => ipcRenderer.on('status-url', (e, d) => cb(d)),
  onShowHistory: (cb) => ipcRenderer.on('show-history', () => cb()),
  onReturnToLogin: (cb) => ipcRenderer.on('return-to-login', () => cb()),
  onReturnToWorkspaces: (cb) => ipcRenderer.on('return-to-workspaces', () => cb()),
  cleanupTabs: () => ipcRenderer.invoke('cleanup-tabs'),
  saveTabs: () => ipcRenderer.invoke('save-tabs'),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  onNavState: (cb) => ipcRenderer.on('nav-state', (e, d) => cb(d)),

  // Zoom
  zoomIn: () => ipcRenderer.send('zoom-in'),
  zoomOut: () => ipcRenderer.send('zoom-out'),
  zoomReset: () => ipcRenderer.send('zoom-reset'),
  onZoomChanged: (cb) => ipcRenderer.on('zoom-changed', (e, d) => cb(d)),

  // Find
  findStart: (text) => ipcRenderer.send('find-start', text),
  findNext: (text) => ipcRenderer.send('find-next', text),
  findStop: () => ipcRenderer.send('find-stop'),
  onFindResult: (cb) => ipcRenderer.on('find-result', (e, d) => cb(d)),

  // Fullscreen
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  onFullscreenChange: (cb) => ipcRenderer.on('fs-change', (e, d) => cb(d)),

  // Home
  goHome: () => ipcRenderer.send('go-home'),

  // Default browser & network speed
  getDefaultBrowserStatus: () => ipcRenderer.invoke('get-default-browser-status'),
  setDefaultBrowser: () => ipcRenderer.invoke('set-default-browser'),
  getNetPrefs: () => ipcRenderer.invoke('get-net-prefs'),
  setNetPrefs: (prefs) => ipcRenderer.invoke('set-net-prefs', prefs),

  // Idle
  resetIdleTimer: () => ipcRenderer.send('reset-idle'),

  // Split View
  enterSplit: (wsId) => ipcRenderer.invoke('enter-split', wsId),
  exitSplit: () => ipcRenderer.invoke('exit-split'),
  focusSplitPane: (side) => ipcRenderer.invoke('focus-split-pane', side),
  onSplitChanged: (cb) => ipcRenderer.on('split-changed', (e, d) => cb(d)),
  setSplitRatio: (ratio) => ipcRenderer.invoke('set-split-ratio', ratio),
  onSplitBounds: (cb) => ipcRenderer.on('split-bounds', (e, d) => cb(d)),

  // Downloads
  getDownloads: () => ipcRenderer.invoke('get-downloads'),
  getDownloadsForWs: (wsId) => ipcRenderer.invoke('get-downloads', wsId),
  getDownloadsHistory: () => ipcRenderer.invoke('get-downloads-history'),
  getDownloadsHistoryForWs: (wsId) => ipcRenderer.invoke('get-downloads-history', wsId),
  getDownloadDir: () => ipcRenderer.invoke('get-download-dir'),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d)),
  onToggleDownloads: (cb) => ipcRenderer.on('toggle-downloads', () => cb()),
  onDownloadsCleared: (cb) => ipcRenderer.on('downloads-cleared', () => cb()),
  openDownloadFolder: (savePath) => ipcRenderer.invoke('open-download-folder', savePath),
  openDownloadFile: (savePath) => ipcRenderer.invoke('open-download-file', savePath),
  deleteDownload: (savePath, dlId, deleteFile) => ipcRenderer.invoke('delete-download', savePath, dlId, deleteFile),

  // Media / Background
  onMediaState: (cb) => ipcRenderer.on('media-state', (e, d) => cb(d)),
  onBrowserChromeVisibility: (cb) => ipcRenderer.on('browser-chrome-visibility', (e, d) => cb(d)),
  getMediaState: () => ipcRenderer.invoke('get-media-state'),

  // Analytics
  getAnalyticsToday: () => ipcRenderer.invoke('get-analytics-today'),
  getAnalyticsWeekly: () => ipcRenderer.invoke('get-analytics-weekly'),
  getAnalyticsAllTime: () => ipcRenderer.invoke('get-analytics-all-time'),
  getAnalyticsWeekHistory: () => ipcRenderer.invoke('get-analytics-week-history'),
  analyticsDeleteAll: () => ipcRenderer.invoke('analytics-delete-all'),
  analyticsToggle: (enabled) => ipcRenderer.invoke('analytics-toggle', enabled),
  getAnalyticsStatus: () => ipcRenderer.invoke('get-analytics-status'),

  // Suggestions
  fetchSuggestions: (q) => ipcRenderer.invoke('fetch-suggestions', q),
  suggestToggle: (open, height) => ipcRenderer.send('suggest-toggle', { open, height }),

  // Navigation from toolbar menu
  returnToWorkspaces: () => ipcRenderer.send('return-to-workspaces-req'),
  returnToLogin: () => ipcRenderer.send('return-to-login-req'),

  // Emergency
  loginGuest: () => ipcRenderer.invoke('login-guest'),
  quitApp: () => ipcRenderer.send('quit-app'),
  confirmQuitAction: (action) => ipcRenderer.send('confirm-quit-action', action),
});
