import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// The overlay pins `default: desc` on the shared `PaginationOrder` component
// and carves `GET /events` back out of it (see transformSpec). Both halves are
// asserted on generated output, because the carve-out relies on how oagen
// reads a parameter default: a generator change that started reading through
// `allOf` would quietly put `order=desc` back on every `list_events` call.
test('list_events carries no client-side order default while other lists keep desc', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'openapi-events-order-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  oagen('generate', '--spec', 'spec/open-api-spec.yaml', '--lang', 'python',
    '--namespace', 'workos', '--services', 'Events,Organizations', '--output', output);

  const events = readFileSync(join(output, 'src/workos/events/_resource.py'), 'utf8');
  const organizations = readFileSync(join(output, 'src/workos/organizations/_resource.py'), 'utf8');

  // The sync and async clients each expose list_events; both keep the enum
  // type and drop the default.
  const eventsOrderParams = events.match(/^ {8}order: Optional\[Union\[PaginationOrder, str\]\] = None,$/gm) ?? [];
  assert.equal(eventsOrderParams.length, 2, 'expected both list_events signatures to default order to None');
  assert.doesNotMatch(events, /order: .* = "desc"/);

  // A list endpoint the server does order by `order` keeps the pinned default.
  assert.match(organizations, /^ {8}order: Optional\[Union\[PaginationOrder, str\]\] = "desc",$/m);
});
