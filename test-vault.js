// test-vault.js — unit suite for the at-rest vault (vault.js) + a static audit
// of how main.js uses it.
//
// Runs with plain `node test-vault.js` (no Electron): vault.js is pure crypto —
// no Electron, no fs, no better-sqlite3 — so every key, ciphertext and tamper
// case is exercised directly. The project's data\ folder is never touched.
//
// What is being proven:
//   Phase A  value format: AEG1: prefix, round trip, fresh IV per encryption,
//            isEncrypted(), unicode, empty values
//   Phase B  AES-GCM authentication: wrong table, wrong column, wrong account,
//            wrong workspace, bit-flipped ciphertext and truncation all fail
//            instead of decrypting
//   Phase C  envelope keystore: create → unlock, wrong password / wrong
//            account / tampered row all refused, KDF iteration bounds, re-wrap
//            on password change keeps the same data key
//   Phase D  hygiene: zeroize, non-buffer key rejection, module purity
//   Phase E  SQL audit of main.js: no WHERE / GROUP BY / ORDER BY / JOIN / LIKE
//            may ever touch an encrypted column, and no index may be built on
//            one — the moment a column becomes ciphertext, SQL must stop
//            comparing it.
//   Phase F  wiring: every table is encrypted AND decrypted through the row
//            helpers, key lifecycle hooks exist (login / logout / guest / wipe /
//            quit / re-key), secure_delete + VACUUM are in place, and the
//            clipboard auto-wipe is reachable from Settings.

const fs = require('fs');
const path = require('path');

const vault = require('./vault');

const SRC = __dirname;
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  [ OK ] ' + name);
  else { failures++; console.log('  [FAIL] ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
};
const throws = (fn) => { try { fn(); return false; } catch (e) { return e; } };

// ── Phase A: value format ────────────────────────────────────────────────────
console.log('\n== Phase A: value format ==');
const dek = vault.createKeystore('correct horse', 'alice').dek;
const AAD = vault.aadFor('notes', 'content', 'alice', 'default');

check('AAD format is AEG1|table|column|user|scope',
  AAD === 'AEG1|notes|content|alice|default', AAD);
check('aadFor() maps null scope to empty string',
  vault.aadFor('page_visits', 'url', 'alice', null) === 'AEG1|page_visits|url|alice|');

const ct = vault.encrypt(dek, 'my secret note', AAD);
check('ciphertext carries the AEG1: prefix', ct.indexOf('AEG1:') === 0, ct.slice(0, 12));
check('prefix reported by isEncrypted()', vault.isEncrypted(ct) === true);
check('plaintext is not reported as encrypted', vault.isEncrypted('my secret note') === false);
check('null/undefined are not "encrypted"', vault.isEncrypted(null) === false && vault.isEncrypted(undefined) === false);
check('round trip returns the exact string', vault.decrypt(dek, ct, AAD) === 'my secret note', vault.decrypt(dek, ct, AAD));
check('unicode round trip (emoji + RTL)',
  vault.decrypt(dek, vault.encrypt(dek, 'héllo — مرحبا 🌙', AAD), AAD) === 'héllo — مرحبا 🌙');
check('empty string round trip',
  vault.decrypt(dek, vault.encrypt(dek, '', AAD), AAD) === '');
check('two encryptions of the same text differ (fresh IV)',
  vault.encrypt(dek, 'same', AAD) !== vault.encrypt(dek, 'same', AAD));
check('ciphertext is strictly larger than plaintext (iv+tag overhead)',
  ct.length > 'my secret note'.length + 20, ct.length);
check('ciphertext body is base64 (no raw bytes in the string)',
  /^[A-Za-z0-9+/]+=*$/.test(ct.slice('AEG1:'.length)), ct.slice(0, 40));

// ── Phase B: authentication (AAD binding + tamper) ───────────────────────────
console.log('\n== Phase B: AES-GCM authentication ==');
const why = (fn) => { const e = throws(fn); return e && /vault:/.test(e.message); };

check('wrong table rejected',
  why(() => vault.decrypt(dek, ct, vault.aadFor('bookmarks', 'content', 'alice', 'default'))));
check('wrong column rejected',
  why(() => vault.decrypt(dek, ct, vault.aadFor('notes', 'updated', 'alice', 'default'))));
check('wrong account rejected',
  why(() => vault.decrypt(dek, ct, vault.aadFor('notes', 'content', 'bob', 'default'))));
check('wrong workspace (scope) rejected',
  why(() => vault.decrypt(dek, ct, vault.aadFor('notes', 'content', 'alice', 'work'))));
check('wrong key rejected',
  why(() => vault.decrypt(vault.createKeystore('x', 'alice').dek, ct, AAD)));

// Flip one bit of the ciphertext body.
const body = ct.slice('AEG1:'.length);
const buf = Buffer.from(body, 'base64');
buf[buf.length - 1] ^= 0x01;
const flipped = 'AEG1:' + buf.toString('base64');
check('bit-flipped ciphertext rejected', why(() => vault.decrypt(dek, flipped, AAD)));

const truncated = 'AEG1:' + Buffer.from(body, 'base64').subarray(0, 10).toString('base64');
check('truncated ciphertext rejected', why(() => vault.decrypt(dek, truncated, AAD)));
check('plaintext passed to decrypt() rejected', why(() => vault.decrypt(dek, 'plain text', AAD)));
check('decrypt() of a string without the prefix rejected',
  why(() => vault.decrypt(dek, 'eyA1OjJ9', AAD)));

// ── Phase C: envelope keystore ───────────────────────────────────────────────
console.log('\n== Phase C: keystore envelope ==');
const ks = vault.createKeystore('pw-one', 'alice');
check('keystore row has salt / iterations / wrapped',
  typeof ks.salt === 'string' && ks.salt.length === vault.SALT_LEN * 2 &&
  ks.iterations === vault.KDF_ITERATIONS && typeof ks.wrapped === 'string',
  JSON.stringify({ salt: ks.salt, iterations: ks.iterations }));
check('createKeystore returns the DEK as a 32-byte buffer',
  Buffer.isBuffer(ks.dek) && ks.dek.length === vault.KEY_LEN, ks.dek.length);

const row = { salt: ks.salt, iterations: ks.iterations, wrapped_key: ks.wrapped };
const unwrapped = vault.unlockKeystore('pw-one', 'alice', row);
check('unlock returns the same 32 bytes',
  Buffer.isBuffer(unwrapped) && unwrapped.equals(ks.dek));
check('wrong password refused', why(() => vault.unlockKeystore('pw-two', 'alice', row)));
check('wrong account refused (wrap is bound to the pseudonym)',
  why(() => vault.unlockKeystore('pw-one', 'bob', row)));
check('missing keystore row refused', why(() => vault.unlockKeystore('pw-one', 'alice', null)));

const tamperedRow = Object.assign({}, row, { wrapped_key: ks.wrapped.slice(0, -2) + (ks.wrapped.slice(-2) === 'AA' ? 'BB' : 'AA') });
check('tampered wrapped key refused', why(() => vault.unlockKeystore('pw-one', 'alice', tamperedRow)));
const resaltedRow = Object.assign({}, row, { salt: 'ff'.repeat(vault.SALT_LEN) });
check('tampered salt refused (KDF output changes)', why(() => vault.unlockKeystore('pw-one', 'alice', resaltedRow)));

// KDF cost is stored per row and bounded: a tampered row may neither cheapen
// login's KDF nor turn it into a hang.
check('iterations below the floor refused',
  why(() => vault.unlockKeystore('pw-one', 'alice', Object.assign({}, row, { iterations: 50 }))));
check('absurd iteration count refused',
  why(() => vault.unlockKeystore('pw-one', 'alice', Object.assign({}, row, { iterations: 1e9 }))));
check('non-integer iterations refused',
  why(() => vault.unlockKeystore('pw-one', 'alice', Object.assign({}, row, { iterations: 'lots' }))));
check('createKeystore refuses a cheap KDF', why(() => vault.createKeystore('pw', 'alice', 1000)));

// Password change = re-wrap of the SAME data key, no row re-encryption.
const rewrapped = vault.rewrapKeystore(ks.dek, 'pw-two', row, 'alice');
const row2 = { salt: rewrapped.salt, iterations: rewrapped.iterations, wrapped_key: rewrapped.wrapped };
check('re-wrap unlocks under the new password',
  vault.unlockKeystore('pw-two', 'alice', row2).equals(ks.dek));
check('re-wrap invalidates the old password',
  why(() => vault.unlockKeystore('pw-one', 'alice', row2)));
check('re-wrap keeps the same salt + iteration count',
  rewrapped.salt === ks.salt && rewrapped.iterations === ks.iterations);
check('re-wrap refuses a wrongly sized data key', why(() => vault.rewrapKeystore(Buffer.alloc(16, 7), 'pw', row, 'alice')));

// burnKdf: the duress branch's timing filler — same shape of work, no output.
const t0 = Date.now();
vault.burnKdf('some password');
const burnMs = Date.now() - t0;
check('burnKdf() spends a real KDF (>=50 ms)', burnMs >= 50, burnMs + ' ms');
check('burnKdf() returns nothing', vault.burnKdf('x') === undefined);

// ── Phase D: hygiene ─────────────────────────────────────────────────────────
console.log('\n== Phase D: hygiene ==');
const scratch = Buffer.alloc(32, 9);
vault.zeroize(scratch);
check('zeroize() fills the buffer with zeroes', scratch.every(b => b === 0));
check('zeroize() tolerates non-buffers', throws(() => vault.zeroize('not a buffer')) === false);
check('encrypt() refuses a non-buffer key', why(() => vault.encrypt('key', 'x', AAD)));
check('encrypt() refuses a short key', why(() => vault.encrypt(Buffer.alloc(16), 'x', AAD)));
check('encrypt() refuses a long key', why(() => vault.encrypt(Buffer.alloc(64), 'x', AAD)));
check('createKeystore returns no stray password on the row',
  JSON.stringify({ salt: ks.salt, iterations: ks.iterations, wrapped: ks.wrapped }).indexOf('pw-one') === -1);

const vaultSrc = fs.readFileSync(path.join(SRC, 'vault.js'), 'utf8');
check('vault.js has no Electron dependency (pure module)',
  !/require\(['"]electron['"]\)/.test(vaultSrc));
check('vault.js has no filesystem access', !/require\(['"]fs['"]\)/.test(vaultSrc));
check('vault.js never logs a key', !/console\.(log|error|warn)/.test(vaultSrc));

// ── Phase E: SQL audit of main.js ────────────────────────────────────────────
console.log('\n== Phase E: SQL audit (encrypted columns are dead to SQL) ==');

// Minimal JS scanner: returns every string literal, skipping comments (a
// comment mentioning "GROUP BY domain" must not be mistaken for SQL) and
// regex literals (so an apostrophe inside one cannot swallow real code).
function stringLiterals(src) {
  const out = [];
  let i = 0, prev = '', word = '';
  const n = src.length;
  const regexOkAfter = /[(,=:[!&|?{};+\-*%<>\n]/;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1, s = '';
      while (j < n) {
        if (src[j] === '\\') { s += src[j + 1] || ''; j += 2; continue; }
        if (src[j] === c) break;
        s += src[j]; j++;
      }
      out.push(s);
      i = j + 1; prev = c; word = '';
      continue;
    }
    if (c === '/' && (regexOkAfter.test(prev) || /^(return|typeof|case|in|of|new|delete|void|do|else|await)$/.test(word))) {
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') { while (i < n && src[i] !== ']') { if (src[i] === '\\') i++; i++; } i++; continue; }
        if (src[i] === '/' && src[i - 1] !== '\\') break;
        if (src[i] === '\n') break;
        i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) i++;
      prev = '/'; word = '';
      continue;
    }
    if (!/\s/.test(c)) { prev = c; word = /[\w$]/.test(c) ? word + c : ''; }
    i++;
  }
  return out;
}

// Encrypted columns (must mirror the vault matrix in main.js).
const ENC_COLS = ['url', 'title', 'content', 'domain', 'filename', 'save_path', 'google_email', 'active_url', 'name'];
// Columns that deliberately stay plaintext: page_visits.category and every
// numeric/timestamp column — these are NOT forbidden in SQL.
const SQLISH = /^\s*(SELECT\b|INSERT\b|UPDATE\b|DELETE\b|CREATE\s+(TABLE|INDEX)\b|ALTER\s+TABLE\b|DROP\s+INDEX\b|PRAGMA\b|VACUUM\b)/i;
const CLAUSE = /\b(WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIKE|JOIN)\b/gi;

const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const sqlLiterals = stringLiterals(mainSrc).filter(s => SQLISH.test(s));
check('SQL found in main.js (' + sqlLiterals.length + ' statements)', sqlLiterals.length >= 40, sqlLiterals.length);

const findings = [];
for (const sql of sqlLiterals) {
  if (/\bLIKE\b/i.test(sql)) findings.push('LIKE in SQL: ' + sql.trim().slice(0, 90));
  const regions = [];
  if (/^\s*CREATE\s+INDEX/i.test(sql)) regions.push(sql);
  else { let m; CLAUSE.lastIndex = 0; while ((m = CLAUSE.exec(sql))) regions.push(sql.slice(m.index)); }
  for (const region of regions) {
    for (const col of ENC_COLS) {
      if (new RegExp('\\b' + col + '\\b').test(region)) {
        findings.push(col + ' inside a SQL clause: …' + region.trim().replace(/\s+/g, ' ').slice(0, 90));
      }
    }
  }
}
check('no SQL compares, groups, orders or joins on an encrypted column',
  findings.length === 0, findings.join(' | '));
check('no index is defined on an encrypted column',
  !sqlLiterals.some(s => /^\s*CREATE\s+INDEX/i.test(s) && ENC_COLS.some(c => new RegExp('\\b' + c + '\\b').test(s))));
check('old url-matching statements are gone (bookmarkCheck / save_path delete)',
  !/bookmarkCheck/.test(mainSrc) && !/DELETE FROM downloads WHERE save_path/.test(mainSrc));

// ── Phase F: wiring in main.js / UI / packaging ──────────────────────────────
console.log('\n== Phase F: wiring ==');
const count = (re, s) => (s.match(re) || []).length;

const TABLES = ['history', 'bookmarks', 'tabs', 'notes', 'page_visits', 'downloads', 'workspaces'];
for (const t of TABLES) {
  const enc = count(new RegExp("vaultEncRow\\('" + t + "'"), mainSrc);
  const dec = count(new RegExp("vaultDecRow\\('" + t + "'"), mainSrc);
  check(t + ' encrypted at write (' + enc + ') and decrypted at read (' + dec + ')', enc >= 1 && dec >= 1,
    'enc=' + enc + ' dec=' + dec);
}

check('secure_delete ON at DB init (old bytes zero-filled, not orphaned)',
  /pragma\('secure_delete = ON'\)/.test(mainSrc));
check('user_keystores table declared', /CREATE TABLE IF NOT EXISTS user_keystores/.test(mainSrc));
check('migration ends with a VACUUM (plaintext scrubbed from free pages)',
  /VACUUM/.test(mainSrc) && /wal_checkpoint\(TRUNCATE\)/.test(mainSrc));
check('migration is transactional + resumable (migrated flag reset before sweep)',
  /migrated=0/.test(mainSrc) && /UPDATE user_keystores SET migrated=1/.test(mainSrc));

check('login unwraps / enrols the key (vaultActivateForLogin)',
  /function vaultActivateForLogin/.test(mainSrc) && count(/vaultActivateForLogin\(/g, mainSrc) >= 2);
check('login burns a filler KDF on the duress branch (timing parity)',
  /vault\.burnKdf\(password\)/.test(mainSrc));
check('failed unlock does not spend a login attempt (vaultError path)',
  /vaultError/.test(mainSrc) && /if \(result && result\.vaultError\)/.test(mainSrc));
check('key dropped on logout / guest / wipe / quit (>=4 vaultDeactivate sites)',
  count(/vaultDeactivate\(\)/g, mainSrc) >= 5, count(/vaultDeactivate\(\)/g, mainSrc));
check('password change re-wraps the key inside the transaction',
  /ipcMain\.handle\('change-password'[\s\S]{0,1600}?vaultRekey\(currentUser, newPw\)/.test(mainSrc));
check('register enrols a keystore before any row exists',
  /vaultEnrollNewUser\(key, password\)/.test(mainSrc));

// Quit teardown race: a tab navigation can commit AFTER before-quit dropped
// the key while currentUser is still set (this actually leaked a plaintext
// history row once). A vaulted account must drop that write, never store it.
check('no plaintext fallback for a vaulted account (vaultEncRow returns null)',
  /function vaultPlainForbidden/.test(mainSrc) &&
  /if \(vaultPlainForbidden\(u\)\) return null;/.test(mainSrc) &&
  /SELECT migrated FROM user_keystores WHERE user_pseudo=\?/.test(mainSrc));
check('history + page-visit writes are dropped when the key is missing',
  /function addHistory[\s\S]{0,500}?if \(!enc\) return;/.test(mainSrc) &&
  /function recordVisitStart[\s\S]{0,900}?if \(!enc\) return;/.test(mainSrc));
check('saveTabsDb encrypts BEFORE its DELETE and aborts when a key is missing',
  (() => {
    const fn = (mainSrc.match(/function saveTabsDb[\s\S]*?\n\}/) || [''])[0];
    return /const encList = list\.map/.test(fn) &&
      /if \(encList\.some\(\(e\) => !e\)\) return;/.test(fn) &&
      fn.indexOf('encList.some') < fn.indexOf('tabDelete');
  })());
check('bookmark / note / workspace / download writers all guard the null row',
  count(/if \(!enc\)/g, mainSrc) >= 7 &&
  count(/if \(!denc\) return;/g, mainSrc) >= 2 &&
  /if \(!encEmail\) return false;/.test(mainSrc) &&
  /if \(!ws\) return; \/\/ vaulted account without a key/.test(mainSrc));

// Clipboard auto-wipe
check('copy sites arm the wipe (>=3 call sites)',
  count(/scheduleClipboardWipe\(/g, mainSrc) >= 4, count(/scheduleClipboardWipe\(/g, mainSrc));
check('poller seeded from the clipboard baseline at startup',
  /function clipStartPolling/.test(mainSrc) && /clipStartPolling\(\)/.test(mainSrc) &&
  /BASELINE/i.test(mainSrc));
check('poller cadence is 1.5 s', /CLIP_POLL_MS = 1500/.test(mainSrc));
check('defaults are ON with a 20 s delay', /enabled: true, seconds: 20/.test(mainSrc));
check('wipe only fires when the clipboard is unchanged',
  /now === clipWatched && now !== ''/.test(mainSrc));
check('startup baseline is never armed (clipLive gates the timer + re-arm)',
  /clipLive/.test(mainSrc) &&
  /if \(clipLive && clipWatched !== null && now === clipWatched/.test(mainSrc) &&
  /else if \(clipLive && clipWatched !== null\) clipArm\(\)/.test(mainSrc));
check('quit wipe is keyed to the startup baseline (session content only)',
  /now !== clipBaseline/.test(mainSrc) && /clipBaseline = clipRead\(\) \|\| null/.test(mainSrc));
check('quit wipes a still-tracked copy (before-quit hook)',
  /clipWipeOnQuit\(\)/.test(mainSrc) && /app\.on\('before-quit'[\s\S]{0,900}?clipWipeOnQuit/.test(mainSrc));
check('prefs persist in clipboard-prefs.json with clamped 5–600 s',
  /clipboard-prefs\.json/.test(mainSrc) && /CLIP_MIN_SECONDS = 5/.test(mainSrc) && /CLIP_MAX_SECONDS = 600/.test(mainSrc));
check('both clip IPC channels registered',
  /ipcMain\.handle\('clip-get-prefs'/.test(mainSrc) && /ipcMain\.handle\('clip-set-prefs'/.test(mainSrc));

const preloadSrc = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
check('preload exposes the clipboard prefs',
  /getClipboardPrefs:/.test(preloadSrc) && /setClipboardPrefs:/.test(preloadSrc));

const settingsSrc = fs.readFileSync(path.join(SRC, 'settings.html'), 'utf8');
check('Settings has the Clipboard Auto-Wipe card (toggle + delay)',
  /Clipboard Auto-Wipe/.test(settingsSrc) && /id="cw-toggle"/.test(settingsSrc) && /id="cw-seconds"/.test(settingsSrc));
check('Settings documents the Win+V clipboard-history limitation',
  /Win\+V/.test(settingsSrc));

const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
check('package.json build.files ships vault.js', (pkg.build.files || []).includes('vault.js'),
  JSON.stringify(pkg.build.files));

// ── Cleanup ──────────────────────────────────────────────────────────────────
vault.zeroize(dek);
vault.zeroize(ks.dek);
vault.zeroize(unwrapped);
console.log('\n== RESULT: ' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED') + ' ==');
process.exit(failures ? 1 : 0);
