#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PKG_PATH = join(ROOT, 'package.json');

const tag = process.argv[2];
if (!tag) {
  console.error('Usage: npm run release <tag>');
  console.error('Example: npm run release 0.1.0');
  process.exit(1);
}

const version = tag.replace(/^v/, '');

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

// 1. Build
run('npm run build');

// 2. Tests
run('npm test');

// 3. Update version in package.json
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
pkg.version = version;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\nUpdated package.json version to ${version}`);

// 4. Commit
run(`git add package.json`);
run(`git commit -m "release: preparing version ${version}"`);

// 5. Tag
run(`git tag v${version}`);

// 6. Publish
run('npm publish --access public');

// 7. Push commit + tag
run('git push');
run(`git push origin v${version}`);

console.log(`\nReleased v${version} successfully!`);
