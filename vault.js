// vault.js — at-rest field encryption for AEGIS (AES-256-GCM envelope keys).
//
// PURE CRYPTO: no Electron, no filesystem, no database. main.js owns every
// storage decision (which table, which column, when to migrate); this module
// only does key math and bytes, so it can be unit-tested with plain `node`.
//
// Envelope model
//   DEK  32 random bytes, generated once per account, encrypts every field.
//   KEK  PBKDF2-SHA512(password, salt, 300000) — wraps the DEK only.
//   Row  user_keystores(user_pseudo, salt, iterations, wrapped_key) in ghostview.db.
//
// Why an envelope and not "derive the field key straight from the password":
// changing the password then costs one re-wrap of a 32-byte key instead of
// re-encrypting every row, so a password change is a single short transaction
// and can never half-finish with mixed ciphertext. The DEK exists ONLY in
// process memory — it is zeroized on logout / quit.
//
// Value format
//   "AEG1:" + base64( iv[12] || authTag[16] || ciphertext )
// The AEG1: prefix is what lets a reader tell plaintext from ciphertext, which
// is what makes the first-login migration a safe, idempotent, resumable pass.
//
// AAD binding
//   Every value is authenticated against `AEG1|table|column|user_pseudo|scope`
//   (scope = the row's workspace, or the workspace id itself for `workspaces`).
//   Moving a ciphertext to another table, another column, another account or
//   another workspace therefore fails the GCM tag check instead of decrypting.
//   The numeric row id is deliberately NOT part of the AAD: the id of an
//   AUTOINCREMENT row does not exist until after the INSERT, and an AAD that
//   differs between insert and update would make stored values undecryptable.

'use strict';

const crypto = require('crypto');

// Ciphertext marker. Bump the prefix only if the whole format changes.
const PREFIX = 'AEG1:';

// KDF for the key-encryption key. 300k iterations of PBKDF2-SHA512 is ~0.3 s
// on a current laptop — deliberately the expensive half of login, and it is
// run exactly once per attempt (see loginKeyWork in main.js) so a real login,
// a duress login and a legacy-account login all cost the same wall time.
const KDF_HASH = 'sha512';
const KDF_ITERATIONS = 300000;
const KDF_MIN_ITERATIONS = 100000;   // a tampered row may not cheapen the KDF
const KDF_MAX_ITERATIONS = 5000000;  // …nor may it turn login into a hang
const KEY_LEN = 32;                  // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;                   // GCM standard nonce size
const TAG_LEN = 16;
const MIN_TOKEN_BODY = IV_LEN + TAG_LEN;

// Domain separation for the DEK wrap: an attacker who somehow controls a
// wrapped_key blob learns nothing usable from it as a field-encryption key.
const WRAP_AAD_PREFIX = 'AEGIS-V1:vault:kek-wrap:v1|';

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw new Error('vault: expected a ' + KEY_LEN + '-byte key buffer');
  }
}

function assertIterations(iterations) {
  const n = Number(iterations);
  if (!Number.isInteger(n) || n < KDF_MIN_ITERATIONS || n > KDF_MAX_ITERATIONS) {
    throw new Error('vault: keystore KDF iterations out of range');
  }
  return n;
}

// ── KEK (password → wrap key) ────────────────────────────────────────────────

function deriveKek(password, salt, iterations) {
  const n = assertIterations(iterations);
  if (!Buffer.isBuffer(salt) || salt.length < 8) throw new Error('vault: bad keystore salt');
  return crypto.pbkdf2Sync(String(password), salt, n, KEY_LEN, KDF_HASH);
}

// Cost of exactly one KEK derivation, with a throwaway salt. Used for the
// duress branch of login so that "real account" and "decoy account" logins
// take the same time (the existing two-derivation rule in authenticate() is
// extended, not replaced, by this one).
function burnKdf(password) {
  const kek = crypto.pbkdf2Sync(String(password), crypto.randomBytes(SALT_LEN), KDF_ITERATIONS, KEY_LEN, KDF_HASH);
  zeroize(kek);
}

function sealKey(kek, dek, userPseudo) {
  assertKey(kek); assertKey(dek);
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from(WRAP_AAD_PREFIX + String(userPseudo), 'utf8'));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function openKey(kek, wrapped, userPseudo) {
  assertKey(kek);
  const buf = Buffer.from(String(wrapped || ''), 'base64');
  if (buf.length < MIN_TOKEN_BODY + KEY_LEN) throw new Error('vault: wrapped key is truncated');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  d.setAAD(Buffer.from(WRAP_AAD_PREFIX + String(userPseudo), 'utf8'));
  d.setAuthTag(tag);
  let dek;
  try {
    dek = Buffer.concat([d.update(ct), d.final()]); // throws: wrong password, wrong account, tampered row
  } catch (e) {
    throw new Error('vault: could not unwrap the data key');
  }
  if (dek.length !== KEY_LEN) { zeroize(dek); throw new Error('vault: unwrapped key has the wrong length'); }
  return dek;
}

// ── Keystore row lifecycle (storage shape only — main.js does the SQL) ───────

// Returns { salt, iterations, wrapped, dek }. The caller MUST zeroize `dek`
// if it does not keep it.
function createKeystore(password, userPseudo, iterations) {
  const n = assertIterations(iterations === undefined ? KDF_ITERATIONS : iterations);
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = deriveKek(password, salt, n);
  const dek = crypto.randomBytes(KEY_LEN);
  let wrapped;
  try { wrapped = sealKey(kek, dek, userPseudo); }
  finally { zeroize(kek); }
  return { salt: salt.toString('hex'), iterations: n, wrapped: wrapped, dek: dek };
}

// Returns the DEK. Throws (never returns null) when the password is wrong, the
// row was tampered with, or it belongs to another account.
function unlockKeystore(password, userPseudo, row) {
  if (!row) throw new Error('vault: no keystore for this account');
  const iterations = assertIterations(row.iterations);
  const salt = Buffer.from(String(row.salt || ''), 'hex');
  const kek = deriveKek(password, salt, iterations);
  try { return openKey(kek, row.wrapped_key !== undefined ? row.wrapped_key : row.wrapped, userPseudo); }
  finally { zeroize(kek); }
}

// Password change: same DEK, same salt, new wrap. No data row is touched, so
// a re-key cannot leave half the database readable under the old password.
function rewrapKeystore(dek, newPassword, row, userPseudo) {
  assertKey(dek);
  const iterations = assertIterations(row.iterations);
  const salt = Buffer.from(String(row.salt || ''), 'hex');
  const kek = deriveKek(newPassword, salt, iterations);
  try { return { salt: salt.toString('hex'), iterations: iterations, wrapped: sealKey(kek, dek, userPseudo) }; }
  finally { zeroize(kek); }
}

// ── Field values ─────────────────────────────────────────────────────────────

function aadFor(table, column, userPseudo, scope) {
  return ['AEG1', table, column, userPseudo, scope === undefined || scope === null ? '' : String(scope)].join('|');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.indexOf(PREFIX) === 0;
}

function encrypt(key, value, aad) {
  assertKey(key);
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(String(aad), 'utf8'));
  const pt = Buffer.from(String(value), 'utf8');
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(key, token, aad) {
  assertKey(key);
  if (!isEncrypted(token)) throw new Error('vault: value is not encrypted');
  const buf = Buffer.from(String(token).slice(PREFIX.length), 'base64');
  if (buf.length < MIN_TOKEN_BODY) throw new Error('vault: ciphertext is truncated');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(String(aad), 'utf8'));
  d.setAuthTag(tag);
  let pt;
  try {
    pt = Buffer.concat([d.update(ct), d.final()]); // throws on any tamper / AAD mismatch
  } catch (e) {
    throw new Error('vault: authentication failed (wrong key, or the value was moved)');
  }
  return pt.toString('utf8');
}

function zeroize(buf) {
  if (Buffer.isBuffer(buf)) { try { buf.fill(0); } catch (e) {} }
}

module.exports = {
  PREFIX,
  KDF_HASH,
  KDF_ITERATIONS,
  KDF_MIN_ITERATIONS,
  KDF_MAX_ITERATIONS,
  KEY_LEN,
  SALT_LEN,
  deriveKek,
  burnKdf,
  createKeystore,
  unlockKeystore,
  rewrapKeystore,
  aadFor,
  isEncrypted,
  encrypt,
  decrypt,
  zeroize,
};
