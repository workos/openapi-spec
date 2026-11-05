import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('scripts/push-spec-changes.mjs');
const secret = 'test-signing-secret-do-not-log';
const manifest = '{"changedServices":[{"name":"SSO"}],"text":"é"}\n';
const goodStatus = {
  BackendState: 'Running', TUN: false,
  Self: { Tags: ['tag:ci-sdk-spec-changes'] },
  ExitNodeStatus: { ID: 'test-exit', Online: true, TailscaleIPs: ['100.100.10.1/32'] },
  Peer: { key: {
    ID: 'test-exit', Online: true, ExitNode: true, ExitNodeOption: true,
    Tags: ['tag:internal-exit-node'], TailscaleIPs: ['100.100.10.1'],
  } },
};

function run(t, { env = {}, status = goodStatus, mode = '', configOnly = false, realCurl = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const file = join(dir, 'manifest.json');
  writeFileSync(file, manifest);
  writeFileSync(join(dir, 'tailscale'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({command:'tailscale',args:process.argv.slice(2)})+'\\n');
console.log(process.env.STATUS);
`, { mode: 0o755 });
  writeFileSync(join(dir, 'curl'), `#!${process.execPath}
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
const input=fs.readFileSync(0,'utf8');
const post=args.includes('POST');
fs.appendFileSync(process.env.CALL_LOG,JSON.stringify({command:'curl',args,input,
  body:post?fs.readFileSync(args[args.indexOf('--data-binary')+1].slice(1),'utf8'):null})+'\\n');
if(process.env.REAL_CURL==='true') {
  // Pin local DNS in this test: real curl must fail at the absent SOCKS5
  // listener even with hostile NO_PROXY and an ambient curlrc to bypass it.
  const r=spawnSync('/usr/bin/curl',['--disable','--resolve','sdk-automation-bot.workos.tools:443:203.0.113.8',...args],{encoding:'utf8',input});
  process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);
}
if(process.env.MODE==='proxy-failed') { console.error(process.env.SPEC_CHANGES_SECRET);process.exit(7); }
if(!post) { process.stdout.write('ip='+(process.env.MODE==='wrong-nat'?'203.0.113.1':'3.151.179.114')+'\\n200'); }
else if(process.env.MODE==='redirect') { process.stdout.write('reflected '+input+'\\n302'); }
else if(process.env.MODE==='post-failed') { console.error(input);process.exit(7); }
else { process.stdout.write('ok\\n200'); }
`, { mode: 0o755 });
  // Top-level retry delays are shortened only by a test loader, with no
  // production flag or exported implementation seam.
  const loader = join(dir, 'fast-timers.mjs');
  writeFileSync(loader, 'globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };');
  const r = spawnSync(process.execPath, ['--import', loader, script, configOnly ? '--check-config' : file], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: {
      PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log, STATUS: JSON.stringify(status), MODE: mode,
      GITHUB_REPOSITORY: 'workos/openapi-spec', GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: 'workos/openapi-spec/.github/workflows/spec-changes.yml@refs/heads/main',
      GITHUB_EVENT_NAME: 'push', TAILSCALE_EXIT_NODE: '100.100.10.1',
      TAILSCALE_CLIENT_ID: 'fixture-client', TAILSCALE_AUDIENCE: 'api.tailscale.com/fixture-client',
      SPEC_CHANGES_SECRET: secret, NO_PROXY: '*', no_proxy: '*',
      REAL_CURL: String(realCurl), CURL_HOME: dir, ...env,
    },
  });
  let calls = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  const output = `${r.stdout}${r.stderr}`;
  assert.ok(!output.includes(secret), 'secret must never be logged');
  assert.ok(!output.includes(createHmac('sha256', secret).update(manifest).digest('hex')), 'signature must never be logged');
  return { ...r, calls };
}

test('both exact supported events can validate config; other repo/ref/workflow/events fail before commands', t => {
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal(run(t, { configOnly: true, env: { GITHUB_EVENT_NAME: event } }).status, 0);
  }
  for (const env of [
    { GITHUB_REPOSITORY: 'attacker/openapi-spec' }, { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_REF: 'refs/tags/main' }, { GITHUB_WORKFLOW_REF: 'workos/openapi-spec/.github/workflows/replay-spec-changes.yml@refs/heads/main' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_EVENT_NAME: 'workflow_run' }, { TAILSCALE_EXIT_NODE: '' },
    { TAILSCALE_EXIT_NODE: '100.100.10.1 --exit-node-allow-lan-access' },
    { TAILSCALE_EXIT_NODE: '10.0.0.1' }, { TAILSCALE_EXIT_NODE: 'auto:any' },
    { TAILSCALE_CLIENT_ID: '' }, { TAILSCALE_AUDIENCE: 'api.tailscale.com/*' },
    { SPEC_CHANGES_SECRET: '' },
  ]) {
    const r = run(t, { env });
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.deepEqual(r.calls, []);
  }
});

test('HMAC covers exactly the UTF-8 file bytes, sent through explicit IPv4 SOCKS5 with no bypass', t => {
  const r = run(t);
  assert.equal(r.status, 0, r.stderr);
  const calls = r.calls.filter(c => c.command === 'curl');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.at(-1), 'https://sdk-automation-bot.workos.tools/cdn-cgi/trace');
  const post = calls[1];
  assert.equal(post.args.at(-1), 'https://sdk-automation-bot.workos.tools/internal/spec-changes');
  assert.equal(post.body, manifest);
  assert.equal(post.input, `X-Spec-Changes-Signature: sha256=${createHmac('sha256', secret).update(Buffer.from(manifest)).digest('hex')}\n`);
  assert.ok(!post.args.some(a => a.includes(secret) || a.includes('sha256=')));
  for (const call of calls) {
    assert.equal(call.args[0], '--disable');
    assert.equal(call.args[call.args.indexOf('--proxy') + 1], 'socks5://127.0.0.1:1055');
    assert.equal(call.args[call.args.indexOf('--noproxy') + 1], '');
    assert.equal(call.args[call.args.indexOf('--proto') + 1], '=https');
    assert.ok(call.args.includes('--ipv4'));
    assert.ok(!call.args.includes('--location'));
  }
});

test('missing/offline/wrong/untagged exit and non-userspace status prevent every HTTP request', t => {
  const cases = [
    { ...goodStatus, BackendState: 'Stopped' }, { ...goodStatus, TUN: true },
    { ...goodStatus, Self: { Tags: ['tag:internal-k8s-operator'] } },
    { ...goodStatus, ExitNodeStatus: null },
    { ...goodStatus, ExitNodeStatus: { ...goodStatus.ExitNodeStatus, Online: false } },
    { ...goodStatus, ExitNodeStatus: { ...goodStatus.ExitNodeStatus, TailscaleIPs: ['100.100.10.2/32'] } },
    { ...goodStatus, Peer: {} },
    ...['Online', 'ExitNode', 'ExitNodeOption'].map(key => ({ ...goodStatus, Peer: { key: { ...goodStatus.Peer.key, [key]: false } } })),
    { ...goodStatus, Peer: { key: { ...goodStatus.Peer.key, Tags: ['tag:other-exit'] } } },
  ];
  for (const status of cases) {
    const r = run(t, { status });
    assert.equal(r.status, 1);
    assert.ok(r.calls.every(c => c.command !== 'curl'));
  }
});

test('wrong NAT and proxy failure stop before a signed request, with no direct fallback', t => {
  for (const mode of ['wrong-nat', 'proxy-failed']) {
    const r = run(t, { mode });
    assert.equal(r.status, 1);
    assert.equal(r.calls.filter(c => c.command === 'curl').length, 1);
    assert.ok(r.calls.every(c => !c.args.includes('POST')));
  }
});

test('redirects and POST errors retry only the same signed endpoint through the verified proxy', t => {
  for (const mode of ['redirect', 'post-failed']) {
    const r = run(t, { mode });
    assert.equal(r.status, 1);
    const calls = r.calls.filter(c => c.command === 'curl');
    assert.equal(calls.length, 6);
    assert.equal(calls.filter(c => c.args.includes('POST')).length, 3);
    assert.ok(calls.every(c => c.args[c.args.indexOf('--proxy') + 1] === 'socks5://127.0.0.1:1055'));
  }
});

test('real curl fails closed at an absent local SOCKS5 listener despite NO_PROXY=*', t => {
  const r = run(t, { realCurl: true });
  assert.equal(r.status, 1);
  assert.equal(r.calls.filter(c => c.command === 'curl').length, 1);
  assert.ok(r.calls.every(c => !c.args.includes('POST')));
});
