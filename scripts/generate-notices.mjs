import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const groups = new Map();
const missing = [];
const fallbacks = JSON.parse(fs.readFileSync('assets/notices/npm-fallbacks.json', 'utf8'));
function addNotice(text, name) {
  if (!groups.has(text)) groups.set(text, []);
  groups.get(text).push(name);
}
function licenseFiles(directory) {
  return fs
    .readdirSync(directory)
    .filter(
      (name) =>
        /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name) &&
        fs.statSync(path.join(directory, name)).isFile(),
    );
}
for (const [directory, info] of Object.entries(lock.packages)) {
  if (!directory || info.dev || !fs.existsSync(directory)) continue;
  const pkgFile = path.join(directory, 'package.json');
  if (!fs.existsSync(pkgFile)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const files = licenseFiles(directory);
  const repository =
    typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
  const fallback = fallbacks[pkg.name];
  const text = files.length
    ? files.map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n\n')
    : fallback
      ? `${fallback.text}\nSource: ${fallback.source}`
      : `License: ${pkg.license ?? 'see upstream'}\n${repository}`;
  if (!files.length && !fallback) missing.push(pkg.name);
  addNotice(text, `${pkg.name}@${pkg.version}`);
}
const metadata = JSON.parse(
  execFileSync(
    'cargo',
    [
      'metadata',
      '--manifest-path',
      'native/sekirei/Cargo.toml',
      '--format-version',
      '1',
      '--locked',
    ],
    { encoding: 'utf8' },
  ),
);
for (const pkg of metadata.packages) {
  let directory = path.dirname(pkg.manifest_path);
  let files = licenseFiles(directory);
  // Sekirei and jni-sys-macros use their workspace's license notices.
  if (!files.length && fs.existsSync(path.join(directory, '..', 'Cargo.toml'))) {
    directory = path.dirname(directory);
    files = licenseFiles(directory);
  }
  let text = files.map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n\n');
  if (pkg.name === 'sekirei-core')
    text = ['native/sekirei/NOTICE', 'native/sekirei/LICENSE-MIT', 'native/sekirei/LICENSE-APACHE']
      .map((name) => fs.readFileSync(name, 'utf8'))
      .join('\n\n');
  const nested = path.join(directory, 'licenses');
  if (fs.existsSync(nested))
    text +=
      '\n\n' +
      licenseFiles(nested)
        .map((name) => fs.readFileSync(path.join(nested, name), 'utf8'))
        .join('\n\n');
  if (!text.trim()) {
    const fallbackPath = `assets/notices/rust-${pkg.name}.txt`;
    if (fs.existsSync(fallbackPath)) text = fs.readFileSync(fallbackPath, 'utf8');
    else {
      missing.push(`Rust: ${pkg.name}`);
      text = `License: ${pkg.license}\n${pkg.repository ?? ''}`;
    }
  }
  addNotice(text, `Rust: ${pkg.name}@${pkg.version}`);
}
const extra = 'assets/model/NOTICE.txt';
if (fs.existsSync(extra))
  addNotice(fs.readFileSync(extra, 'utf8'), 'sekirei-weight / c-leaf-wrm-seed42');
const notices = [...groups.entries()]
  .map(([text, packages]) => ({ packages: [...new Set(packages)].sort(), text }))
  .sort((a, b) => a.packages[0].localeCompare(b.packages[0]));
fs.mkdirSync('assets', { recursive: true });
fs.writeFileSync('assets/licenses.json', JSON.stringify(notices) + '\n');
console.log(
  `Wrote ${notices.length} notice groups; ${missing.length} packages provide SPDX/URL only.`,
);
if (missing.length) console.log(missing.join(', '));
