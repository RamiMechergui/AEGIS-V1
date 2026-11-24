'use strict';
// shield.js — AEGIS Shield: the local privacy engine (main process).
//
// Three independent protections, all applied BEFORE anything leaves the
// machine:
//
//   1. Ad & tracker blocker — a domain trie loaded from the bundled
//      shield-list.txt (AEGIS's curated rules + full EasyList & EasyPrivacy,
//      with their licence headers preserved) plus an optional shield-custom.txt
//      in the profile folder, consulted from session.webRequest.onBeforeRequest
//      so matching requests are cancelled before the HTTP socket opens.
//      Supports the domain/path core of EasyList/AdGuard syntax: ||domain^,
//      ||domain/path^, bare domains, @@ exceptions and the $modifiers this
//      engine implements completely (third-party, resource types, domain=).
//      Any rule carrying a modifier that is NOT on that whitelist — badfilter,
//      removeparam, csp, replace, redirect, important, popup, method … — is
//      dropped whole instead of being applied with the modifier silently
//      ignored, because ignoring a modifier widens the rule beyond what the
//      list author wrote (that is how a bundled list over-blocks).
//
//   2. Tracking-parameter strip — utm_*, fbclid, gclid, msclkid, igshid … are
//      removed from every GET navigation (main frame + subframes) by
//      redirecting to the cleaned URL, so the tracker never sees the tag and
//      the URL recorded in history is already clean.
//
//   3. Fingerprint-randomizer bootstrap — fp-preload.js asks this module
//      (ipcRenderer.sendSync) whether the randomizer is enabled and which
//      per-run seed to use. The seed is regenerated on every AEGIS launch, so
//      farbled canvas/WebGL fingerprints change across sessions while staying
//      stable within one (see fp-preload.js for the noise model).
//
// This module never requires Electron — main.js passes the profile folder to
// init(), which keeps the engine testable with plain `node` (test-shield.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PREFS = { blockAds: true, fpRandomizer: true, stripParams: true };

// Used only when shield-list.txt cannot be read (packaging mistake): the five
// domains AEGIS has always blocked, so protection never silently regresses.
const BUILTIN_FALLBACK = [
  '||doubleclick.net^',
  '||google-analytics.com^',
  '||facebook.com/tr',
  '||twitter.com/i/ads',
  '||amazon-adsystem.com^',
];

// ── Tracking parameters removed from URLs ─────────────────────────────────────
// Exact keys (lowercase) + prefixes. Deliberately NOT stripped: functional
// words like ref/source/campaign/id, and _ga (used for GA4 session stitching
// some sites rely on for their own login flows).
const TRACKING_PARAMS = new Set([
  // ad click identifiers
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gcl_aw', 'gcl_au', 'gcl_gc',
  'wbraid', 'gbraid', 'msclkid', 'yclid', 'ysclid', 'ymclid', 'twclid',
  'ttclid', 'rdt_cid', 'igshid', 'li_fat_id', 'obcl',
  // email / marketing platform identifiers
  'mc_eid', 'mc_cid', 'mkt_tok', 'vero_id', 'vero_conv', 'wickedid',
  '_hsenc', '_hsmi', 'hsctatracking', 'wt.mc_id',
]);
const TRACKING_PREFIXES = [
  'utm_',   // Google Analytics campaign tags
  'mtm_',   // Matomo
  'pk_',    // Piwik
  'piwik_',
  'matomo_',
  'hsa_',   // HubSpot ads
  'oly_',   // Ometria
  'scm_',   // social campaign tags
  'itm_',   // App Store campaign tags
];

function isTrackingKey(key) {
  const k = String(key).toLowerCase();
  if (TRACKING_PARAMS.has(k)) return true;
  for (const p of TRACKING_PREFIXES) if (k.startsWith(p)) return true;
  return false;
}

// Returns the URL with every tracking parameter removed, or null when nothing
// was removed (or the URL is not http/https). Handles query strings and query
// strings embedded in the fragment (SPA routes like #/page?utm_source=x).
function stripTrackingParams(href) {
  let u;
  try { u = new URL(href); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let removed = false;
  if (u.search) {
    const keys = [];
    for (const k of u.searchParams.keys()) if (isTrackingKey(k)) keys.push(k);
    for (const k of keys) { u.searchParams.delete(k); removed = true; }
  }
  if (u.hash && u.hash.includes('?')) {
    const h = u.hash.slice(1);
    const qi = h.indexOf('?');
    const hq = new URLSearchParams(h.slice(qi + 1));
    let hRemoved = false;
    for (const k of [...hq.keys()]) if (isTrackingKey(k)) { hq.delete(k); hRemoved = true; }
    if (hRemoved) { u.hash = '#' + h.slice(0, qi + 1) + hq.toString(); removed = true; }
  }
  if (!removed) return null;
  const out = u.toString();
  return out === href ? null : out;
}

// ── Rule trie ────────────────────────────────────────────────────────────────
// Nodes are keyed by domain labels in REVERSE order (com → example → www), so
// a request host is walked right-to-left and every rule sitting on that path
// is a suffix match: ||example.com^ covers example.com AND a.b.example.com.
// Each terminal node holds a list of rules (block and/or @@allow), each with
// an optional path prefix and $modifiers.
const makeNode = () => ({ c: new Map(), r: null });
let root = makeNode();
let ruleCount = 0;        // bundled + fallback rules loaded
let customRuleCount = 0;  // rules from the user's shield-custom.txt
let skippedRules = 0;     // unsupported syntax or modifiers (cosmetic, regex, wildcards, $badfilter …)

// Electron resourceType strings per common Adblock Plus option name.
// Only options with EXACTLY this semantics live here: a name that appears in
// a list but is not a key below makes parseRuleLine drop the whole rule.
// Deliberately absent: $popup (this engine cannot tell a window.open()
// navigation from a typed one, so a $popup rule would block more than the
// list author asked for).
const TYPE_MAP = {
  script: ['script'],
  image: ['image'],
  stylesheet: ['stylesheet'],
  object: ['object'],
  subdocument: ['subFrame'], subframe: ['subFrame'],
  xmlhttprequest: ['xhr', 'fetch'], xhr: ['xhr', 'fetch'], fetch: ['xhr', 'fetch'],
  media: ['media'],
  font: ['font'],
  document: ['mainFrame'],
  websocket: ['webSocket'],
  ping: ['ping'],
  csp_report: ['cspReport'],
  other: ['other'],
};

// Every resource type a rule can be restricted to — the complement used to
// express a negated type ("$~script" = every type except script).
const ALL_ELECTRON_TYPES = new Set(Object.values(TYPE_MAP).flat());

// Parses one line of EasyList/AdGuard-style syntax into a rule + its domain.
// Returns null for comments, headers, cosmetic rules, anything the domain trie
// cannot express (path wildcards, regex, absolute |http:// rules …) and any
// rule carrying a $modifier this engine does not implement exactly — a rule
// is all-or-nothing, never "the rule minus the part we did not understand".
function parseRuleLine(rawLine) {
  let s = String(rawLine).trim();
  if (!s || s[0] === '!' || s[0] === '[' || s[0] === '#') return null;
  // Cosmetic / element-hiding / scriptlet rules — a request engine has no use
  // for them, and they must never be mistaken for network rules.
  if (s.includes('##') || s.includes('#@#') || s.includes('#?#') ||
      s.includes('#$#') || s.includes('#%#')) return null;

  let allow = false;
  if (s.startsWith('@@')) { allow = true; s = s.slice(2); }
  // Absolute rules like |https://host^ are unsupported (||domain^ is the form
  // this engine matches); a '://' anywhere else means such a rule.
  if (s.includes('://')) return null;

  // $options — everything after the last '$' is the option list, but only when
  // it looks like one (so a literal '$' inside a path is not eaten). A '$'
  // whose tail does NOT look like options — spaces, quotes, an empty tail —
  // makes the line invalid: guessing would either mangle the pattern into a
  // dead rule or silently swallow modifiers.
  let opts = '';
  const dollar = s.lastIndexOf('$');
  if (dollar > 0) {
    const tail = s.slice(dollar + 1);
    if (!tail || !/^[~a-z0-9_,=.|*-]+$/i.test(tail)) return null;
    opts = tail;
    s = s.slice(0, dollar);
  }
  s = s.replace(/\^+$/, '');   // trailing ^ separator ("end of host/path segment")
  if (!s) return null;

  let domain, urlPath = null;
  if (s.startsWith('||')) {
    const rest = s.slice(2);
    const slash = rest.indexOf('/');
    domain = slash >= 0 ? rest.slice(0, slash) : rest;
    if (slash >= 0) urlPath = rest.slice(slash);
  } else {
    // bare domain or domain/path line — user convenience in shield-custom.txt
    const m = s.match(/^([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(\/.*)?$/i);
    if (!m) return null; // path-only, regex, wildcard host … unsupported
    domain = m[1];
    if (m[2] && m[2] !== '/') urlPath = m[2];
  }
  domain = domain.toLowerCase().replace(/\.$/, '');
  if (!domain || domain.includes('*') || domain.includes('?') ||
      !domain.includes('.') || domain.startsWith('.')) return null;
  // The domain must be a plain hostname. Anything else ('^', spaces, unicode
  // that URL() would punycode …) would sit in the trie as a node no real host
  // can ever reach — dead rules are not protection, so reject them outright.
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain) || domain.includes('..')) return null;
  if (urlPath) {
    if (urlPath.includes('*') || urlPath.includes('?')) return null; // wildcard paths unsupported
    if (urlPath === '/') urlPath = null;
  }

  const rule = { allow, path: urlPath, party: 'any', types: null, dom: null };
  if (opts) {
    const posTypes = new Set();
    const negTypes = new Set();
    for (const raw of opts.split(',')) {
      let o = raw.trim().toLowerCase();
      if (!o) continue;
      let neg = false;
      if (o[0] === '~') { neg = true; o = o.slice(1); }
      if (o === 'third-party' || o === '3p') rule.party = neg ? '1p' : '3p';
      else if (o === 'first-party' || o === '1p') rule.party = neg ? '3p' : '1p';
      else if (o.startsWith('domain=')) {
        const list = o.slice(7).split('|').filter(Boolean);
        if (!list.length) return null; // "$domain=" with no domain is invalid — never widen it to "any initiator"
        rule.dom = rule.dom || { pos: [], neg: [] };
        for (let d of list) {
          let dneg = false;
          if (d[0] === '~') { dneg = true; d = d.slice(1); } // '~' is per entry
          d = d.toLowerCase();
          // Only plain host suffixes are expressible: a wildcard entry
          // ('*.foo.com') or junk would silently widen or narrow the rule.
          if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d) || d.includes('..')) return null;
          // XOR would be wrong here: the rule is positive only when BOTH the
          // option and the entry are un-negated (or both negated).
          (neg === dneg ? rule.dom.pos : rule.dom.neg).push(d);
        }
      } else if (o === 'match-case') {
        // Path matching here is already case-sensitive, so the rule applies
        // exactly as written — the modifier changes nothing we would get wrong.
      } else if (TYPE_MAP[o]) {
        (neg ? negTypes : posTypes).add(o);
      } else {
        // Unknown or deliberately unsupported modifier — badfilter, removeparam,
        // csp, replace, redirect, redirect-rule, important, popup, method=post,
        // generichide, elemhide … Drop the WHOLE rule. Applying it with the
        // modifier ignored is what turns a narrow list entry into an
        // over-block (or a blanket @@ allow), so a rule is all-or-nothing.
        return null;
      }
    }
    // Resource types: positives select, a negated type ("~script") excludes
    // from the full set — "every type except script" is expressible exactly.
    if (posTypes.size || negTypes.size) {
      const excluded = new Set();
      for (const k of negTypes) TYPE_MAP[k].forEach((t) => excluded.add(t));
      const set = new Set();
      if (posTypes.size) {
        for (const t of posTypes) TYPE_MAP[t].forEach((x) => { if (!excluded.has(x)) set.add(x); });
      } else {
        for (const t of ALL_ELECTRON_TYPES) if (!excluded.has(t)) set.add(t);
      }
      if (!set.size) return null; // contradictory ($script,~script): matches nothing
      rule.types = set;
    }
  }
  if (rule.dom && !rule.dom.pos.length && !rule.dom.neg.length) rule.dom = null;
  return { rule, domain };
}

function insertRule(rule, domain) {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return false; // never match at TLD level
  let node = root;
  for (let i = labels.length - 1; i >= 0; i--) {
    let next = node.c.get(labels[i]);
    if (!next) { next = makeNode(); node.c.set(labels[i], next); }
    node = next;
  }
  (node.r || (node.r = [])).push(rule);
  return true;
}

function loadListFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return 0; }
  let added = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '[') continue;
    let parsed = null;
    try { parsed = parseRuleLine(line); } catch (e) { parsed = null; }
    if (parsed && insertRule(parsed.rule, parsed.domain)) added++;
    else skippedRules++;
  }
  return added;
}

function loadBuiltinFallback() {
  for (const line of BUILTIN_FALLBACK) {
    try {
      const parsed = parseRuleLine(line);
      if (parsed) insertRule(parsed.rule, parsed.domain);
    } catch (e) { /* unreachable in practice */ }
  }
}

// Collects every rule whose domain is a suffix of host (TLD-first walk).
function findRules(host) {
  const labels = host.split('.').filter(Boolean);
  const out = [];
  let node = root;
  for (let i = labels.length - 1; i >= 0; i--) {
    node = node.c.get(labels[i]);
    if (!node) break;
    if (node.r) out.push(...node.r);
  }
  return out;
}

function pathMatches(rulePath, url) {
  if (!rulePath) return true;
  let target;
  try { const u = new URL(url); target = u.pathname + u.search; } catch (e) { return false; }
  if (!target.startsWith(rulePath)) return false;
  if (rulePath.endsWith('/')) return true;
  const next = target.charAt(rulePath.length);
  // ABP separator semantics: the rule must end at a boundary (end of string,
  // '/', '?', '&', '-', '_', '.' …) — '/tr' must not match '/tracking'.
  return next === '' || !/[A-Za-z0-9]/.test(next);
}

function isThirdParty(reqUrl, refUrl) {
  if (!refUrl) return false;
  let rh, fh;
  try { rh = new URL(reqUrl).hostname; } catch (e) { return false; }
  try { fh = new URL(refUrl).hostname; } catch (e) { return false; }
  rh = rh.toLowerCase().replace(/\.$/, '');
  fh = fh.toLowerCase().replace(/\.$/, '');
  if (!rh || !fh || rh === fh) return false;
  // Approximate eTLD+1 without shipping a public-suffix list: two hosts are
  // first-party when they share a 2+ label suffix (ads.example.org and
  // www.example.org are the same site; google.com and googlesyndication.com
  // are not). The co.uk-style edge under-matches, which errs toward not
  // blocking — the safe direction for $third-party rules.
  const rl = rh.split('.'), fl = fh.split('.');
  let i = rl.length - 1, j = fl.length - 1, common = 0;
  while (i >= 0 && j >= 0 && rl[i] === fl[j]) { common++; i--; j--; }
  return common < 2;
}

function domMatches(dom, refUrl) {
  if (!dom.pos.length && !dom.neg.length) return true;
  let fh = '';
  try { fh = new URL(refUrl).hostname.toLowerCase(); } catch (e) { fh = ''; }
  if (!fh) return dom.pos.length === 0; // no initiator → positive lists can't match
  const hit = (d) => fh === d || fh.endsWith('.' + d);
  if (dom.pos.length && !dom.pos.some(hit)) return false;
  if (dom.neg.length && dom.neg.some(hit)) return false;
  return true;
}

function ruleMatches(rule, details, url, thirdParty, ref) {
  if (rule.party === '3p' && !thirdParty) return false;
  if (rule.party === '1p' && thirdParty) return false;
  if (rule.types && !rule.types.has(details.resourceType)) return false;
  if (rule.dom && !domMatches(rule.dom, ref)) return false;
  if (rule.path && !pathMatches(rule.path, url)) return false;
  return true;
}

// Public so tests can assert matching without going through webRequest.
function shouldBlock(details) {
  if (!inited || !prefs.blockAds) return false;
  const url = details.url || '';
  if (!/^(https?|wss?):/i.test(url)) return false;
  let host;
  try { host = new URL(url).hostname; } catch (e) { return false; }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  const candidates = findRules(host);
  if (!candidates.length) return false;
  const ref = details.referrer || '';
  const thirdParty = isThirdParty(url, ref);
  let allow = false, block = false;
  for (const rule of candidates) {
    if (!ruleMatches(rule, details, url, thirdParty, ref)) continue;
    if (rule.allow) { allow = true; break; }  // @@exception wins outright
    block = true;
  }
  return block && !allow;
}

// ── State ────────────────────────────────────────────────────────────────────
let inited = false;
let profileDir = '';
let prefs = Object.assign({}, DEFAULT_PREFS);
let prefsPath = '';
let sessionKey = '';   // per-AEGIS-run seed for the fingerprint randomizer
const stats = { blocked: 0, stripped: 0, byDomain: new Map() };
// Redirect-loop guard: a server that keeps re-adding tracking tags must not
// bounce the user forever (same URL redirected at most 3× per 10 s).
const stripGuard = new Map();

function savePrefs() {
  try { fs.writeFileSync(prefsPath, JSON.stringify(prefs)); } catch (e) { /* read-only profile */ }
}

function init(dataDir) {
  profileDir = dataDir || '';
  prefsPath = path.join(profileDir, 'shield-prefs.json');
  try {
    prefs = Object.assign({}, DEFAULT_PREFS, JSON.parse(fs.readFileSync(prefsPath, 'utf8')));
  } catch (e) { prefs = Object.assign({}, DEFAULT_PREFS); }
  // New seed every launch: farbled fingerprints are stable while AEGIS runs,
  // unlinked from yesterday's session (Brave-style per-session farbling).
  sessionKey = crypto.randomBytes(16).toString('hex');
  root = makeNode();
  ruleCount = 0; customRuleCount = 0; skippedRules = 0;
  stats.blocked = 0; stats.stripped = 0; stats.byDomain.clear();
  stripGuard.clear();

  ruleCount = loadListFile(path.join(__dirname, 'shield-list.txt'));
  if (!ruleCount) loadBuiltinFallback(); // packaged list missing → never unprotected
  const customPath = path.join(profileDir, 'shield-custom.txt');
  if (profileDir && fs.existsSync(customPath)) customRuleCount = loadListFile(customPath);
  inited = true;
  return { rules: ruleCount, custom: customRuleCount, skipped: skippedRules };
}

function getPrefs() {
  return {
    blockAds: !!prefs.blockAds,
    fpRandomizer: !!prefs.fpRandomizer,
    stripParams: !!prefs.stripParams,
    customList: customRuleCount > 0,
  };
}

function setPrefs(p) {
  if (inited && p && typeof p === 'object') {
    if (typeof p.blockAds === 'boolean') prefs.blockAds = p.blockAds;
    if (typeof p.fpRandomizer === 'boolean') prefs.fpRandomizer = p.fpRandomizer;
    if (typeof p.stripParams === 'boolean') prefs.stripParams = p.stripParams;
    savePrefs();
  }
  return getPrefs();
}

function getStats() {
  const top = [...stats.byDomain.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([domain, count]) => ({ domain, count }));
  return {
    blocked: stats.blocked,
    stripped: stats.stripped,
    rules: ruleCount,
    customRules: customRuleCount,
    skipped: skippedRules,
    top,
  };
}

// sendSync payload for fp-preload.js (registered in main.js).
function fpBootstrap() {
  if (!inited || !prefs.fpRandomizer || !sessionKey) return { enabled: false, seed: '' };
  return { enabled: true, seed: sessionKey };
}

function canRedirectStrip(original) {
  const now = Date.now();
  let entry = stripGuard.get(original);
  if (!entry || now - entry.t > 10000) { entry = { n: 0, t: now }; stripGuard.set(original, entry); }
  if (entry.n >= 3) return false;
  entry.n++;
  if (stripGuard.size > 500) {
    for (const [k, v] of stripGuard) if (now - v.t > 10000) stripGuard.delete(k);
  }
  return true;
}

// The single entry point wired into session.webRequest.onBeforeRequest.
// Returns {} (continue), { cancel: true } or { redirectURL } — never throws,
// so a shield bug can never break navigation.
function handleRequest(details) {
  if (!inited) return {};
  try {
    if (shouldBlock(details)) {
      stats.blocked++;
      try {
        const host = new URL(details.url).hostname.toLowerCase();
        stats.byDomain.set(host, (stats.byDomain.get(host) || 0) + 1);
        if (stats.byDomain.size > 300) {
          const keep = [...stats.byDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150);
          stats.byDomain.clear();
          keep.forEach(([k, v]) => stats.byDomain.set(k, v));
        }
      } catch (e) { /* stats are best-effort */ }
      return { cancel: true };
    }
    if (prefs.stripParams && details.method === 'GET' &&
        (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')) {
      const cleaned = stripTrackingParams(details.url);
      if (cleaned && canRedirectStrip(details.url)) {
        stats.stripped++;
        return { redirectURL: cleaned };
      }
    }
  } catch (e) { /* never break a request because of the shield */ }
  return {};
}

module.exports = {
  init,
  getPrefs,
  setPrefs,
  getStats,
  fpBootstrap,
  handleRequest,
  shouldBlock,
  stripTrackingParams,
};
