// test-oauth.js — unit test for the OAuth popup recognition (oauth.js).
//
// Runs with plain `node test-oauth.js` (no Electron): oauth.js is a pure
// module, so the URL classification and the User-Agent rebuild are exercised
// directly. Proves the decisions main.js's window-open router depends on:
//
//   Phase A  isOAuthUrl(): identity-provider hosts (Google country variants,
//            Apple, Microsoft, Auth0/Okta tenants), protocol paths on any
//            host (/oauth/, /o/oauth2/, /authorize, /dialog/oauth, /v2/auth,
//            /login/oauth, OIDC), and /auth/… paths — but ONLY with protocol
//            evidence, so a plain /auth/login page still opens as a tab
//   Phase B  isOAuthUrl() negatives: ordinary sites, google.com search links,
//            github.com root, non-http schemes (javascript:/data:/mailto:)
//   Phase C  isBlankPopupUrl(): '' / about:blank popup placeholders
//   Phase D  standardUserAgent(): Electron + app-name tokens gone, real
//            Chromium version and OS string untouched; garbage input → ''
//   Phase E  the real chatgpt.com "Continue with Google" popup + callback URLs

const oauth = require('./oauth');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  [ OK ] ' + name);
  else { failures++; console.log('  [FAIL] ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
};

// ── Phase A: positive matches ────────────────────────────────────────────────
console.log('\n== Phase A: OAuth/SSO URLs are recognised ==');
const positives = [
  ['google popup', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com&response_type=code&state=abc'],
  ['google signin page', 'https://accounts.google.com/signin/oauth/identifier?client_id=123&state=abc'],
  ['google country variant', 'https://accounts.google.co.uk/o/oauth2/v2/auth?client_id=123&response_type=code'],
  ['google root popup', 'https://accounts.google.com/'],
  ['apple', 'https://appleid.apple.com/auth/authorize?client_id=com.openai.chat&response_type=code id_token'],
  ['microsoft', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&response_type=code'],
  ['openai auth host', 'https://auth.openai.com/api/accounts/callback/google?code=xyz&state=abc'],
  ['generic /oauth/ path', 'https://example.com/oauth/authorize?client_id=abc'],
  ['generic /oauth2/ path', 'https://sso.example.org/oauth2/auth?client_id=abc'],
  ['generic /authorize path', 'https://example.com/authorize?response_type=code&client_id=abc'],
  ['facebook dialog', 'https://www.facebook.com/v21.0/dialog/oauth?client_id=abc&response_type=code'],
  ['google v2/auth', 'https://example.com/v2/auth?client_id=abc&response_type=code'],
  ['github oauth path', 'https://github.com/login/oauth/authorize?client_id=abc&state=xyz'],
  ['oidc path', 'https://idp.example.com/protocol/openid-connect/auth?client_id=abc&state=xyz'],
  ['chatgpt auth callback', 'https://chatgpt.com/backend/auth/google/callback?code=xyz&state=abc'],
  ['chatgpt auth initiator', 'https://chatgpt.com/backend/auth/google?state=abc&client_id=abc'],
  ['/auth/ path with code', 'https://app.example.com/auth/callback?code=xyz'],
];
for (const [name, url] of positives) check(name + ' -> OAuth', oauth.isOAuthUrl(url) === true, url);

// ── Phase B: negatives ───────────────────────────────────────────────────────
console.log('\n== Phase B: ordinary windows stay ordinary tabs ==');
const negatives = [
  ['plain https link', 'https://example.com/pricing'],
  ['google search result', 'https://www.google.com/search?q=aegis+browser'],
  ['google accounts settings link', 'https://myaccount.google.com/security'],
  ['github repo', 'https://github.com/electron/electron'],
  ['plain /auth/login page (no protocol params)', 'https://example.com/auth/login'],
  ['plain /signin page', 'https://example.com/signin'],
  ['javascript: scheme', 'javascript:alert(1)'],
  ['data: scheme', 'data:text/html,<h1>x</h1>'],
  ['mailto', 'mailto:user@example.com'],
  ['about:random', 'about:random'],
  ['not a url at all', 'definitely not a url'],
];
for (const [name, url] of negatives) check(name + ' -> not OAuth', oauth.isOAuthUrl(url) === false, url);

// ── Phase C: blank placeholder popups ────────────────────────────────────────
console.log('\n== Phase C: blank popup placeholders (site will navigate it) ==');
check('empty string', oauth.isBlankPopupUrl('') === true);
check('undefined', oauth.isBlankPopupUrl(undefined) === true);
check('about:blank', oauth.isBlankPopupUrl('about:blank') === true);
check('about:blank#blocked', oauth.isBlankPopupUrl('about:blank#blocked') === true);
check('whitespace about:blank', oauth.isBlankPopupUrl('  about:blank  ') === true);
check('real url is not blank', oauth.isBlankPopupUrl('https://example.com') === false);
check('oauth url is not blank', oauth.isBlankPopupUrl('https://accounts.google.com/o/oauth2/auth') === false);

// ── Phase D: User-Agent rebuild ──────────────────────────────────────────────
console.log('\n== Phase D: standardUserAgent() strips Electron/app tokens ==');
const ELECTRON_UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) aegis/1.0.0 Chrome/134.0.6998.0 Electron/35.0.0 Safari/537.36';
const ELECTRON_UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AEGIS/1.0.0 Chrome/134.0.6998.0 Electron/35.0.0 Safari/537.36';
const uaWin = oauth.standardUserAgent(ELECTRON_UA_WIN, 'aegis');
const uaMac = oauth.standardUserAgent(ELECTRON_UA_MAC, 'AEGIS');
check('windows UA keeps OS + Chromium version', uaWin.includes('Windows NT 10.0; Win64; x64') && uaWin.includes('Chrome/134.0.6998.0'), uaWin);
check('windows UA has no Electron token', !/electron/i.test(uaWin), uaWin);
check('windows UA has no app-name token', !/aegis/i.test(uaWin), uaWin);
check('windows UA keeps AppleWebKit/Safari tokens', uaWin.includes('AppleWebKit/537.36') && uaWin.includes('Safari/537.36'), uaWin);
check('windows UA starts like Chrome', uaWin.startsWith('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'), uaWin);
check('mac UA keeps OS + Chromium version', uaMac.includes('Macintosh; Intel Mac OS X 10_15_7') && uaMac.includes('Chrome/134.0.6998.0'), uaMac);
check('mac UA has no Electron/app token', !/electron|aegis/i.test(uaMac), uaMac);
check('already-clean UA is left alone', oauth.standardUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36', 'aegis') === 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
check('garbage input returns empty (caller falls back)', oauth.standardUserAgent('nonsense', 'aegis') === '', oauth.standardUserAgent('nonsense', 'aegis'));
check('empty input returns empty', oauth.standardUserAgent('', 'aegis') === '');

// ── Phase E: the real chatgpt.com flow ───────────────────────────────────────
console.log('\n== Phase E: chatgpt.com "Continue with Google" ==');
const popupUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=607850412947-5qt3q4pv4p3q3q3q3q3q3q3q3q3q3q.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fbackend%2Fauth%2Fgoogle%2Fcallback&response_type=code&scope=openid%20email%20profile&state=xyz123&prompt=select_account';
check('login button popup is OAuth', oauth.isOAuthUrl(popupUrl) === true);
check('…and not a blank placeholder', oauth.isBlankPopupUrl(popupUrl) === false);
check('Google hands the code back on the RP origin', oauth.isOAuthUrl('https://chatgpt.com/backend/auth/google/callback?code=4%2F0AeanS&state=xyz123') === true);

// ── Phase F: explicit popup-size requests ────────────────────────────────────
console.log('\n== Phase F: window.open() with popup features asks for a WINDOW ==');
check('popup,width=520,height=720 -> window request', oauth.isPopupWindowRequest('popup,width=520,height=720') === true);
check('…including the noopener suffix ChatGPT/OpenAI use', oauth.isPopupWindowRequest('popup,width=520,height=720,noopener,noreferrer') === true);
check('plain width/height -> window request', oauth.isPopupWindowRequest('width=500,height=600') === true);
check('position-only -> window request', oauth.isPopupWindowRequest('left=120,top=80') === true);
check('max-/min- sizing -> window request', oauth.isPopupWindowRequest('min-width=380,min-height=480') === true);
check('comma-space separators -> window request', oauth.isPopupWindowRequest('width=420, height=640') === true);
check('empty features -> not a window request', oauth.isPopupWindowRequest('') === false);
check('undefined features -> not a window request', oauth.isPopupWindowRequest(undefined) === false);
check('noopener,noreferrer alone keeps the TAB behaviour', oauth.isPopupWindowRequest('noopener,noreferrer') === false);
check('rel=noopener string alone is not a size', oauth.isPopupWindowRequest('noopener') === false);
check('a plain "open in new tab" call is untouched', oauth.isPopupWindowRequest('_blank') === false);

console.log('\n== RESULT: ' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED') + ' ==');
process.exit(failures ? 1 : 0);
