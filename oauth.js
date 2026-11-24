'use strict';
// oauth.js — OAuth/SSO popup recognition + the standard browser User-Agent.
//
// Pure module: no Electron, no DOM. required by main.js and unit-tested by
// test-oauth.js with plain `node test-oauth.js` (the same pattern as shield.js).
//
// Why this exists: AEGIS intercepts every window.open() (setWindowOpenHandler).
// Turning an identity-provider popup into an ordinary tab DROPS window.opener,
// so the callback page can never postMessage() the result back to the tab that
// started the login, the site never learns the login finished, and it
// re-triggers itself — the infinite "Continue with Google" loop.
//
// main.js therefore routes everything recognised by isOAuthUrl() /
// isBlankPopupUrl() through the LINKED-POPUP path: a real child window that
// keeps window.opener alive, inherits the opener's webPreferences verbatim
// (i.e. the exact same session partition, cookies and localStorage) and is
// closed automatically when it comes back to the origin that opened it.
// Everything else keeps the old "open in a new tab" behaviour.

// ── Identity-provider hosts ───────────────────────────────────────────────────
// A window.open() to one of these hosts is ALWAYS part of a login: the hosts
// below have no other reason to be popped up. `accounts.google.` also covers
// the country variants (accounts.google.co.uk, accounts.google.com.br, …).
const IDP_HOST_RE = /^(accounts\.google\.[a-z]{2,3}(\.[a-z]{2})?|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|account\.live\.com|auth\.openai\.com|auth\.discord\.com|accounts\.yahoo\.com|login\.yahoo\.com|[^.]+\.auth0\.com|auth0\.com|[^.]+\.amazoncognito\.com|[^.]+\.okta\.com|[^.]+\.oktapreview\.com)$/i;

// ── Authorization endpoints on any host ───────────────────────────────────────
// Path segments that name the protocol itself (/oauth/, /o/oauth2/,
// /authorize, Google's /v2/auth, Facebook's /dialog/oauth, OIDC …). These are
// unambiguous, so no query string is required.
const OAUTH_PATH_RE = /(^|\/)(oauth2?|authorize|v2\/auth|dialog\/oauth|i\/oauth2|login\/oauth2?|signin\/oauth|openid-connect\/auth|oidc\/authorize)(\/|$)/i;

// Generic /auth/… style paths — the spec's second example class. A bare
// /auth/login page opened by a link is not necessarily a handshake, so these
// only count together with protocol evidence below (or with a sub-path that
// names the provider/protocol: /auth/callback, /auth/google, /auth/oidc …).
const AUTH_PATH_RE = /(^|\/)auth(\/|$)/i;
const AUTH_SUBPATH_RE = /(^|\/)(callback|oauth2?|oidc|sso|authorize|google|apple|microsoft|github|facebook|twitter|linkedin|discord)(\/|$)/i;

// OAuth 2.0 / OIDC protocol parameters. `code`/`state`/`iss` are what a
// redirect_uri carries back, the rest is what the authorization request itself
// is built from.
const OAUTH_QUERY_RE = /[?&](client_id|response_type|code_challenge|code_challenge_method|request_uri|id_token_hint|access_type|nonce|state|code|iss|session_state)=/i;

function parseHttp(raw) {
  try {
    const u = new URL(String(raw));
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
  } catch (e) { return null; }
}

// True when opening `raw` in a new window would run an identity handshake
// (Google / Apple / Microsoft / generic OAuth2 or OIDC authorize endpoint).
function isOAuthUrl(raw) {
  const u = parseHttp(raw);
  if (!u) return false;
  if (IDP_HOST_RE.test(u.hostname)) return true;
  if (OAUTH_PATH_RE.test(u.pathname)) return true;
  if (AUTH_PATH_RE.test(u.pathname) &&
      (OAUTH_QUERY_RE.test(u.search) || AUTH_SUBPATH_RE.test(u.pathname))) return true;
  return false;
}

// True when the page asked for a placeholder window it will navigate itself
// (`window.open('')` / `window.open('about:blank')` — the classic OAuth popup
// preamble, where the site sets `popup.location = authUrl` afterwards). Such a
// call MUST return a real window, not null, or the follow-up assignment throws.
function isBlankPopupUrl(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return s === '' || s === 'about:blank' || s === 'about:blank#blocked';
}

// True when window.open() was called with popup-shaped `features` — i.e. the
// page explicitly asked for a WINDOW (size and/or position), not for a tab.
//   window.open(url, '', 'popup,width=520,height=720')
//   window.open(url, '', 'width=500,height=600,left=120,top=80')
//
// Such a call MUST be answered with a real window. Returning null here makes
// any site that checks the result report "popup blocked" — which is exactly
// what ChatGPT shows as "We couldn't open the sign-in window. Check your popup
// blocker and try again."
//
// Deliberately does NOT match `noopener,noreferrer` on its own: that is the
// "open in a new tab" idiom, and it must keep AEGIS's tab behaviour (Chromium
// returns null for it as well, so sites do not inspect the result).
const POPUP_FEATURE_RE = /(^|[\s,])(width|height|min-width|min-height|max-width|max-height|left|top|popup)(\s*=|[\s,]|$)/i;
function isPopupWindowRequest(features) {
  const f = String(features == null ? '' : features).trim();
  if (!f) return false;
  return POPUP_FEATURE_RE.test(f);
}

// Rebuilds a plain Chrome user agent out of Electron's default one.
//
// Electron's default UA advertises the application name and the Electron token
// ("aegis/1.0.0 … Electron/35.x.x"), which Google's sign-in endpoint refuses
// with "This browser or app may not be secure" — a silent OAuth rejection that
// looks exactly like a login loop. Stripping those two tokens keeps everything
// else (OS, architecture, real Chromium version) byte-identical to Chrome, so
// the string stays accurate across Electron upgrades.
//
// Returns '' when the input does not look like an Electron UA, so the caller
// can fall back to a constructed string instead of shipping a broken one.
function standardUserAgent(base, appName) {
  let ua = String(base || '');
  if (appName) {
    const esc = String(appName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ua = ua.replace(new RegExp('\\s+' + esc + '/\\S+', 'gi'), ' ');
  }
  ua = ua.replace(/\s*Electron\/\S+/gi, ' ');          // drop the Electron token
  ua = ua.replace(/\s*\S+\/\S+\s+Chrome\//i, ' Chrome/'); // drop "<app>/<ver>" before Chrome/
  ua = ua.replace(/\s+/g, ' ').trim();
  return /Chrome\/[\d.]+/.test(ua) ? ua : '';
}

module.exports = { isOAuthUrl, isBlankPopupUrl, isPopupWindowRequest, standardUserAgent };
