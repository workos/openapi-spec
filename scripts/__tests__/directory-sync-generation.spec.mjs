import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const oagen = (...args) => execFileSync('npx', ['--no-install', 'oagen', ...args], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 120_000,
});

test('manual directory sync has a provider-neutral name on DirectorySync', () => {
  const operations = JSON.parse(oagen('resolve', '--spec', 'spec/open-api-spec.yaml', '--format', 'json'));
  const sync = operations.find((operation) => operation.method === 'POST' && operation.path === '/directories/{id}/sync');
  assert.ok(sync);
  assert.equal(sync.derivedName, 'sync_directory');
  assert.equal(sync.mountOn, 'DirectorySync');
});

test('Node generation retains the typed 202 queued response for directory sync', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'openapi-directory-sync-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  oagen('generate', '--spec', 'spec/open-api-spec.yaml', '--lang', 'node',
    '--namespace', 'workos', '--services', 'DirectorySync', '--output', output);

  const service = readFileSync(join(output, 'src/directory-sync/directory-sync.ts'), 'utf8');
  assert.match(service, /async syncDirectory\(/);
  assert.match(service, /Promise<DirectorySyncResponse>/);
  assert.match(service, /\/directories\/.*\/sync/);
  assert.doesNotMatch(service, /createDirectorySync\(/);

  const model = readFileSync(join(output, 'src/directory-sync/interfaces/directory-sync-response.interface.ts'), 'utf8');
  assert.match(model, /status: ['"]queued['"]/);
});
