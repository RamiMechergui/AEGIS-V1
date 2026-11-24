// AEGIS release audit: syntax + IPC/bridge consistency
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = process.cwd();
let failures = 0;
const fail = (msg) => { failures++; console.log('  [FAIL] ' + msg); };
const ok = (msg) => console.log('  [ OK ] ' + msg);

// ── 1. Syntax: .js files ──
console.log('\n== 1. JS syntax ==');
for (const f of ['main.js', 'preload.js', 'create-logo.js', 'shield.js', 'fp-preload.js']) {
  try {
    new vm.Script(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
    ok(f + ' parses');
  } catch (e) { fail(f + ': ' + e.message); }
}

// ── 2. Syntax: inline <script> in every HTML file ──
console.log('\n== 2. HTML inline script syntax ==');
const htmlFiles = fs.readdirSync(root).filter(f => f.endsWith('.html'));
for (const f of htmlFiles) {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  scripts.forEach((m, i) => {
    try {
      new vm.Script(m[1], { filename: f + '#script' + (i + 1) });
    } catch (e) { fail(f + ' script#' + (i + 1) + ': ' + e.message); }
  });
  ok(f + ' (' + scripts.length + ' inline script block(s) parse)');
}

// ── 3. Bridge methods: preload exposes vs HTML uses ──
console.log('\n== 3. preload bridge vs renderer usage ==');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const bridgeName = (preload.match(/exposeInMainWorld\(\s*['"]([\w-]+)['"]/) || [])[1] || 'g';
const exposed = new Set([...preload.matchAll(/^\s{2}([\w$]+):\s*(?:\([^)]*\)|[\w$]+)\s*=>/gm)].map(m => m[1]));
ok('bridge object: "' + bridgeName + '", ' + exposed.size + ' methods exposed');

for (const f of htmlFiles) {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  // HTML files alias the bridge (e.g. `const g = window.ghost`) — honor the alias
  const aliasRe = new RegExp('(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*window\\.' + bridgeName + '\\b', 'g');
  const accessors = new Set([bridgeName, ...[...html.matchAll(aliasRe)].map(m => m[1])]);
  const used = new Set();
  for (const acc of accessors) {
    for (const m of html.matchAll(new RegExp('\\b' + acc.replace(/\$/g, '\\$') + '\\.([\\w$]+)', 'g'))) used.add(m[1]);
  }
  for (const u of used) {
    if (!exposed.has(u)) fail(f + ' calls ' + bridgeName + '.' + u + '() but preload does not expose it');
  }
  if (used.size) ok(f + ': ' + used.size + ' bridge calls via [' + [...accessors].join(', ') + '], all exposed');
}

// ── 4. IPC channels: preload invoke/send vs main.js handle/on ──
console.log('\n== 4. IPC channels ==');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const handles = new Set([...main.matchAll(/ipcMain\.handle\(\s*['"]([\w-]+)['"]/g)].map(m => m[1]));
const ons = new Set([...main.matchAll(/ipcMain\.on\(\s*['"]([\w-]+)['"]/g)].map(m => m[1]));

// duplicate handler registrations throw at runtime
const allHandle = [...main.matchAll(/ipcMain\.handle\(\s*['"]([\w-]+)['"]/g)].map(m => m[1]);
const dupes = allHandle.filter((c, i) => allHandle.indexOf(c) !== i);
if (dupes.length) fail('duplicate ipcMain.handle: ' + [...new Set(dupes)].join(', '));
else ok('no duplicate ipcMain.handle registrations');

for (const m of preload.matchAll(/ipcRenderer\.invoke\(\s*['"]([\w-]+)['"]/g)) {
  if (!handles.has(m[1])) fail('preload invokes "' + m[1] + '" but main.js has no ipcMain.handle for it');
}
for (const m of preload.matchAll(/ipcRenderer\.send\(\s*['"]([\w-]+)['"]/g)) {
  if (!ons.has(m[1])) fail('preload sends "' + m[1] + '" but main.js has no ipcMain.on for it');
}
// fp-preload.js pulls its config synchronously at document start — sendSync
// needs an ipcMain.on handler that sets e.returnValue.
const fpPreload = fs.readFileSync(path.join(root, 'fp-preload.js'), 'utf8');
for (const m of fpPreload.matchAll(/ipcRenderer\.sendSync\(\s*['"]([\w-]+)['"]/g)) {
  if (!ons.has(m[1])) fail('fp-preload.js sendSync "' + m[1] + '" but main.js has no ipcMain.on for it');
}
// Reverse direction: preload listeners must be fed by a main.js send
// (direct webContents.send, the local emit() wrapper, or e.sender.send)
const mainSends = new Set([
  ...[...main.matchAll(/(?:webContents|wc)\.send\(\s*['"]([\w-]+)['"]/g)].map(m => m[1]),
  ...[...main.matchAll(/\bemit\(\s*['"]([\w-]+)['"]/g)].map(m => m[1]),
  ...[...main.matchAll(/sender\.send\(\s*['"]([\w-]+)['"]/g)].map(m => m[1]),
]);
for (const m of preload.matchAll(/ipcRenderer\.on\(\s*['"]([\w-]+)['"]/g)) {
  if (!mainSends.has(m[1])) fail('preload listens for "' + m[1] + '" but main.js never webContents.send()s it');
}
ok('preload invoke channels all handled (' + [...preload.matchAll(/ipcRenderer\.invoke\(/g)].length + ')');
ok('preload send channels all listened (' + [...preload.matchAll(/ipcRenderer\.send\(/g)].length + ')');

// renderer send() in HTML files (some renderers use ipcRenderer via other names)
for (const f of htmlFiles) {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of html.matchAll(/ipcRenderer\.send\(\s*['"]([\w-]+)['"]/g)) {
    if (!ons.has(m[1])) fail(f + ' sends "' + m[1] + '" but main.js has no ipcMain.on for it');
  }
}

// ── 5. Senders of each .on channel exist somewhere (informational) ──
console.log('\n== 5. Orphan listeners (informational) ==');
const allRendererText = htmlFiles.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n') + preload + fpPreload;
const orphans = [...ons].filter(c => !allRendererText.includes("'" + c + "'") && !allRendererText.includes('"' + c + '"'));
if (orphans.length) console.log('  [info] .on channels with no visible sender: ' + orphans.join(', '));
else ok('every ipcMain.on channel has a sender somewhere');

// ── 6. Packaging: every page main.js loads must ship in the build ──
// A page left out of package.json build.files (yt-params.html once was) opens
// as a silent blank window in the packaged .exe — source runs still work, so
// this only explodes in the app users actually install.
console.log('\n== 6. Packaging (build.files covers every loaded page) ==');
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const buildFiles = (pkgJson.build && pkgJson.build.files) || [];
const globToRe = (pat) => new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const loadedPages = new Set([...main.matchAll(/loadFile\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]));
let unpackaged = 0;
for (const page of loadedPages) {
  const covered = buildFiles.some((entry) => entry === page || (entry.includes('*') && globToRe(entry).test(page)));
  if (!covered) { fail('main.js loads "' + page + '" but package.json build.files does not include it'); unpackaged++; }
}
if (!unpackaged) ok('every loadFile target is listed in build.files (' + loadedPages.size + ' pages)');

// Same failure mode for code/data files: a require('./shield') or
// path.join(__dirname, 'shield-list.txt') left out of build.files works in
// source runs and crashes (or silently unprotects) in the packaged .exe.
const localSrc = [main, preload, fs.readFileSync(path.join(root, 'shield.js'), 'utf8')].join('\n');
const localRefs = new Set();
for (const m of localSrc.matchAll(/require\(\s*['"]\.\/([\w.-]+)['"]\s*\)/g)) {
  localRefs.add(m[1].endsWith('.js') ? m[1] : m[1] + '.js');
}
for (const m of localSrc.matchAll(/__dirname\s*,\s*['"]([\w.-]+\.(?:js|txt|json|html))['"]/g)) localRefs.add(m[1]);
let missingRefs = 0;
for (const ref of localRefs) {
  const covered = buildFiles.some((entry) => entry === ref || (entry.includes('*') && globToRe(entry).test(ref)));
  if (!covered) { fail('local file "' + ref + '" is referenced by the app but not listed in package.json build.files'); missingRefs++; }
}
if (!missingRefs) ok('every locally required/referenced file is listed in build.files (' + localRefs.size + ' files)');

// ── 7. E2E sandboxes must ship everything main.js loads at runtime ──
// Every test-*.js that opens a sandbox copies a HAND-MAINTAINED file list and
// then runs main.js from that folder. A file main.js started requiring later
// (shield.js, shield-list.txt, fp-preload.js) but that nobody added to those
// lists makes the sandbox app die at startup — and only when someone actually
// runs that test, never during a release build.
console.log('\n== 7. E2E test sandboxes ==');
const appFiles = [...localRefs];
let sandboxGaps = 0;
let sandboxTests = 0;
for (const tf of fs.readdirSync(root).filter((f) => /^test-[\w-]+\.js$/.test(f))) {
  const src = fs.readFileSync(path.join(root, tf), 'utf8');
  const m = /const\s+files\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) continue;                       // not a sandbox-based test (unit suites)
  sandboxTests++;
  const listed = new Set();
  for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) listed.add(q[1]);
  for (const ref of appFiles) {
    if (listed.has(ref)) continue;
    fail(tf + ' sandbox does not copy "' + ref + '" — the copied app cannot start without it');
    sandboxGaps++;
  }
}
if (!sandboxGaps) ok('every sandbox test copies all locally required app files (' +
  sandboxTests + ' tests x ' + appFiles.length + ' files)');

console.log('\n== RESULT: ' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED') + ' ==');
process.exit(failures ? 1 : 0);
