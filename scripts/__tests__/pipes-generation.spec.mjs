import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('organization and user data providers mount onto Pipes using the real policy', () => {
  const operations = JSON.parse(oagen('resolve', '--spec', 'spec/open-api-spec.yaml', '--format', 'json'));
  for (const service of ['OrganizationsDataProviders', 'UserManagementDataProviders']) {
    const mounted = operations.filter((operation) => operation.service === service);
    assert.ok(mounted.length > 0, `expected operations for ${service}`);
    for (const operation of mounted) {
      assert.equal(operation.mountOn, 'Pipes', `${operation.method} ${operation.path}`);
    }
  }
});

test('Pipes-scoped Node generation puts organization methods and models under src/pipes', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'openapi-pipes-generation-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  oagen('generate', '--spec', 'spec/open-api-spec.yaml', '--lang', 'node',
    '--namespace', 'workos', '--services', 'Pipes', '--output', output);

  const pipes = readFileSync(join(output, 'src/pipes/pipes.ts'), 'utf8');
  for (const method of [
    'getOrganizationConnectedAccount',
    'createOrganizationConnectedAccount',
    'updateOrganizationConnectedAccount',
    'deleteOrganizationConnectedAccount',
    'listOrganizationDataProviders',
    'getUserConnectedAccount',
  ]) {
    assert.match(pipes, new RegExp(`async ${method}\\(`));
    const file = method.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    assert.ok(existsSync(join(output, `src/pipes/interfaces/${file}-options.interface.ts`)), method);
  }
  for (const model of ['connected-account', 'connected-account-input', 'data-integrations-list-response']) {
    for (const [folder, suffix] of [['interfaces', 'interface'], ['serializers', 'serializer']]) {
      const file = `src/pipes/${folder}/${model}.${suffix}.ts`;
      assert.ok(existsSync(join(output, file)), `expected ${file}`);
    }
  }
  assert.doesNotMatch(pipes, /\.\.\/(organizations-data-providers|user-management-data-providers)\//);
  assert.equal(existsSync(join(output, 'src/organizations-data-providers')), false);
  assert.equal(existsSync(join(output, 'src/user-management-data-providers')), false);
});
