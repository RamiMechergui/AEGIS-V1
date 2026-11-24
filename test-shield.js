// test-shield.js — unit test for the Aegis Shield engine (shield.js).
//
// Runs with plain `node test-shield.js` (no Electron): shield.js has no
// Electron dependency, so the domain trie, the request decisions and the
// tracking-parameter strip are all exercised directly against a throwaway
// profile folder in the system temp dir. The project's data\ folder is never
// touched.
//
// What is being proven:
//   Phase A  init() loads the bundled list (+ an optional custom list), and a
//            TLD-only rule can never be inserted
//   Phase B  blocking: domains, subdomains, path rules with ABP boundary
//            semantics (/tr blocks /tr and /tr.js but NOT /tracking), and
//            plain sites staying untouched
//   Phase C  $modifiers: $third-party, $resource-type, $domain=, and @@allow
//            exceptions winning over block rules
//   Phase D  handleRequest(): cancel before the socket opens, GET main-frame
//            navigations redirected to the cleaned URL, POST/subresource left
//            alone, redirect-loop guard
//   Phase E  stripTrackingParams(): utm_*/fbclid/gclid out, functional params
//            kept, case-insensitive keys, hash-query cleaning, non-http left
//            alone
//   Phase F  prefs persist across init(), fpBootstrap() seed changes per run

const fs = require('fs');
const os = require('os');
const path = require('path');

const shield = require('./shield');

const TMP = path.join(os.tmpdir(), 'opencode', 'aegis-shield-test-' + process.pid);
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  [ OK ] ' + name);
  else { failures++; console.log('  [FAIL] ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
};

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

// ── Phase A: init + list loading ─────────────────────────────────────────────
console.log('\n== Phase A: init + rule loading ==');
rmrf(TMP);
fs.mkdirSync(TMP, { recursive: true });
// Custom rules: a blocked domain with an allowed subdomain, a $third-party
// rule, a $script-only rule, a $domain= rule, and a TLD-only rule that must
// be rejected.
fs.writeFileSync(path.join(TMP, 'shield-custom.txt'), [
  '! custom test rules',
  '||tracker.test^',
  '@@||cdn.tracker.test^',
  '||ads.example.org^$third-party',
  '||example.net^$script',
  '||beacon.example^$domain=foo.com',
  '||com^', // TLD-only: must be rejected, never inserted
  '##.cosmetic-rule', // cosmetic: must be skipped, not inserted
].join('\n'));

const loaded = shield.init(TMP);
check('bundled list loaded (' + loaded.rules + ' rules)', loaded.rules >= 100, loaded.rules);
check('custom list loaded (5 real rules)', loaded.custom === 5, loaded.custom);
check('TLD-only + cosmetic rules skipped', loaded.skipped >= 2, loaded.skipped);
check('fpBootstrap reports enabled with a seed',
  shield.fpBootstrap().enabled === true && shield.fpBootstrap().seed.length >= 16,
  JSON.stringify(shield.fpBootstrap()));

// ── Phase B: blocking basics ─────────────────────────────────────────────────
console.log('\n== Phase B: blocking ==');
const req = (url, referrer, resourceType, method) =>
  ({ url, referrer: referrer || '', resourceType: resourceType || 'mainFrame', method: method || 'GET' });

check('googlesyndication subdomain blocked',
  shield.shouldBlock(req('https://pagead2.googlesyndication.com/pagead/js/ads.js', 'https://news.example.com/')));
check('google-analytics blocked',
  shield.shouldBlock(req('https://www.google-analytics.com/analytics.js', 'https://news.example.com/', 'script')));
check('doubleclick deep subdomain blocked',
  shield.shouldBlock(req('https://a.b.doubleclick.net/x', 'https://news.example.com/', 'xhr')));
check('facebook /tr pixel blocked',
  shield.shouldBlock(req('https://www.facebook.com/tr/?id=42', 'https://news.example.com/', 'image')));
check('facebook /tr (no slash, query) blocked',
  shield.shouldBlock(req('https://www.facebook.com/tr?id=42', 'https://news.example.com/', 'image')));
check('facebook /tr.js (separator) blocked',
  shield.shouldBlock(req('https://www.facebook.com/tr.js', 'https://news.example.com/', 'script')));
check('facebook /tracking NOT blocked (boundary)',
  !shield.shouldBlock(req('https://www.facebook.com/tracking?id=1', 'https://news.example.com/')));
check('facebook /login NOT blocked',
  !shield.shouldBlock(req('https://www.facebook.com/login', 'https://news.example.com/')));
check('twitter ads path blocked',
  shield.shouldBlock(req('https://twitter.com/i/ads', 'https://news.example.com/')));
check('ordinary site NOT blocked',
  !shield.shouldBlock(req('https://cdn.example.com/lib.js', 'https://news.example.com/', 'script')));
check('ordinary site main page NOT blocked',
  !shield.shouldBlock(req('https://www.example.com/article', 'https://news.example.com/')));
check('custom tracker.test blocked',
  shield.shouldBlock(req('https://tracker.test/pixel.gif', 'https://news.example.com/', 'image')));

// ── Phase C: $modifiers + exceptions ─────────────────────────────────────────
console.log('\n== Phase C: modifiers & exceptions ==');
check('@@ exception allows cdn.tracker.test',
  !shield.shouldBlock(req('https://cdn.tracker.test/asset.js', 'https://news.example.com/', 'script')));
check('$third-party blocks cross-site',
  shield.shouldBlock(req('https://ads.example.org/beacon', 'https://other-site.com/page', 'image')));
check('$third-party allows same-site',
  !shield.shouldBlock(req('https://ads.example.org/beacon', 'https://ads.example.org/page', 'image')));
check('$third-party treats subdomain-of-referrer as first party',
  !shield.shouldBlock(req('https://ads.example.org/beacon', 'https://www.example.org/page', 'image')));
check('$script matches script requests',
  shield.shouldBlock(req('https://example.net/tag.js', 'https://news.example.com/', 'script')));
check('$script ignores image requests',
  !shield.shouldBlock(req('https://example.net/pic.png', 'https://news.example.com/', 'image')));
check('$domain= matches the listed initiator',
  shield.shouldBlock(req('https://beacon.example/p', 'https://foo.com/x', 'image')));
check('$domain= ignores other initiators',
  !shield.shouldBlock(req('https://beacon.example/p', 'https://bar.com/x', 'image')));

// ── Phase D: handleRequest decisions ─────────────────────────────────────────
console.log('\n== Phase D: handleRequest ==');
const before = shield.getStats();
let r = shield.handleRequest(req('https://pagead2.googlesyndication.com/x.js', 'https://news.example.com/', 'script'));
check('blocked request → { cancel: true }', r && r.cancel === true, JSON.stringify(r));

r = shield.handleRequest(req('https://shop.example.com/item?id=5&utm_source=nl&utm_medium=email&fbclid=abc',
  'https://mail.example.com/', 'mainFrame'));
check('GET navigation redirected to cleaned URL',
  r && r.redirectURL === 'https://shop.example.com/item?id=5', JSON.stringify(r));

r = shield.handleRequest(req('https://shop.example.com/item?id=5&utm_source=nl', 'https://mail.example.com/', 'mainFrame', 'POST'));
check('POST is never redirected', r && !r.redirectURL, JSON.stringify(r));

r = shield.handleRequest(req('https://cdn.example.com/lib.js?utm_source=x', 'https://news.example.com/', 'script'));
check('subresource requests are not redirected', r && !r.redirectURL, JSON.stringify(r));

r = shield.handleRequest(req('https://news.example.com/article', 'https://mail.example.com/', 'mainFrame'));
check('plain navigation without tags untouched', r && !r.redirectURL && !r.cancel, JSON.stringify(r));

// redirect-loop guard: same original URL redirected at most 3× / 10 s
const loopUrl = 'https://loop.example.com/?utm_source=x';
let redirected = 0;
for (let i = 0; i < 4; i++) {
  const rr = shield.handleRequest(req(loopUrl, 'https://mail.example.com/', 'mainFrame'));
  if (rr && rr.redirectURL) redirected++;
}
check('redirect-loop guard stops after 3 redirects', redirected === 3, redirected);

const after = shield.getStats();
check('stats count blocks (' + after.blocked + ')', after.blocked === before.blocked + 1, after.blocked + ' vs ' + before.blocked);
check('stats count strips (' + after.stripped + ')', after.stripped >= before.stripped + 4, after.stripped + ' vs ' + before.stripped);
check('stats expose a top-blocked domain', after.top.length > 0 && after.top[0].domain.includes('googlesyndication'),
  JSON.stringify(after.top[0]));
check('stats expose rule counts', after.rules >= 100 && after.customRules === 5,
  JSON.stringify({ rules: after.rules, customRules: after.customRules }));

// ── Phase E: stripTrackingParams ─────────────────────────────────────────────
console.log('\n== Phase E: stripTrackingParams ==');
const strip = shield.stripTrackingParams;
check('utm + fbclid removed, functional params kept',
  strip('https://shop.example.com/p?id=5&utm_source=nl&utm_medium=email&fbclid=abc&size=xl') ===
  'https://shop.example.com/p?id=5&size=xl',
  strip('https://shop.example.com/p?id=5&utm_source=nl&utm_medium=email&fbclid=abc&size=xl'));
check('gclid + msclkid removed',
  strip('https://a.example.com/?gclid=123&msclkid=456&q=hello') === 'https://a.example.com/?q=hello',
  strip('https://a.example.com/?gclid=123&msclkid=456&q=hello'));
check('keys matched case-insensitively',
  strip('https://a.example.com/?UTM_SOURCE=x&id=1') === 'https://a.example.com/?id=1',
  strip('https://a.example.com/?UTM_SOURCE=x&id=1'));
check('no tracking params → null', strip('https://a.example.com/article?ref=home&page=2') === null);
check('clean URL unchanged → null', strip('https://a.example.com/article') === null);
check('SPA hash query cleaned',
  strip('https://app.example.com/#/route?utm_source=x&page=2') === 'https://app.example.com/#/route?page=2',
  strip('https://app.example.com/#/route?utm_source=x&page=2'));
check('hash without query untouched', strip('https://app.example.com/#section') === null);
check('non-http schemes untouched', strip('file:///C:/x?utm_source=1') === null);
check('garbage input → null', strip('not a url') === null);
check('igshid + ttclid + li_fat_id removed',
  strip('https://a.example.com/?igsh=1&igshid=abc&ttclid=1&li_fat_id=2') === 'https://a.example.com/?igsh=1',
  strip('https://a.example.com/?igsh=1&igshid=abc&ttclid=1&li_fat_id=2'));

// ── Phase F: prefs persistence + per-run seed ────────────────────────────────
console.log('\n== Phase F: prefs & seed ==');
shield.setPrefs({ blockAds: false, stripParams: false, fpRandomizer: false });
check('blockAds off → nothing blocks', !shield.shouldBlock(req('https://doubleclick.net/x')));
check('stripParams off → no redirect',
  !shield.handleRequest(req('https://a.example.com/?utm_source=x', 'https://b.example.com/', 'mainFrame')).redirectURL);
check('fpBootstrap disabled when toggle is off', shield.fpBootstrap().enabled === false);

const prefsOnDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'shield-prefs.json'), 'utf8'));
check('prefs persisted to shield-prefs.json',
  prefsOnDisk.blockAds === false && prefsOnDisk.stripParams === false && prefsOnDisk.fpRandomizer === false,
  JSON.stringify(prefsOnDisk));

const seed1 = shield.fpBootstrap().seed;
shield.init(TMP); // simulate a restart
const prefsAfter = shield.getPrefs();
check('prefs restored on restart (still off)',
  prefsAfter.blockAds === false && prefsAfter.stripParams === false && prefsAfter.fpRandomizer === false,
  JSON.stringify(prefsAfter));
const seed2 = shield.fpBootstrap().seed;
check('re-init keeps prefs off and withholds the seed', !seed1 && seed2 === '', JSON.stringify({ seed1, seed2 }));
shield.setPrefs({ fpRandomizer: true });
const seed3 = shield.fpBootstrap().seed;
check('fpBootstrap seed is stable while running', shield.fpBootstrap().seed === seed3 && seed3.length >= 16, seed3);
shield.init(TMP);
check('fpBootstrap seed changes on every run', shield.fpBootstrap().seed !== seed3,
  shield.fpBootstrap().seed + ' vs ' + seed3);
shield.setPrefs({ blockAds: true, stripParams: true });

// ── Cleanup ──────────────────────────────────────────────────────────────────
rmrf(TMP);
console.log('\n== RESULT: ' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED') + ' ==');
process.exit(failures ? 1 : 0);
