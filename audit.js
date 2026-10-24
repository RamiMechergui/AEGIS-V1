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
for (const f of ['main.js', 'preload.js', 'create-logo.js']) {
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
// Reverse direction: preload listeners must be fed by a main.js webContents.send
// (direct, or via the local `emit(channel, ...)` wrapper around webContents.send)
const mainSends = new Set([
  ...[...main.matchAll(/(?:webContents|wc)\.send\(\s*['"]([\w-]+)['"]/g)].map(m => m[1]),
  ...[...main.matchAll(/\bemit\(\s*['"]([\w-]+)['"]/g)].map(m => m[1]),
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
const allRendererText = htmlFiles.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n') + preload;
const orphans = [...ons].filter(c => !allRendererText.includes("'" + c + "'") && !allRendererText.includes('"' + c + '"'));
if (orphans.length) console.log('  [info] .on channels with no visible sender: ' + orphans.join(', '));
else ok('every ipcMain.on channel has a sender somewhere');

console.log('\n== RESULT: ' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED') + ' ==');
process.exit(failures ? 1 : 0);
