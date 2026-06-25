import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  batchBranchName,
  catchAllMessage,
  entryHeadline,
  orderedEntries,
  parseServices,
  prTitle,
  rewriteOverrideRefs,
} from '../open-batch-pr.mjs';

// A conventional-commit title must start with a valid type, an optional
// (scope), an optional ! and then ": " — this is what each SDK repo's
// lint_pr_title / "Validate PR title" check enforces.
const CONVENTIONAL_TITLE = /^(feat|fix|chore)(\([^)]+\))?!?: \S/;

const SCRIPT = fileURLToPath(new URL('../open-batch-pr.mjs', import.meta.url));

// ── pure helpers (no git) ────────────────────────────────────────────────────
test('batchBranchName is deterministic', () => {
  assert.equal(batchBranchName('abc'), 'oagen/batch-abc');
});

test('prTitle with no entries falls back to services; empty → all services', () => {
  assert.equal(prTitle('Vault, SSO', 'b1'), 'feat(generated): Vault, SSO (batch b1)');
  assert.equal(prTitle('Vault, SSO', 'b1', []), 'feat(generated): Vault, SSO (batch b1)');
  assert.equal(prTitle('', 'b1'), 'feat(generated): all services (batch b1)');
  // Even the fallback titles are valid conventional-commit titles.
  assert.match(prTitle('Vault, SSO', 'b1'), CONVENTIONAL_TITLE);
  assert.match(prTitle('', 'b1'), CONVENTIONAL_TITLE);
});

test('prTitle with a single entry uses that entry summary', () => {
  const entries = [{ prefix: 'feat', scope: 'organization_membership', summary: 'Add `roles` to organization membership models' }];
  assert.equal(
    prTitle('OrganizationMembership', 'e471ddef', entries),
    'feat(generated): Add `roles` to organization membership models',
  );
  assert.match(prTitle('OrganizationMembership', 'e471ddef', entries), CONVENTIONAL_TITLE);
});

test('prTitle with multiple entries leads with the top entry and counts the rest', () => {
  const entries = [
    { prefix: 'feat', scope: 'sso', summary: 'Add SSO API surface' },
    { prefix: 'fix', scope: 'vault', summary: 'Change vault response' },
    { prefix: 'chore', scope: 'events', summary: 'Update events' },
  ];
  assert.equal(prTitle('SSO,Vault,Events', 'b2', entries), 'feat(generated): Add SSO API surface (+2 more)');
  assert.match(prTitle('SSO,Vault,Events', 'b2', entries), CONVENTIONAL_TITLE);
});

test('prTitle rolls the type up feat! → feat → fix and orders by it', () => {
  // A breaking entry promotes the whole title to feat(generated)! and leads it,
  // matching how the changelog override block's rollup type is computed.
  const breaking = [
    { prefix: 'fix', scope: 'vault', summary: 'Change vault response' },
    { prefix: 'feat!', scope: 'sso', summary: 'Remove SSO API surface' },
  ];
  assert.equal(prTitle('Vault,SSO', 'b3', breaking), 'feat(generated)!: Remove SSO API surface (+1 more)');
  assert.match(prTitle('Vault,SSO', 'b3', breaking), CONVENTIONAL_TITLE);

  // No feat at all → fix(generated).
  const fixesOnly = [{ prefix: 'fix', scope: 'vault', summary: 'Change vault response' }];
  assert.equal(prTitle('Vault', 'b4', fixesOnly), 'fix(generated): Change vault response');
  assert.match(prTitle('Vault', 'b4', fixesOnly), CONVENTIONAL_TITLE);

  // chore-only rolls up to fix(generated), mirroring rollupForEntries exactly
  // (which never returns chore) so the title type matches the changelog override.
  const choreOnly = [{ prefix: 'chore', scope: 'events', summary: 'Regenerate boilerplate' }];
  assert.equal(prTitle('Events', 'b5', choreOnly), 'fix(generated): Regenerate boilerplate');
  assert.match(prTitle('Events', 'b5', choreOnly), CONVENTIONAL_TITLE);
});

test('prTitle falls back gracefully on malformed entries (never throws or emits undefined)', () => {
  // Entries present but no recognized prefix → fall back to the batch title.
  const unrecognized = [{ prefix: 'docs', scope: 'readme', summary: 'Tweak docs' }];
  assert.equal(prTitle('Vault', 'b6', unrecognized), 'feat(generated): Vault (batch b6)');
  assert.match(prTitle('Vault', 'b6', unrecognized), CONVENTIONAL_TITLE);

  // Recognized prefix but missing summary → fall back rather than emit `undefined`.
  const noSummary = [{ prefix: 'feat', scope: 'sso' }];
  const title = prTitle('SSO', 'b7', noSummary);
  assert.equal(title, 'feat(generated): SSO (batch b7)');
  assert.doesNotMatch(title, /undefined/);
  assert.match(title, CONVENTIONAL_TITLE);
});

test('catchAllMessage names the services and stays a chore(...) prefix', () => {
  assert.equal(catchAllMessage('Vault, SSO'), 'chore(generated): regenerate shared files for Vault, SSO');
  assert.equal(catchAllMessage(''), 'chore(generated): regenerate shared files for all services');
  assert.match(catchAllMessage('Vault'), /^chore(\([^)]+\))?: \S/);
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

test('--dry-run prints the gh pr create command with the fallback batch title (no entries)', () => {
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

test('--dry-run derives a descriptive PR title from the classify entries', () => {
  const { root, origin } = setupOrigin();
  try {
    const work = freshClone(root, origin, 'work');
    writeFileSync(join(work, 'src/workos/vault/client.py'), 'x\n');
    const entries = [
      { prefix: 'feat', scope: 'vault', summary: 'Add `roles` to vault models', file_paths: ['src/workos/vault/client.py'] },
      { prefix: 'fix', scope: 'sso', summary: 'Change SSO response' },
    ];
    const entriesFile = join(root, 'title-entries.json'); // OUTSIDE the work tree
    writeFileSync(entriesFile, JSON.stringify(entries));

    const r = runScript([
      '--batch-id', 't10', '--lang', 'python', '--services', 'Vault,SSO',
      '--sdk-dir', work, '--entries-file', entriesFile, '--dry-run',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /DRY-RUN gh pr create/);
    // Title is entry-derived, not the generic services/batch fallback.
    assert.match(r.stdout, /feat\(generated\): Add `roles` to vault models \(\+1 more\)/);
    assert.doesNotMatch(r.stdout, /Vault, SSO \(batch t10\)/);
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
      'chore(generated): regenerate shared files for Vault, SSO',
      'fix(sso): fix conn',
      'feat(vault): add object',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
