import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { markerCommit, parseArgs, previousSpecCommit, resolveSpecBaseline, sdkSyncedSha } from '../resolve-spec-baseline.mjs';

const SCRIPT = fileURLToPath(new URL('../resolve-spec-baseline.mjs', import.meta.url));

// Upstream shas the marker holds, one per spec sync.
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_UNKNOWN = 'f'.repeat(40);

function g(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function initRepo(root, name) {
  const repo = join(root, name);
  mkdirSync(repo);
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  g(repo, 'config', 'user.email', 'verify@local');
  g(repo, 'config', 'user.name', 'verify');
  g(repo, 'config', 'commit.gpgsign', 'false');
  return repo;
}

function commit(repo, files, message) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  g(repo, 'add', '-A');
  g(repo, 'commit', '-m', message);
  return g(repo, 'rev-parse', 'HEAD');
}

// An openapi-spec history shaped like the real one: each sync commit moves the
// spec and the marker together, with a release commit (touching neither) after
// each. Returns the sync commits by the marker they introduced.
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'rsb-'));
  const spec = initRepo(root, 'openapi-spec');
  const sync = (sha, body) =>
    commit(spec, { 'spec/open-api-spec.yaml': body, '.last-synced-sha': `${sha}\n` }, `Update OpenAPI spec (${sha.slice(0, 7)})`);
  const release = (version) => commit(spec, { 'package.json': `{"version":"${version}"}\n` }, `chore: release v${version}`);

  const commits = {};
  commits.a = sync(SHA_A, 'paths: {a: 1}\n');
  release('0.1.0');
  commits.b = sync(SHA_B, 'paths: {a: 1, b: 2}\n');
  release('0.2.0');
  commits.c = sync(SHA_C, 'paths: {a: 1, b: 2, c: 3}\n');
  release('0.3.0');

  const sdk = initRepo(root, 'workos-python');
  commit(sdk, { 'client.py': 'base\n' }, 'init');
  return { root, spec, sdk, commits };
}

function withRepos(fn) {
  const repos = setup();
  try {
    fn(repos);
  } finally {
    rmSync(repos.root, { recursive: true, force: true });
  }
}

test('an SDK several syncs behind diffs from the spec it was generated from', () => {
  withRepos(({ spec, sdk, commits }) => {
    commit(sdk, { '.last-synced-sha': `${SHA_A}\n` }, 'batch');
    const result = resolveSpecBaseline({ sdkDir: sdk, specRepo: spec });
    assert.deepEqual(result, { commit: commits.a, source: 'sdk-marker', synced: SHA_A, reason: '' });
    // The former behavior would have started one sync back, hiding sync B.
    assert.equal(previousSpecCommit(spec), commits.b);
    assert.notEqual(result.commit, commits.b);
  });
});

test('an SDK already on the current spec gets an empty diff window', () => {
  withRepos(({ spec, sdk, commits }) => {
    commit(sdk, { '.last-synced-sha': `${SHA_C}\n` }, 'batch');
    const result = resolveSpecBaseline({ sdkDir: sdk, specRepo: spec });
    assert.equal(result.source, 'sdk-marker');
    assert.equal(result.commit, commits.c);
    // Same spec as HEAD: re-announcing the last sync's changes would be wrong.
    assert.equal(g(spec, 'diff', '--name-only', result.commit, 'HEAD', '--', 'spec/open-api-spec.yaml'), '');
  });
});

test('markerCommit picks the sync that introduced the value, not the one that replaced it', () => {
  withRepos(({ spec, commits }) => {
    assert.equal(markerCommit(spec, SHA_A), commits.a);
    assert.equal(markerCommit(spec, SHA_B), commits.b);
    assert.equal(markerCommit(spec, SHA_C), commits.c);
    assert.equal(markerCommit(spec, SHA_UNKNOWN), '');
  });
});

test('the committed marker wins over a working-tree marker the workflow has overwritten', () => {
  withRepos(({ spec, sdk, commits }) => {
    commit(sdk, { '.last-synced-sha': `${SHA_A}\n` }, 'batch');
    writeFileSync(join(sdk, '.last-synced-sha'), `${SHA_C}\n`); // not committed
    assert.equal(sdkSyncedSha(sdk), SHA_A);
    assert.equal(resolveSpecBaseline({ sdkDir: sdk, specRepo: spec }).commit, commits.a);
  });
});

test('an SDK with no marker falls back to the previous spec commit', () => {
  withRepos(({ spec, sdk, commits }) => {
    const result = resolveSpecBaseline({ sdkDir: sdk, specRepo: spec });
    assert.equal(result.source, 'previous-spec-commit');
    assert.equal(result.commit, commits.b);
    assert.equal(result.synced, '');
    assert.match(result.reason, /no committed \.last-synced-sha/);
  });
});

test('a marker that is not a sha is treated as no marker', () => {
  withRepos(({ spec, sdk, commits }) => {
    commit(sdk, { '.last-synced-sha': 'not a sha; rm -rf\n' }, 'batch');
    assert.equal(sdkSyncedSha(sdk), '');
    assert.equal(resolveSpecBaseline({ sdkDir: sdk, specRepo: spec }).commit, commits.b);
  });
});

test('a marker this checkout has never seen falls back and says why', () => {
  withRepos(({ spec, sdk, commits }) => {
    commit(sdk, { '.last-synced-sha': `${SHA_UNKNOWN}\n` }, 'batch');
    const result = resolveSpecBaseline({ sdkDir: sdk, specRepo: spec });
    assert.equal(result.source, 'previous-spec-commit');
    assert.equal(result.commit, commits.b);
    assert.equal(result.synced, SHA_UNKNOWN);
    assert.match(result.reason, new RegExp(SHA_UNKNOWN));
  });
});

test('a spec repo with a single spec commit has no baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'rsb-'));
  try {
    const spec = initRepo(root, 'openapi-spec');
    commit(spec, { 'spec/open-api-spec.yaml': 'paths: {}\n', '.last-synced-sha': `${SHA_A}\n` }, 'first');
    const sdk = initRepo(root, 'workos-python');
    commit(sdk, { 'client.py': 'base\n' }, 'init');
    assert.deepEqual(resolveSpecBaseline({ sdkDir: sdk, specRepo: spec }).source, 'none');
    assert.equal(resolveSpecBaseline({ sdkDir: sdk, specRepo: spec }).commit, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseArgs requires --sdk-dir and rejects unknown options', () => {
  assert.throws(() => parseArgs(['node', 'x']), /Usage/);
  assert.throws(() => parseArgs(['node', 'x', '--sdk-dir', 's', '--nope']), /Unknown option/);
  assert.equal(parseArgs(['node', 'x', '--sdk-dir', 's', '--spec-repo', 'r']).specRepo, 'r');
});

// ── CLI: stdout is the sha alone; annotations go to stderr ───────────────────
function runScript(args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', ...env } });
}

test('CLI prints only the commit on stdout and annotates the window on stderr', () => {
  withRepos(({ root, spec, sdk, commits }) => {
    commit(sdk, { '.last-synced-sha': `${SHA_A}\n` }, 'batch');
    const outputFile = join(root, 'github-output');
    writeFileSync(outputFile, '');
    const result = runScript(['--sdk-dir', sdk, '--spec-repo', spec], { GITHUB_OUTPUT: outputFile });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${commits.a}\n`);
    assert.match(result.stderr, /^::notice title=Spec diff baseline::/);
    assert.match(result.stderr, /\(2 spec commit\(s\) behind HEAD\)/);
    assert.equal(readFileSync(outputFile, 'utf8'), `baseline_commit=${commits.a}\nbaseline_source=sdk-marker\n`);
  });
});

test('CLI warns when it has to fall back', () => {
  withRepos(({ spec, sdk, commits }) => {
    const result = runScript(['--sdk-dir', sdk, '--spec-repo', spec]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${commits.b}\n`);
    assert.match(result.stderr, /^::warning title=Spec diff baseline::Diffing only the latest spec commit/);
  });
});
