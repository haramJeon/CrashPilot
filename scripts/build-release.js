#!/usr/bin/env node
/**
 * CrashPilot release build script
 *
 * Output structure (./release/):
 *   CrashPilot-win.exe        ← Windows x64
 *   CrashPilot-macos-x64      ← macOS Intel
 *   CrashPilot-macos-arm64    ← macOS Apple Silicon
 *   client/dist/              ← React UI (static files)
 *   config.json               ← copied from project root (template)
 *   data/                     ← created empty (runtime data)
 *
 * Usage:
 *   node scripts/build-release.js
 *   node scripts/build-release.js --platform win    (Windows only)
 *   node scripts/build-release.js --platform mac    (macOS only)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');
const clientSrc = path.join(root, 'client', 'dist');
const clientDest = path.join(releaseDir, 'client', 'dist');

// ── Determine targets for current OS (cross-compile not supported by pkg) ─
// pkg cannot cross-compile: build Windows exe on Windows, Mac binary on Mac.
const os = require('os');

const platformArg = (() => {
  const idx = process.argv.indexOf('--platform');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

function defaultTargets() {
  const p = os.platform();
  if (p === 'win32')  return ['node20-win-x64'];
  if (p === 'darwin') return ['node20-mac-x64', 'node20-mac-arm64'];
  return ['node20-linux-x64'];
}

const targets = (() => {
  if (!platformArg) return defaultTargets();
  if (platformArg === 'win')   return ['node20-win-x64'];
  if (platformArg === 'mac')   return ['node20-mac-x64', 'node20-mac-arm64'];
  if (platformArg === 'linux') return ['node20-linux-x64'];
  console.error('Unknown --platform value. Use "win", "mac", or "linux".');
  process.exit(1);
})();

// ── Helper ────────────────────────────────────────────────────────────────
function run(cmd, cwd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: cwd || root, stdio: 'inherit' });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

// ── 1. Clean release dir ──────────────────────────────────────────────────
console.log('\n=== Cleaning release/ ===');
if (fs.existsSync(releaseDir)) fs.rmSync(releaseDir, { recursive: true });
fs.mkdirSync(releaseDir, { recursive: true });

// ── 2. Install dependencies ───────────────────────────────────────────────
console.log('\n=== Installing client dependencies ===');
run('npm install', path.join(root, 'client'));

console.log('\n=== Installing server dependencies (full, for tsc) ===');
run('npm install', path.join(root, 'server'));

// ── 3. Build React client ─────────────────────────────────────────────────
console.log('\n=== Building React client ===');
run('npm run build', path.join(root, 'client'));

// ── 4. Build TypeScript server ────────────────────────────────────────────
console.log('\n=== Building TypeScript server ===');
run('npm run build', path.join(root, 'server'));

// ── 5. Package with @yao-pkg/pkg ─────────────────────────────────────────
console.log(`\n=== Packaging executables (${targets.join(', ')}) ===`);
const targetFlag = `--target ${targets.join(',')}`;
run(
  `npx @yao-pkg/pkg . ${targetFlag} --out-path ../release`,
  path.join(root, 'server')
);

// Rename outputs to friendly names
const nameMap = {
  'crashpilot-server-win.exe':        'CrashPilot-win.exe',
  'crashpilot-server-macos':          'CrashPilot-macos-x64',
  'crashpilot-server-macos-arm64':    'CrashPilot-macos-arm64',
  // @yao-pkg/pkg may use slightly different suffixes:
  'crashpilot-server-win-x64.exe':    'CrashPilot-win.exe',
  'crashpilot-server-mac-x64':        'CrashPilot-macos-x64',
  'crashpilot-server-mac-arm64':      'CrashPilot-macos-arm64',
  'crashpilot-server-linux-x64':      'CrashPilot-linux-x64',
};
for (const [from, to] of Object.entries(nameMap)) {
  const src = path.join(releaseDir, from);
  const dest = path.join(releaseDir, to);
  if (fs.existsSync(src) && !fs.existsSync(dest)) {
    fs.renameSync(src, dest);
    console.log(`Renamed: ${from} → ${to}`);
  }
}

// ── 6. Copy client/dist ───────────────────────────────────────────────────
console.log('\n=== Copying client build ===');
copyDir(clientSrc, clientDest);

// ── 6b. Copy tools/ (minidump_stackwalk binaries) ────────────────────────
const toolsSrc = path.join(root, 'tools');
const toolsDest = path.join(releaseDir, 'tools');
if (fs.existsSync(toolsSrc)) {
  console.log('\n=== Copying tools/ ===');
  copyDir(toolsSrc, toolsDest);
} else {
  console.log('\n[warn] tools/ directory not found — skipping (macOS crash dump analysis may not work)');
}

// ── 7. Copy config.json template ─────────────────────────────────────────
const configSrc = path.join(root, 'config.json');
if (fs.existsSync(configSrc)) {
  fs.copyFileSync(configSrc, path.join(releaseDir, 'config.json'));
  console.log('Copied config.json');
} else {
  console.log('No config.json found — skipping (app will create default on first run)');
}

// ── 8. Create empty data/ dir ─────────────────────────────────────────────
fs.mkdirSync(path.join(releaseDir, 'data'), { recursive: true });

// ── 9. Verify expected executables are present before zipping ────────────────
console.log('\n=== Verifying release executables ===');
const expectedExes = targets.map(t => {
  if (t.includes('win')) return 'CrashPilot-win.exe';
  if (t.includes('mac') && t.includes('arm64')) return 'CrashPilot-macos-arm64';
  if (t.includes('mac')) return 'CrashPilot-macos-x64';
  return 'CrashPilot-linux-x64';
});
for (const exe of [...new Set(expectedExes)]) {
  const exePath = path.join(releaseDir, exe);
  if (!fs.existsSync(exePath)) {
    console.error(`\n[ERROR] Expected executable not found: ${exe}`);
    console.error('  release/ directory contents:', fs.readdirSync(releaseDir).join(', '));
    console.error('  Ensure @yao-pkg/pkg succeeded and the nameMap covers its output filename.');
    process.exit(1);
  }
  console.log(`  ✓ ${exe}`);
}

// ── 10. Create zip archive ─────────────────────────────────────────────────
const { version } = require(path.join(root, 'package.json'));
const folderName = `crashPilot_${version}`;
const zipName = `${folderName}.zip`;
const zipPath = path.join(root, zipName);
const tempDir = path.join(root, folderName);

console.log(`\n=== Creating ${zipName} ===`);

// Copy release/ → crashPilot_{version}/ so the zip extracts to a named folder
if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
copyDir(releaseDir, tempDir);

// Remove existing zip if present
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

const platform = os.platform();
if (platform === 'win32') {
  run(`powershell -Command "Compress-Archive -Path '${folderName}' -DestinationPath '${zipName}' -Force"`, root);
} else {
  run(`zip -r "${zipName}" "${folderName}"`, root);
}

// Clean up temp folder
fs.rmSync(tempDir, { recursive: true });

// ── Done ──────────────────────────────────────────────────────────────────
console.log('\n✓ Build complete!');
console.log(`\nRelease archive: ${zipPath}`);
console.log('Users extract the zip and double-click the executable for their platform.');
console.log('The app opens at http://localhost:3001 in their default browser.\n');
