import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstParentFromRevList,
  parseArgs,
  parseTargetShas,
  pullRequestMetadata,
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
