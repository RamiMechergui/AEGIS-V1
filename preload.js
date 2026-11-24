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
  // Duress password (panic decoy): null removes it.
  setDuressPassword: (pw) => ipcRenderer.invoke('set-duress-password', pw),
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
  getGoogleAccounts: () => ipcRenderer.invoke('get-google-accounts'),
  getGoogleEmail: (wsId) => ipcRenderer.invoke('get-google-email', wsId),
  // Background watcher: main detected another / a newly opened account email.
  onGoogleEmailChanged: (cb) => ipcRenderer.on('google-email-changed', (e, d) => cb(d)),

  // Bookmarks
  getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
  addBookmark: (url, title) => ipcRenderer.invoke('add-bookmark', url, title),
  removeBookmark: (url) => ipcRenderer.invoke('remove-bookmark', url),
  isBookmarked: (url) => ipcRenderer.invoke('is-bookmarked', url),

  // Notes
  getNotes: (wsId) => ipcRenderer.invoke('get-notes', wsId),
  addNote: (content, wsId) => ipcRenderer.invoke('add-note', content, wsId),
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

  // Aegis Shield (ad/tracker blocking, fingerprint randomizer, URL cleaner)
  getShieldPrefs: () => ipcRenderer.invoke('shield-get-prefs'),
  setShieldPrefs: (prefs) => ipcRenderer.invoke('shield-set-prefs', prefs),
  getShieldStats: () => ipcRenderer.invoke('shield-get-stats'),

  // Clipboard auto-wipe (clears copied text after N seconds)
  getClipboardPrefs: () => ipcRenderer.invoke('clip-get-prefs'),
  setClipboardPrefs: (prefs) => ipcRenderer.invoke('clip-set-prefs', prefs),

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
  getAllDownloads: () => ipcRenderer.invoke('get-all-downloads'),
  getDownloadsHistory: () => ipcRenderer.invoke('get-downloads-history'),
  getDownloadsHistoryForWs: (wsId) => ipcRenderer.invoke('get-downloads-history', wsId),
  getDownloadDir: () => ipcRenderer.invoke('get-download-dir'),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d)),
  onToggleDownloads: (cb) => ipcRenderer.on('toggle-downloads', () => cb()),
  onDownloadsCleared: (cb) => ipcRenderer.on('downloads-cleared', () => cb()),
  openDownloadFolder: (savePath) => ipcRenderer.invoke('open-download-folder', savePath),
  openDownloadFile: (savePath) => ipcRenderer.invoke('open-download-file', savePath),
  deleteDownload: (savePath, dlId, deleteFile) => ipcRenderer.invoke('delete-download', savePath, dlId, deleteFile),
  // Workspace-wide download shelf: reserves the bottom strip of the content
  // area so shelf progress renders above every page view, on every tab.
  dlShelfReserve: (px) => ipcRenderer.send('dl-shelf-reserve', px),

  // YouTube video download (toolbar button on youtube.com pages)
  ytVideoInfo: (url) => ipcRenderer.invoke('yt-video-info', url),
  ytStartDownload: (opts) => ipcRenderer.invoke('yt-start-download', opts),
  ytCancelDownload: (jobId) => ipcRenderer.invoke('yt-cancel-download', jobId),
  // Destination folders: the default for ALL downloads (Parameters window)
  // and the YouTube-specific override (Youtube Download parameters). Choose =
  // native folder dialog WITHOUT persisting; Save = persist after validating.
  ytDownloadDir: () => ipcRenderer.invoke('yt-download-dir'),
  ytPickDir: () => ipcRenderer.invoke('yt-pick-dir'),
  dlParams: () => ipcRenderer.invoke('dl-params'),
  setDownloadDir: (dir) => ipcRenderer.invoke('set-download-dir', dir),
  chooseDownloadDir: () => ipcRenderer.invoke('choose-download-dir'),
  ytDlParams: () => ipcRenderer.invoke('yt-dl-params'),
  ytSetDownloadDir: (dir) => ipcRenderer.invoke('yt-set-download-dir', dir),
  ytResetDownloadDir: () => ipcRenderer.invoke('yt-reset-download-dir'),
  onYtProgress: (cb) => ipcRenderer.on('yt-progress', (e, d) => cb(d)),
  // Floating quality popover (controls.html → main.js → yt-overlay.html).
  // The popover is mirrored into its own WebContentsView so it layers ABOVE the
  // page views; controls.html keeps the real copy as the source of truth.
  ytOverlay: (data) => ipcRenderer.invoke('yt-overlay', data),
  ytOverlayAction: (a) => ipcRenderer.invoke('yt-overlay-action', a),
  ytOverlayHover: (h) => ipcRenderer.send('yt-overlay-hover', !!h),
  onYtOverlayRender: (cb) => ipcRenderer.on('yt-overlay-render', (e, d) => cb(d)),
  onYtOverlayAction: (cb) => ipcRenderer.on('yt-overlay-action', (e, a) => cb(a)),
  onYtOverlayHover: (cb) => ipcRenderer.on('yt-overlay-hover', (e, h) => cb(!!h)),
  // Download Full Playlist: the toolbar button opens a dedicated playlist.html
  // window, which streams the playlist's videos, lets the user select them
  // and drives the ONE-video-at-a-time queue in the main process.
  ytPlaylistWindow: (opts) => ipcRenderer.invoke('yt-playlist-window', opts),
  ytPlaylistVideos: (url) => ipcRenderer.invoke('yt-playlist-videos', { url }),
  ytPlaylistVideosCancel: () => ipcRenderer.invoke('yt-playlist-videos-cancel'),
  onPlaylistVideos: (cb) => ipcRenderer.on('playlist-videos', (e, d) => cb(d)),
  ytPlaylistStart: (opts) => ipcRenderer.invoke('yt-playlist-start', opts),
  ytPlaylistState: () => ipcRenderer.invoke('yt-playlist-state'),
  ytPlaylistControl: (opts) => ipcRenderer.invoke('yt-playlist-control', opts),
  onPlaylistProgress: (cb) => ipcRenderer.on('playlist-progress', (e, d) => cb(d)),
  onPlaylistWindowOpen: (cb) => ipcRenderer.on('playlist-window-open', (e, d) => cb(d)),

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
  // Floating overlay dropdown (controls.html ↔ main.js ↔ suggest-overlay.html)
  suggestOverlay: (data) => ipcRenderer.invoke('suggest-overlay', data),
  onSuggestPicked: (cb) => ipcRenderer.on('suggest-picked', (e, i) => cb(i)),
  suggestPick: (idx) => ipcRenderer.send('suggest-pick', idx),
  onSuggestData: (cb) => ipcRenderer.on('suggest-data', (e, d) => cb(d)),

  // Connection (public IP / country / governorate / ISP panel)
  getConnectionInfo: (force) => ipcRenderer.invoke('get-connection-info', !!force),
  // Internet speed test (Connection panel → "Test Internet speed")
  testInternetSpeed: () => ipcRenderer.invoke('test-internet-speed'),
  onSpeedProgress: (cb) => ipcRenderer.on('speed-progress', (e, d) => cb(d)),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  // Navigation from toolbar menu
  returnToWorkspaces: () => ipcRenderer.send('return-to-workspaces-req'),
  returnToLogin: () => ipcRenderer.send('return-to-login-req'),

  // Emergency
  loginGuest: () => ipcRenderer.invoke('login-guest'),
  quitApp: () => ipcRenderer.send('quit-app'),
  confirmQuitAction: (action) => ipcRenderer.send('confirm-quit-action', action),
});
