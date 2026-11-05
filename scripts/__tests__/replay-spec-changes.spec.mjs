import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  firstParentFromRevList,
  parseArgs,
  parseTargetShas,
  pullRequestMetadata,
  writeDelivery,
} from "../replay-spec-changes.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "B".repeat(40);

test("parseTargetShas accepts comma and whitespace separated full SHAs", () => {
  assert.deepEqual(parseTargetShas(`${SHA_A},\n ${SHA_B}`), [
    SHA_A,
    SHA_B.toLowerCase(),
  ]);
});

test("artifact preparation requires explicit replay confirmation and cannot combine with push", () => {
  const base = ["node", "replay", "--shas", SHA_A, "--repository", "workos/openapi-spec"];
  assert.throws(() => parseArgs([...base, "--prepare-delivery", "/tmp/replay-fixture"]), /Refusing to POST/);
  const args = parseArgs([...base, "--prepare-delivery", "/tmp/replay-fixture", "--confirm", "REPLAY_SPEC_CHANGES"]);
  assert.equal(args.prepareDelivery, "/tmp/replay-fixture");
  assert.equal(args.push, false);
  assert.throws(() => parseArgs([...base, "--prepare-delivery", "/tmp/replay-fixture", "--push"]), /not both/);
  assert.throws(() => parseArgs([...base, "--push", "--confirm", "REPLAY_SPEC_CHANGES", "--bot-url", "https://other.example"]), /fixed SDK bot/);
});

test("delivery artifact preserves ordered exact bytes, excludes unchanged targets, and preflights all files", t => {
  const root = mkdtempSync(join(tmpdir(), "replay-data-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = JSON.stringify({ sha: SHA_A, changedServices: [{ name: "SSO" }], text: "é" }) + "\n";
  const b = JSON.stringify({ sha: SHA_B.toLowerCase(), changedServices: [] }) + "\n";
  const out = join(root, "data");
  assert.equal(writeDelivery(out, [SHA_B.toLowerCase(), SHA_A], [{ manifestText: b }, { manifestText: a }]), 1);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "index.json"))), [SHA_A]);
  assert.equal(readFileSync(join(out, `${SHA_A}.json`), "utf8"), a);
  assert.ok(!existsSync(join(out, `${SHA_B.toLowerCase()}.json`)));
  const unchanged = join(root, "unchanged");
  assert.equal(writeDelivery(unchanged, [SHA_B.toLowerCase()], [{ manifestText: b }]), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(unchanged, "index.json"))), []);
  assert.throws(() => writeDelivery(out, [SHA_A], [{ manifestText: a }]), /already exist/);
  const invalid = join(root, "invalid");
  assert.throws(() => writeDelivery(invalid, [SHA_A, SHA_B.toLowerCase()], [{ manifestText: a }, { manifestText: a }]), /SHA mismatch/);
  assert.ok(!existsSync(invalid), "invalid later target must not leave partial delivery data");
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

test("parseArgs makes POST mode explicit, confirmed, and HTTPS-only", () => {
  const base = [
    "node",
    "replay",
    "--shas",
    SHA_A,
    "--repository",
    "workos/openapi-spec",
    "--push",
  ];
  assert.throws(
    () =>
      parseArgs([
        ...base,
        "--bot-url",
        "https://sdk-automation-bot.workos.tools",
      ]),
    /Refusing to POST/,
  );
  assert.throws(
    () =>
      parseArgs([
        ...base,
        "--bot-url",
        "http://sdk-automation-bot.workos.tools",
        "--confirm",
        "REPLAY_SPEC_CHANGES",
      ]),
    /must use HTTPS/,
  );

  const parsed = parseArgs([
    ...base,
    "--bot-url",
    "https://sdk-automation-bot.workos.tools",
    "--confirm",
    "REPLAY_SPEC_CHANGES",
  ]);
  assert.equal(parsed.push, true);
  assert.equal(
    parsed.endpoint.href,
    "https://sdk-automation-bot.workos.tools/internal/spec-changes",
  );
});
