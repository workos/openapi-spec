import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../sdk-generate.sh", import.meta.url));

function run(
  t,
  language,
  { existing = true, failExtract = false, failGenerate = false } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "sdk-baseline-script-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const output = join(root, "sdk with spaces");
  const log = join(root, "calls.jsonl");
  mkdirSync(bin);
  mkdirSync(output);
  if (existing) writeFileSync(join(output, ".oagen-manifest.json"), "{}");
  // Stub the CLI boundary, not an SDK/compiler: verify ordering and arguments.
  writeFileSync(
    join(bin, "npx"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
const value = key => args[args.indexOf(key) + 1];
if (args[1] === 'extract') {
  if (process.env.FAIL_EXTRACT === '1') process.exit(7);
  fs.writeFileSync(value('--output'), '{}');
} else if (args.includes('--api-surface')) {
  if (fs.readFileSync(value('--api-surface'), 'utf8') !== '{}') process.exit(8);
}
if (args[1] === 'generate' && process.env.FAIL_GENERATE === '1') process.exit(9);
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "bash",
    [script, "--lang", language, "--output", output],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: root,
        CALL_LOG: log,
        FAIL_EXTRACT: failExtract ? "1" : "0",
        FAIL_GENERATE: failGenerate ? "1" : "0",
      },
    },
  );
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
    : [];
  return { result, calls, output };
}

for (const language of ["go", "kotlin", "php"]) {
  test(`${language} captures the existing surface before generation and removes it afterward`, (t) => {
    const { result, calls, output } = run(t, language);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, 2);
    const [extract, generate] = calls;
    assert.deepEqual(extract.slice(0, 6), [
      "oagen",
      "extract",
      "--sdk-path",
      output,
      "--lang",
      language,
    ]);
    const surface = extract[extract.indexOf("--output") + 1];
    assert.equal(generate[generate.indexOf("--api-surface") + 1], surface);
    assert.equal(existsSync(surface), false);
  });
}

test("fresh SDK generation does not invent a baseline", (t) => {
  const { result, calls } = run(t, "go", { existing: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "generate");
  assert.ok(!calls[0].includes("--api-surface"));
});

test("extraction failure stops generation instead of silently ignoring compatibility", (t) => {
  const { result, calls } = run(t, "php", { failExtract: true });
  assert.equal(result.status, 7);
  assert.equal(calls.length, 1);
  assert.equal(existsSync(calls[0][calls[0].indexOf("--output") + 1]), false);
});

test("generation failure is preserved while temporary baseline files are cleaned up", (t) => {
  const { result, calls } = run(t, "kotlin", { failGenerate: true });
  assert.equal(result.status, 9);
  assert.equal(calls.length, 2);
  assert.equal(existsSync(calls[0][calls[0].indexOf("--output") + 1]), false);
});
