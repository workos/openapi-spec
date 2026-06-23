import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  batchBranchName,
  entryHeadline,
  orderedEntries,
  parseServices,
  prTitle,
  rewriteOverrideRefs,
} from '../open-batch-pr.mjs';

const SCRIPT = fileURLToPath(new URL('../open-batch-pr.mjs', import.meta.url));

// ── pure helpers (no git) ────────────────────────────────────────────────────
test('batchBranchName is deterministic', () => {
  assert.equal(batchBranchName('abc'), 'oagen/batch-abc');
});

test('prTitle lists services; empty → all services', () => {
  assert.equal(prTitle('Vault, SSO', 'b1'), 'feat(generated): Vault, SSO (batch b1)');
  assert.equal(prTitle('', 'b1'), 'feat(generated): all services (batch b1)');
});

test('parseServices trims and drops empties', () => {
  assert.deepEqual(parseServices(' Vault , ,SSO '), ['Vault', 'SSO']);
  assert.deepEqual(parseServices(''), []);
});

test('orderedEntries sorts feat! → feat → fix → chore', () => {
  const entries = [{ prefix: 'fix' }, { prefix: 'feat!' }, { prefix: 'chore' }, { prefix: 'feat' }];
  assert.deepEqual(orderedEntries(entries).map((e) => e.prefix), ['feat!', 'feat', 'fix', 'chore']);
});

test('entryHeadline puts the bang after the scope', () => {
  assert.equal(entryHeadline({ prefix: 'feat!', scope: 'vault', summary: 'x' }), 'feat(vault)!: x');
  assert.equal(entryHeadline({ prefix: 'fix', scope: 'sso', summary: 'y' }), 'fix(sso): y');
});

test('rewriteOverrideRefs appends (#NN) only inside the override block', () => {
  const body = ['BEGIN_COMMIT_OVERRIDE', 'feat(vault): x', 'END_COMMIT_OVERRIDE', 'feat(other): untouched'].join('\n');
  const out = rewriteOverrideRefs(body, 42);
  assert.match(out, /feat\(vault\): x \(#42\)/);
  assert.match(out, /feat\(other\): untouched$/m);
  assert.doesNotMatch(out, /untouched \(#42\)/);
  assert.equal(rewriteOverrideRefs(body, null), body); // no PR number → unchanged
});

// ── integration: real git against a local bare-repo "origin" ─────────────────
function g(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function configIdentity(repo) {
  g(repo, 'config', 'user.email', 'verify@local');
  g(repo, 'config', 'user.name', 'verify');
  g(repo, 'config', 'commit.gpgsign', 'false');
}

// Bare repo standing in for GitHub origin, seeded with a small SDK tree.
function setupOrigin() {
  const root = mkdtempSync(join(tmpdir(), 'obp-'));
  const origin = join(root, 'origin.git');
  mkdirSync(origin);
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });

  const seed = join(root, 'seed');
  execFileSync('git', ['clone', origin, seed], { stdio: 'ignore' });
  configIdentity(seed);
  for (const dir of ['src/workos/vault', 'src/workos/sso', 'src/workos/common']) {
    mkdirSync(join(seed, dir), { recursive: true });
  }
  writeFileSync(join(seed, 'src/workos/vault/client.py'), 'base\n');
  writeFileSync(join(seed, 'src/workos/sso/client.py'), 'base\n');
  writeFileSync(join(seed, 'README.md'), 'base\n');
  g(seed, 'add', '-A');
  g(seed, 'commit', '-m', 'base');
  g(seed, 'push', 'origin', 'main');
  return { root, origin };
}

// A fresh clone simulates an independent CI dispatch (checked out on main).
function freshClone(root, origin, name) {
  const work = join(root, name);
  execFileSync('git', ['clone', origin, work], { stdio: 'ignore' });
  configIdentity(work);
  return work;
}

function runScript(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function originBranchCount(origin, branch) {
  return g(origin, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`)
    .split('\n')
    .filter(Boolean).length;
}

test('empty scoped diff → exit 0, no commit, no PR, no branch pushed (FR-2.7)', () => {
  const { root, origin } = setupOrigin();
  try {
    const work = freshClone(root, origin, 'work'); // no working-tree changes
    const r = runScript(['--batch-id', 'empty1', '--lang', 'python', '--services', 'Vault', '--sdk-dir', work, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skipping PR/);
    assert.doesNotMatch(r.stdout, /DRY-RUN gh pr create/);
    assert.equal(originBranchCount(origin, 'oagen/batch-empty1'), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only no-op files (.oagen-manifest.json + .last-synced-sha) → skip, no PR', () => {
  const { root, origin } = setupOrigin();
  try {
    const work = freshClone(root, origin, 'work');
    // Mimic the workflow: the manifest churns and .last-synced-sha is always
    // copied in, but no service code changed.
    writeFileSync(join(work, '.oagen-manifest.json'), '{"files":["x"]}\n');
    writeFileSync(join(work, '.last-synced-sha'), 'deadbeef\n');
    const r = runScript(['--batch-id', 'noop1', '--lang', 'python', '--services', 'Vault', '--sdk-dir', work, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skipping PR/);
    assert.doesNotMatch(r.stdout, /DRY-RUN gh pr create/);
    assert.equal(originBranchCount(origin, 'oagen/batch-noop1'), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('branch is oagen/batch-<id> and is pushed to origin', () => {
  const { root, origin } = setupOrigin();
  try {
    const work = freshClone(root, origin, 'work');
    writeFileSync(join(work, 'src/workos/vault/client.py'), 'changed\n');
    const r = runScript(['--batch-id', 'br1', '--lang', 'python', '--services', 'Vault', '--sdk-dir', work, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /oagen\/batch-br1/);
    assert.equal(originBranchCount(origin, 'oagen/batch-br1'), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('idempotent re-run: same batch_id → single force-updated branch (NFR-2.2)', () => {
  const { root, origin } = setupOrigin();
  try {
    const work1 = freshClone(root, origin, 'work1');
    writeFileSync(join(work1, 'src/workos/vault/client.py'), 'changed-1\n');
    assert.equal(runScript(['--batch-id', 'dup1', '--lang', 'python', '--services', 'Vault', '--sdk-dir', work1, '--dry-run']).code, 0);

    // A second independent dispatch (fresh clone of origin's main).
    const work2 = freshClone(root, origin, 'work2');
    writeFileSync(join(work2, 'src/workos/vault/client.py'), 'changed-2\n');
    assert.equal(runScript(['--batch-id', 'dup1', '--lang', 'python', '--services', 'Vault', '--sdk-dir', work2, '--dry-run']).code, 0);

    // Exactly one branch on origin, force-updated to run 2's content.
    assert.equal(originBranchCount(origin, 'oagen/batch-dup1'), 1);
    assert.equal(g(origin, 'show', 'oagen/batch-dup1:src/workos/vault/client.py'), 'changed-2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('confinement: only the (already scoped) changed paths land on the branch', () => {
  const { root, origin } = setupOrigin();
  try {
    const work = freshClone(root, origin, 'work');
    // Simulate `oagen generate --services Vault`: only vault + shared change.
    writeFileSync(join(work, 'src/workos/vault/client.py'), 'scoped\n');
    mkdirSync(join(work, 'src/workos/common'), { recursive: true });
    writeFileSync(join(work, 'src/workos/common/util.py'), 'scoped\n');
    const r = runScript(['--batch-id', 'conf1', '--lang', 'python', '--services', 'Vault', '--sdk-dir', work, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);

    const files = g(origin, 'diff', '--name-only', 'main', 'oagen/batch-conf1').split('\n').filter(Boolean).sort();
    assert.deepEqual(files, ['src/workos/common/util.py', 'src/workos/vault/client.py']);
    assert.ok(!files.includes('src/workos/sso/client.py'), 'out-of-scope sso must not appear');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--dry-run prints the gh pr create command with the batch title', () => {
  const { root, origin } = setupOrigin();
  try {
    const work = freshClone(root, origin, 'work');
    writeFileSync(join(work, 'src/workos/vault/client.py'), 'x\n');
    const r = runScript(['--batch-id', 't9', '--lang', 'python', '--services', 'Vault,SSO', '--sdk-dir', work, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /DRY-RUN gh pr create/);
    assert.match(r.stdout, /feat\(generated\): Vault, SSO \(batch t9\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-entry ordered commits + shared catch-all over the scoped diff', () => {
  const { root, origin } = setupOrigin();
  try {
    const work = freshClone(root, origin, 'work');
    writeFileSync(join(work, 'src/workos/vault/client.py'), 'v\n');
    writeFileSync(join(work, 'src/workos/sso/client.py'), 's\n');
    writeFileSync(join(work, 'README.md'), 'shared\n'); // unattributed → catch-all

    const entries = [
      { prefix: 'feat', scope: 'vault', summary: 'add object', file_paths: ['src/workos/vault/client.py'] },
      { prefix: 'fix', scope: 'sso', summary: 'fix conn', file_paths: ['src/workos/sso/client.py'] },
    ];
    const entriesFile = join(root, 'entries.json'); // OUTSIDE the work tree
    writeFileSync(entriesFile, JSON.stringify(entries));

    const r = runScript([
      '--batch-id', 'pe1', '--lang', 'python', '--services', 'Vault,SSO',
      '--sdk-dir', work, '--entries-file', entriesFile, '--dry-run',
    ]);
    assert.equal(r.code, 0, r.stderr);

    const log = g(origin, 'log', '--format=%s', 'main..oagen/batch-pe1').split('\n').filter(Boolean);
    assert.deepEqual(log, [
      'chore(generated): shared regenerated files',
      'fix(sso): fix conn',
      'feat(vault): add object',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
