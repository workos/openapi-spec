#!/usr/bin/env node
//
// Rebuild one or more historical spec-change manifests with the CURRENT
// checkout's oagen version, policy bundle, and build-spec-changes.mjs.
//
// Safe default (prints manifests, does not POST):
//   node scripts/replay-spec-changes.mjs \
//     --shas "<full-sha>,<full-sha>" \
//     --repository workos/openapi-spec
//
// Posting requires both an explicit flag and confirmation. The caller must
// provide SPEC_CHANGES_SECRET and the configured replay Tailscale context only
// for this mode (CI uses --prepare-delivery then an isolated delivery job):
//   node scripts/replay-spec-changes.mjs \
//     --shas "<full-sha>,<full-sha>" \
//     --repository workos/openapi-spec \
//     --bot-url https://sdk-automation-bot.workos.tools \
//     --push --confirm REPLAY_SPEC_CHANGES
//
// The SDK bot upserts manifests by sha, so replaying the same target is
// idempotent. No historical scripts or policy files are checked out: only the
// old/new spec documents come from the target commit and its first parent.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PUSH_CONFIRMATION = "REPLAY_SPEC_CHANGES";
const SPEC_PATH = "spec/open-api-spec.yaml";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

export function parseTargetShas(value) {
  const shas = String(value ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((sha) => sha.toLowerCase());

  if (shas.length === 0) {
    throw new Error(
      "At least one explicit, full 40-character target SHA is required",
    );
  }

  for (const sha of shas) {
    if (!FULL_SHA.test(sha)) {
      throw new Error(
        `Invalid target SHA "${sha}"; refs, ranges, and abbreviated SHAs are not accepted`,
      );
    }
  }

  if (new Set(shas).size !== shas.length) {
    throw new Error("Duplicate target SHAs are not accepted");
  }

  return shas;
}

export function firstParentFromRevList(line, targetSha) {
  const parts = String(line ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts[0]?.toLowerCase() !== targetSha.toLowerCase()) {
    throw new Error(`Could not resolve parents for target ${targetSha}`);
  }
  if (!parts[1] || !FULL_SHA.test(parts[1])) {
    throw new Error(`Target ${targetSha} has no usable first parent`);
  }
  return parts[1].toLowerCase();
}

export function pullRequestMetadata(subject, repository) {
  const match = String(subject ?? "").match(/#([0-9]+)/);
  if (!match) return {};
  if (!GITHUB_REPOSITORY.test(repository ?? "")) {
    throw new Error(
      "A repository in owner/name form is required to attach PR metadata",
    );
  }
  return {
    prNumber: match[1],
    prUrl: `https://github.com/${repository}/pull/${match[1]}`,
  };
}

export function parseArgs(argv) {
  const args = {
    shas: "",
    repository: process.env.GITHUB_REPOSITORY ?? "",
    botUrl: process.env.SDK_BOT_URL ?? "",
    push: false,
    confirm: "",
    prepareDelivery: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--shas") args.shas = argv[++i] ?? "";
    else if (arg === "--repository") args.repository = argv[++i] ?? "";
    else if (arg === "--bot-url") args.botUrl = argv[++i] ?? "";
    else if (arg === "--push") args.push = true;
    else if (arg === "--prepare-delivery") args.prepareDelivery = argv[++i] ?? "";
    else if (arg === "--confirm") args.confirm = argv[++i] ?? "";
    else throw new Error(`Unknown option: ${arg}`);
  }

  args.targetShas = parseTargetShas(args.shas);

  if (!GITHUB_REPOSITORY.test(args.repository)) {
    throw new Error("--repository in owner/name form is required");
  }

  if (args.push && args.prepareDelivery) throw new Error("Choose --push or --prepare-delivery, not both");
  if (args.push || args.prepareDelivery) {
    if (args.confirm !== PUSH_CONFIRMATION) {
      throw new Error(
        `Refusing to POST without --confirm ${PUSH_CONFIRMATION}`,
      );
    }
  }
  if (args.push) {
    if (!args.botUrl) {
      throw new Error("--bot-url (or SDK_BOT_URL) is required with --push");
    }
    const endpoint = new URL("/internal/spec-changes", args.botUrl);
    if (endpoint.protocol !== "https:") {
      throw new Error("The spec-changes endpoint must use HTTPS");
    }
    if (endpoint.href !== "https://sdk-automation-bot.workos.tools/internal/spec-changes") {
      throw new Error("Confirmed replay delivery supports only the fixed SDK bot endpoint");
    }
    args.endpoint = endpoint;
  }

  return args;
}

function run(command, commandArgs, options = {}) {
  const { allowedExitCodes = [0], ...spawnOptions } = options;
  const result = spawnSync(command, commandArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    ...spawnOptions,
  });
  if (result.error) throw result.error;
  if (!allowedExitCodes.includes(result.status)) {
    const detail = String(result.stderr ?? "").trim();
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed with exit code ${result.status}` +
        (detail ? `: ${detail}` : ""),
    );
  }
  return result;
}

function git(args, options = {}) {
  return run("git", ["-C", REPO_ROOT, ...args], options);
}

function validateTarget(targetSha) {
  const resolved = git([
    "rev-parse",
    "--verify",
    `${targetSha}^{commit}`,
  ]).stdout.trim().toLowerCase();
  if (resolved !== targetSha) {
    throw new Error(`Target ${targetSha} did not resolve to itself`);
  }

  const ancestry = git(
    ["merge-base", "--is-ancestor", targetSha, "HEAD"],
    { allowedExitCodes: [0, 1] },
  );
  if (ancestry.status !== 0) {
    throw new Error(
      `Target ${targetSha} is not an ancestor of the current checkout`,
    );
  }

  const firstParentHistory = new Set(
    git(["rev-list", "--first-parent", "HEAD"]).stdout
      .trim()
      .split(/\s+/)
      .map((sha) => sha.toLowerCase()),
  );
  if (!firstParentHistory.has(targetSha)) {
    throw new Error(
      `Target ${targetSha} is not on the current checkout's first-parent history`,
    );
  }

  const parentLine = git([
    "rev-list",
    "--parents",
    "-n",
    "1",
    targetSha,
  ]).stdout;
  const parentSha = firstParentFromRevList(parentLine, targetSha);

  for (const revision of [parentSha, targetSha]) {
    git(["cat-file", "-e", `${revision}:${SPEC_PATH}`]);
  }

  const specDiff = git(
    ["diff", "--quiet", parentSha, targetSha, "--", SPEC_PATH],
    { allowedExitCodes: [0, 1] },
  );
  if (specDiff.status === 0) {
    throw new Error(
      `Target ${targetSha} does not change ${SPEC_PATH} from its first parent`,
    );
  }

  return parentSha;
}

function writeGitFile(revision, path, outputPath) {
  const contents = git(["show", `${revision}:${path}`], {
    encoding: "buffer",
  }).stdout;
  writeFileSync(outputPath, contents);
}

function buildManifest(targetSha, tempRoot, repository) {
  const parentSha = validateTarget(targetSha);
  const targetDir = join(tempRoot, targetSha);
  mkdirSync(targetDir);

  const oldSpec = join(targetDir, "previous-open-api-spec.yaml");
  const newSpec = join(targetDir, "current-open-api-spec.yaml");
  const reportPath = join(targetDir, "diff-report.json");
  const oldIrPath = join(targetDir, "previous-ir.json");
  const newIrPath = join(targetDir, "current-ir.json");

  writeGitFile(parentSha, SPEC_PATH, oldSpec);
  writeGitFile(targetSha, SPEC_PATH, newSpec);

  const oagen = join(
    REPO_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "oagen.cmd" : "oagen",
  );
  if (!existsSync(oagen)) {
    throw new Error(
      "oagen is not installed; run `npm ci` before replaying manifests",
    );
  }
  const runOagen = (args, options = {}) =>
    run("npx", ["--no-install", "oagen", ...args], options);

  // oagen diff uses 0/1/2 for no/additive/breaking results. The JSON summary
  // remains the authoritative validity check.
  const diff = runOagen(["diff", "--old", oldSpec, "--new", newSpec], {
    allowedExitCodes: [0, 1, 2],
  });
  let report;
  try {
    report = JSON.parse(diff.stdout);
  } catch {
    throw new Error(`oagen diff returned invalid JSON for ${targetSha}`);
  }
  if (!report?.summary || !Array.isArray(report?.changes)) {
    throw new Error(`oagen diff returned an invalid report for ${targetSha}`);
  }
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`, "utf8");

  const oldIr = runOagen(["parse", "--spec", oldSpec]).stdout;
  const newIr = runOagen(["parse", "--spec", newSpec]).stdout;
  JSON.parse(oldIr);
  JSON.parse(newIr);
  writeFileSync(oldIrPath, oldIr, "utf8");
  writeFileSync(newIrPath, newIr, "utf8");

  const subject = git(["show", "-s", "--format=%s", targetSha]).stdout.trim();
  const timestamp = git([
    "show",
    "-s",
    "--format=%cI",
    targetSha,
  ]).stdout.trim();
  const pr = pullRequestMetadata(subject, repository);

  const builderArgs = [
    join(SCRIPT_DIR, "build-spec-changes.mjs"),
    "--report",
    reportPath,
    "--old-ir",
    oldIrPath,
    "--new-ir",
    newIrPath,
    "--sha",
    targetSha,
    "--parent-sha",
    parentSha,
    "--timestamp",
    timestamp,
    "--commit-message",
    subject,
  ];
  if (pr.prNumber) {
    builderArgs.push(
      "--pr-number",
      pr.prNumber,
      "--pr-url",
      pr.prUrl,
    );
  }

  const builder = run(process.execPath, builderArgs);
  if (builder.stderr) process.stderr.write(builder.stderr);
  const manifestText = builder.stdout;
  const manifest = JSON.parse(manifestText);
  if (
    manifest.sha?.toLowerCase() !== targetSha ||
    manifest.parentSha?.toLowerCase() !== parentSha
  ) {
    throw new Error(`Builder returned mismatched revision metadata for ${targetSha}`);
  }

  return { manifest, manifestText, parentSha, subject };
}

// Export exact bytes as data for the isolated, dependency-free delivery job.
// This function also serves --push, so replay has no direct fetch fallback.
export function writeDelivery(directory, targetShas, rebuilt) {
  if (existsSync(directory)) throw new Error("Delivery directory must not already exist");
  const selected = targetShas.flatMap((sha, index) => {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid replay delivery target SHA");
    const entry = rebuilt[index];
    const manifest = JSON.parse(entry.manifestText);
    if (manifest.sha !== sha) throw new Error("Replay delivery SHA mismatch");
    if (!Array.isArray(manifest.changedServices)) throw new Error("Invalid changed-services manifest");
    return manifest.changedServices.length === 0 ? [] : [{ sha, text: entry.manifestText }];
  });
  mkdirSync(directory, { recursive: true });
  for (const { sha, text } of selected) {
    writeFileSync(join(directory, `${sha}.json`), text);
  }
  writeFileSync(join(directory, "index.json"), JSON.stringify(selected.map(entry => entry.sha)));
  return selected.length;
}

async function main() {
  const args = parseArgs(process.argv);

  const policyBundle = join(REPO_ROOT, "dist", "policy.mjs");
  if (!existsSync(policyBundle)) {
    throw new Error(
      "Current policy bundle is missing; run `npm run build:policy` first",
    );
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "spec-change-replay-"));
  try {
    // Preflight every target before the first POST. A malformed later target
    // must not leave an otherwise avoidable partial replay.
    const rebuilt = args.targetShas.map((targetSha) =>
      buildManifest(
        targetSha,
        tempRoot,
        args.repository,
      ),
    );

    for (let index = 0; index < args.targetShas.length; index += 1) {
      const targetSha = args.targetShas[index];
      const { manifestText, parentSha, subject } = rebuilt[index];
      process.stdout.write(
        `\nManifest for ${targetSha} (${subject})\n` +
          `First parent: ${parentSha}\n${manifestText}`,
      );
      if (!args.push && !args.prepareDelivery) process.stdout.write("Dry run: manifest was not posted.\n");
    }

    if (!args.push && !args.prepareDelivery) return;

    const deliveryDir = args.prepareDelivery
      ? resolve(args.prepareDelivery) : join(tempRoot, "delivery");
    const count = writeDelivery(deliveryDir, args.targetShas, rebuilt);
    if (args.prepareDelivery) {
      process.stdout.write(`Prepared ${count} manifest(s) for isolated delivery; nothing was posted.\n`);
      return;
    }
    if (count === 0) {
      process.stdout.write("No changed services; manifest was not posted.\n");
      return;
    }
    // Legacy --push still requires explicit confirmation, but uses the same
    // guarded Tailscale transport and workflow context as isolated CI delivery.
    // There is no independent fetch implementation or direct retry path.
    const delivered = run(process.execPath, [
      join(SCRIPT_DIR, "push-spec-changes.mjs"), "--replay-dir", deliveryDir,
    ]);
    process.stdout.write(delivered.stdout);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
