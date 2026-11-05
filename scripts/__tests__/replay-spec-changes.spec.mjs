import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  firstParentFromRevList,
  parseArgs,
  parseTargetShas,
  pullRequestMetadata,
  writeManifests,
} from "../replay-spec-changes.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "B".repeat(40);

test("parseTargetShas accepts comma and whitespace separated full SHAs", () => {
  assert.deepEqual(parseTargetShas(`${SHA_A},\n ${SHA_B}`), [
    SHA_A,
    SHA_B.toLowerCase(),
  ]);
});

test("parseTargetShas rejects empty, abbreviated, ref, range, and duplicate input", () => {
  for (const value of [
    "",
    "abc123",
    "main",
    `${SHA_A}..${"b".repeat(40)}`,
    `${SHA_A},${SHA_A}`,
  ]) {
    assert.throws(() => parseTargetShas(value));
  }
});

test("firstParentFromRevList selects the first parent of a merge commit", () => {
  const parentA = "b".repeat(40);
  const parentB = "c".repeat(40);
  assert.equal(
    firstParentFromRevList(`${SHA_A} ${parentA} ${parentB}\n`, SHA_A),
    parentA,
  );
});

test("firstParentFromRevList rejects roots and mismatched output", () => {
  assert.throws(() => firstParentFromRevList(SHA_A, SHA_A));
  assert.throws(() =>
    firstParentFromRevList(`${"b".repeat(40)} ${SHA_A}`, SHA_A),
  );
});

test("pullRequestMetadata preserves PR number and repository URL", () => {
  assert.deepEqual(
    pullRequestMetadata(
      "Update OpenAPI spec (7cf31ee) (#76)",
      "workos/openapi-spec",
    ),
    {
      prNumber: "76",
      prUrl: "https://github.com/workos/openapi-spec/pull/76",
    },
  );
});

test("pullRequestMetadata omits absent PR metadata", () => {
  assert.deepEqual(
    pullRequestMetadata("Update OpenAPI spec", ""),
    {},
  );
});

test("parseArgs makes writing explicit and confirmed, and rejects the removed push options", () => {
  const base = [
    "node",
    "replay",
    "--shas",
    SHA_A,
    "--repository",
    "workos/openapi-spec",
  ];
  assert.throws(
    () => parseArgs([...base, "--output-dir", "spec-changes"]),
    /Refusing to write/,
  );
  assert.throws(
    () =>
      parseArgs([
        ...base,
        "--bot-url",
        "https://sdk-automation-bot.workos.tools",
      ]),
    /Unknown option/,
  );
  assert.throws(() => parseArgs([...base, "--push"]), /Unknown option/);

  assert.equal(parseArgs(base).outputDir, "");

  const parsed = parseArgs([
    ...base,
    "--output-dir",
    "spec-changes",
    "--confirm",
    "REPLAY_SPEC_CHANGES",
  ]);
  assert.equal(parsed.outputDir, resolve("spec-changes"));
});

function rebuilt(targetSha, changedServices) {
  const manifest = {
    sha: targetSha,
    parentSha: "b".repeat(40),
    timestamp: "2026-06-22T00:00:00Z",
    changedServices,
  };
  return { targetSha, manifest, manifestText: `${JSON.stringify(manifest)}\n` };
}

function scratchDir(t) {
  const root = mkdtempSync(join(tmpdir(), "replay-write-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "spec-changes");
}

test("writeManifests writes one <sha>.json per target with changes and skips empty ones", (t) => {
  const out = scratchDir(t);
  const withChanges = rebuilt(SHA_A, [{ service: "SSO", hasBreaking: false }]);
  const empty = rebuilt("c".repeat(40), []);

  const written = writeManifests(out, [withChanges, empty]);

  assert.deepEqual(written, [
    { targetSha: SHA_A, outputPath: join(out, `${SHA_A}.json`) },
    { targetSha: "c".repeat(40), outputPath: null },
  ]);
  assert.deepEqual(readdirSync(out), [`${SHA_A}.json`]);
  assert.equal(readFileSync(join(out, `${SHA_A}.json`), "utf8"), withChanges.manifestText);
});

test("writeManifests validates every target before writing, so a bad later target leaves no files", (t) => {
  const out = scratchDir(t);
  const good = rebuilt(SHA_A, [{ service: "SSO", hasBreaking: false }]);

  assert.throws(
    () => writeManifests(out, [good, { targetSha: "main", manifest: {}, manifestText: "{}" }]),
    /Invalid target SHA/,
  );
  assert.throws(
    () => writeManifests(out, [good, { ...good, targetSha: "d".repeat(40) }]),
    /does not match target/,
  );
  assert.throws(() => writeManifests(out, [good, { ...good, manifestText: "" }]), /Empty manifest/);
  assert.throws(
    () => writeManifests(out, [good, { ...good, manifest: { sha: good.targetSha } }]),
    /no changedServices list/,
  );
  assert.throws(() => writeManifests("", [good]), /output directory is required/);
  assert.equal(existsSync(out), false);
});
