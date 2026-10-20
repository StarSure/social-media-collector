#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'assets/extension');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'assets/runtime-manifest.json'), 'utf8'));
const catalog = JSON.parse(await fs.readFile(path.join(root, 'references/platforms.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function filesAt(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Symlinks are not distributable: ${full}`);
    if (entry.isDirectory()) files.push(...await filesAt(full));
    else files.push(full);
  }
  return files;
}

const actual = await filesAt(runtime);
assert.equal(new Set(manifest.files.map(item => item.path)).size, manifest.files.length, 'Duplicate runtime manifest entries');
assert.deepEqual(actual.map(file => path.relative(runtime, file).split(path.sep).join('/')).sort(), manifest.files.map(item => item.path).sort(), 'Runtime inventory differs from the manifest');
for (const item of manifest.files) {
  assert.equal(hash(await fs.readFile(path.join(runtime, item.path))), item.sha256, `Runtime checksum mismatch: ${item.path}`);
}
for (const platform of catalog.platforms) {
  await fs.access(path.join(root, platform.reference));
  assert.equal(new Set(platform.tasks.map(task => task.id)).size, platform.tasks.length, `Duplicate task in ${platform.id}`);
}

const directories = ['agents', 'assets', 'references', 'scripts', 'tests', 'examples'];
const files = (await Promise.all(directories.map(name => filesAt(path.join(root, name))))).flat();
files.push(...['SKILL.md', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json'].map(name => path.join(root, name)));
for (const file of files) {
  if (file.endsWith('.png') || file.endsWith('.pyc') || file.includes(`${path.sep}__pycache__${path.sep}`)) continue;
  const text = await fs.readFile(file, 'utf8');
  const relative = path.relative(root, file);
  assert.ok(!/\/Users\/[^\s"']+|[A-Z]:\\Users\\[^\s"']+/.test(text), `Build-machine path in ${relative}`);
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text), `Credential-like material in ${relative}`);
  if (file.endsWith('.md')) {
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      await fs.access(path.resolve(path.dirname(file), target));
    }
  }
  if (file.endsWith('.js') || file.endsWith('.mjs')) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${relative}: ${checked.stderr}`);
  }
}
console.log(JSON.stringify({ status: 'passed', runtimeFiles: actual.length, platforms: catalog.platforms.length, tasks: catalog.platforms.reduce((sum, platform) => sum + platform.tasks.length, 0), checks: ['runtime inventory and SHA-256', 'platform references', 'documentation links', 'build-machine paths and credential patterns', 'JavaScript syntax'] }, null, 2));
