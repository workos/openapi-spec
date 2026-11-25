#!/usr/bin/env node
//
// resolve-spec-baseline.mjs
//
// Picks the openapi-spec commit a batch's spec diff starts from: the spec the
// SDK was last generated from, rather than the spec commit just before HEAD.
//
// A batch regenerates an SDK from wherever that SDK stands up to the current
// spec, and an SDK is routinely many spec commits behind (18 on 2026-11-24).
// Diffing only the latest spec commit described a fraction of what the batch
// generated: the rest reached the changelog and the PR title only where a
// language's compat report happened to flag it as breaking, so one batch opened
// eight PRs naming different scopes and every additive change in between went
// unreported.
//
// Every merged batch PR copies openapi-spec's `.last-synced-sha` into the SDK
// (generate-prs.yml, "Create batch PR on live SDK"), so the SDK's committed
// marker names the spec it holds. This maps that marker back to the
// openapi-spec commit that introduced it.
//
// Fails open to the previous spec-changing commit (the former behavior) when
// the SDK carries no marker or names one this checkout cannot see, and says so
// on stderr as a workflow annotation. stdout is the commit sha alone (empty
// when there is no earlier spec at all), so a shell can capture it.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MARKER = '.last-synced-sha';
const DEFAULT_SPEC_PATH = 'spec/open-api-spec.yaml';

// A failed lookup (no such file at that rev, not a repo) is an expected answer
// here, not an error: every caller treats '' as "not found".
function git(cwd, gitArgs) {
  try {
    return execFileSync('git', ['-C', cwd, ...gitArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// The marker as COMMITTED on the SDK's checked-out branch. The working tree is
// not trusted: by the time this runs the SDK has been regenerated in place, and
// a later step overwrites the file with the new marker.
export function sdkSyncedSha(sdkDir) {
  const value = git(sdkDir, ['show', `HEAD:${MARKER}`]);
  return /^[0-9a-f]{7,64}$/i.test(value) ? value : '';
}

// The openapi-spec commit whose marker first took `synced`. `git log -S` lists
// the commits where that value appears or disappears, newest first; walk them
// oldest-first and keep the first whose marker really holds it (the other one
// is the sync that replaced it).
export function markerCommit(specRepo, synced) {
  const commits = git(specRepo, ['log', '--format=%H', `-S${synced}`, '--', MARKER])
    .split('\n')
    .filter(Boolean)
    .reverse();
  return commits.find((commit) => git(specRepo, ['show', `${commit}:${MARKER}`]) === synced) ?? '';
}

export function previousSpecCommit(specRepo, specPath = DEFAULT_SPEC_PATH) {
  return git(specRepo, ['log', '--skip=1', '-1', '--format=%H', '--', specPath]);
}

// → { commit, source, synced, reason }
//   source 'sdk-marker'            commit is the spec the SDK was generated from
//   source 'previous-spec-commit'  fallback; `reason` says why
//   source 'none'                  no earlier spec exists (commit is '')
export function resolveSpecBaseline({ sdkDir, specRepo, specPath = DEFAULT_SPEC_PATH }) {
  const synced = sdkDir ? sdkSyncedSha(sdkDir) : '';
  let reason = `the SDK has no committed ${MARKER}`;
  if (synced) {
    const commit = markerCommit(specRepo, synced);
    if (commit) return { commit, source: 'sdk-marker', synced, reason: '' };
    reason = `the SDK is synced to ${synced}, which no commit in this openapi-spec checkout's history introduced`;
  }
  const commit = previousSpecCommit(specRepo, specPath);
  return commit
    ? { commit, source: 'previous-spec-commit', synced, reason }
    : { commit: '', source: 'none', synced, reason };
}

export function parseArgs(argv) {
  const args = { sdkDir: '', specRepo: process.cwd(), specPath: DEFAULT_SPEC_PATH };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sdk-dir') args.sdkDir = argv[++i] ?? '';
    else if (arg === '--spec-repo') args.specRepo = argv[++i] ?? '';
    else if (arg === '--spec-path') args.specPath = argv[++i] ?? '';
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!args.sdkDir || !args.specRepo || !args.specPath) {
    throw new Error('Usage: resolve-spec-baseline.mjs --sdk-dir <path> [--spec-repo <path>] [--spec-path <path>]');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const result = resolveSpecBaseline(args);

  if (result.source === 'sdk-marker') {
    const pending = git(args.specRepo, ['rev-list', '--count', `${result.commit}..HEAD`, '--', args.specPath]);
    process.stderr.write(
      `::notice title=Spec diff baseline::Diffing from openapi-spec@${result.commit.slice(0, 7)}, ` +
        `the spec this SDK was last generated from (${pending || '?'} spec commit(s) behind HEAD).\n`,
    );
  } else if (result.source === 'previous-spec-commit') {
    process.stderr.write(
      `::warning title=Spec diff baseline::Diffing only the latest spec commit because ${result.reason}. ` +
        'The changelog may not cover everything this batch generates.\n',
    );
  } else {
    process.stderr.write(`::warning title=Spec diff baseline::No earlier spec commit found (${result.reason}).\n`);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `baseline_commit=${result.commit}\nbaseline_source=${result.source}\n`);
  }
  process.stdout.write(`${result.commit}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
