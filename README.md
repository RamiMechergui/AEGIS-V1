# AEGIS

Privacy-focused desktop browser built with Electron. Zero tracking, zero cache persistence by default, per-user workspaces, and a fully local profile.

## Features

- **Per-user accounts** — local-only registration (SQLite + salted password hashing), guest mode, optional profile photo.
- **Workspaces** — each user gets isolated workspaces with their own tabs, restored automatically on login. Split-screen mode for two workspaces side by side.
- **Tab session persistence** — tabs auto-save every 30 seconds and on quit, so a crash never costs you your session.
- **Downloads manager** — per-workspace download list, progress events, open-in-folder, delete.
- **Browsing history & bookmarks** — per-workspace history with visit durations, bookmarks, notes.
- **Activity dashboard** — daily / weekly / all-time analytics, opt-out toggle.
- **Idle auto-close** — configurable timer that locks/closes the session after inactivity.
- **Login self-destruct** *(new in v1.1)* — enter the wrong password **3 times in a row** and AEGIS erases every trace of local data: accounts, history, bookmarks, downloads, cookies/localStorage (workspace partitions) **and the whole Chromium profile** — site permission grants, Local State, DIPS bounce-tracking records, ad interest groups. The failed-attempt counter is stored on disk in the main process, so restarting the app cannot reset it; only a successful login does. Profile files Windows refuses to delete while Chromium still holds them are queued in `pending-wipe.json` and removed at the next launch, before anything is opened. The login screen keeps showing what happened — even after a restart — until a new account is created. Afterwards it is fully usable again with a fresh, empty database.
- **Default browser integration** *(new in v1.1)* — registers a proper ProgId + `RegisteredApplications` capabilities entry so Windows Settings lists AEGIS; deep-links straight to its default-apps page. Links clicked anywhere in Windows open in a new AEGIS tab (cold start via `process.argv`, running instance via `second-instance`).
- **Network speed controls** *(new in v1.1)* — multi-connection parallel downloads, plus an opt-in **Secure DNS (DNS-over-HTTPS)** toggle in Settings.

## Requirements

Nothing on the target PC — both release formats bundle Node.js + Electron inside a single `.exe`.

## Building

```bash
npm install
npm start          # run from source
npm run release    # build AEGIS-Setup-<version>.exe + AEGIS-Portable-<version>.exe into dist\
```

Or double-click `Build Installer.bat`. Copy **either** single `.exe` to any Windows PC — do not copy the source folder or `node_modules`.

## Portable mode

AEGIS is portable-aware. It stores all user data (database, sessions, cookies) in a `data/` folder next to the app when:

- a `portable.dat` marker file sits next to the executable, or
- the `PORTABLE=1` environment variable is set, or
- a `data/` folder already exists next to the app.

Otherwise it uses the standard per-user `%APPDATA%` location.

## Settings

- **Profile** — photo, password change.
- **Default Browser** — shows live status (green when AEGIS owns `http`/`https`), one-button registration, opens Windows Settings to confirm. *Windows 10/11 protect the default-browser choice, so the final "Set default" click happens in Windows Settings — AEGIS takes you straight there.*
- **Network Speed** — **Secure DNS** toggle (DNS-over-HTTPS, default OFF, applied at next launch, persisted to `net-prefs.json` in the profile folder). Parallel downloading is always on.
- **Browsing History** — password-gated history viewer.
- **Idle auto-close** — enable/disable and set the timeout.

## Development

- `main.js` — main process: windows, `WebContentsView` tab management, SQLite persistence, IPC, OS integration.
- `preload.js` — `contextBridge` (exposed as `window.ghost`) — the only renderer→main surface.
- `login.html`, `workspace.html`, `controls.html`, `dashboard.html`, `settings.html`, `parameters.html`, `confirm-quit.html` — renderer pages.
- `audit.js` — static consistency check (JS/inline-script syntax, bridge-method coverage, IPC channel symmetry). Run with `node audit.js` before releasing.
- `test-wipe.js` — E2E test for the login self-destruct (36 checks). Copies the app into a temp sandbox with portable mode, drives the real login page over CDP through 4 phases (counter survives a restart → wipe → leftovers erased on the next launch → app reusable), and proves the project `data\` folder is never touched. Run with `node test-wipe.js`.

## License

Private / all rights reserved.
