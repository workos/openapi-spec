// No npm dependencies: this runs in the isolated delivery job with OIDC/HMAC.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { spawnSync } from 'node:child_process';

const BOT = 'https://sdk-automation-bot.workos.tools';
const PROXY = 'socks5://127.0.0.1:1055';
const TAG = 'tag:ci-sdk-spec-changes';
const NAT_IPS = new Set(['3.151.179.114', '16.58.134.105', '16.58.183.17']);

function checkConfig() {
  const e = process.env;
  if (e.GITHUB_REPOSITORY !== 'workos/openapi-spec' ||
      e.GITHUB_REF !== 'refs/heads/main' ||
      e.GITHUB_WORKFLOW_REF !== 'workos/openapi-spec/.github/workflows/spec-changes.yml@refs/heads/main' ||
      !['push', 'workflow_dispatch'].includes(e.GITHUB_EVENT_NAME)) {
    throw new Error('Delivery requires the spec-changes workflow on workos/openapi-spec main.');
  }
  const ip = e.TAILSCALE_EXIT_NODE ?? '';
  const octets = ip.split('.').map(Number);
  if (!isIPv4(ip) || octets[0] !== 100 || octets[1] < 64 || octets[1] > 127) {
    throw new Error('TAILSCALE_EXIT_NODE must be an explicitly reviewed Tailscale IPv4 address.');
  }
  if (!e.TAILSCALE_CLIENT_ID || !/^[A-Za-z0-9-]+$/.test(e.TAILSCALE_CLIENT_ID) ||
      e.TAILSCALE_AUDIENCE !== `api.tailscale.com/${e.TAILSCALE_CLIENT_ID}`) {
    throw new Error('Missing or invalid public per-event Tailscale identity configuration.');
  }
}

function checkExit() {
  const result = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error('Cannot read Tailscale status.');
  let status;
  try { status = JSON.parse(result.stdout); } catch { throw new Error('Invalid Tailscale status.'); }
  const exit = status.ExitNodeStatus;
  const peer = Object.values(status.Peer ?? {}).find(p => p.ID === exit?.ID);
  // ExitNodeStatus.TailscaleIPs are prefixes in v1.104.4. PeerStatus uses IPs.
  if (status.BackendState !== 'Running' || status.TUN !== false ||
      status.Self?.Tags?.length !== 1 || status.Self.Tags[0] !== TAG ||
      !exit?.ID || exit.Online !== true ||
      !exit.TailscaleIPs?.includes(`${process.env.TAILSCALE_EXIT_NODE}/32`) ||
      peer?.Online !== true || peer.ExitNode !== true || peer.ExitNodeOption !== true ||
      !peer.Tags?.includes('tag:internal-exit-node') ||
      !peer.TailscaleIPs?.includes(process.env.TAILSCALE_EXIT_NODE)) {
    throw new Error('The reviewed internal exit must be online and selected in userspace mode.');
  }
}

function curl(path, extra = [], input) {
  // --disable must be first (ignore curlrc). Override NO_PROXY explicitly.
  // socks5 (not socks5h) + --ipv4 resolves locally and sends a numeric IPv4
  // destination: no exit PeerAPI DNS grant and no IPv6 destination is needed.
  const result = spawnSync('curl', [
    '--disable', '--silent', '--show-error', '--ipv4',
    '--proxy', PROXY, '--noproxy', '', '--proto', '=https',
    '--connect-timeout', '10', '--max-time', '30',
    '--max-redirs', '0', '--write-out', '\n%{http_code}',
    ...extra, `${BOT}${path}`,
  ], { encoding: 'utf8', input, timeout: 35_000, maxBuffer: 1024 * 1024 });
  // Do not relay curl stderr or response bodies to the log. Neither may be
  // trusted to be free of a reflected signature or application data.
  if (result.status !== 0) throw new Error('Request through Tailscale SOCKS5 failed.');
  const split = result.stdout.lastIndexOf('\n');
  const codeText = result.stdout.slice(split + 1);
  if (split < 0 || !/^\d{3}$/.test(codeText)) throw new Error('Invalid HTTP status from curl.');
  const code = Number(codeText);
  if (code < 200 || code >= 300) throw new Error(`SDK bot returned HTTP ${code}; redirects are forbidden.`);
  return result.stdout.slice(0, split);
}

try {
  checkConfig();
  if (process.argv.length === 3 && process.argv[2] === '--check-config') {
    process.exit(0);
  }
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/push-spec-changes.mjs <manifest.json>');
  const manifest = readFileSync(process.argv[2]);
  if (!process.env.SPEC_CHANGES_SECRET) throw new Error('SPEC_CHANGES_SECRET is required.');
  const signature = `sha256=${createHmac('sha256', process.env.SPEC_CHANGES_SECRET).update(manifest).digest('hex')}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    // A verified exit and same-host source-IP probe precede every signed POST.
    // Never fall back to a direct request if the proxy/exit/config fails.
    checkExit();
    const trace = curl('/cdn-cgi/trace');
    const ips = trace.split('\n').filter(line => line.startsWith('ip='));
    if (ips.length !== 1 || !NAT_IPS.has(ips[0].slice(3))) {
      throw new Error('SDK host did not observe an approved exit NAT IPv4 address.');
    }
    checkExit();
    try {
      curl('/internal/spec-changes', [
        '--request', 'POST', '--header', 'Content-Type: application/json',
        '--header', '@-', '--data-binary', `@${process.argv[2]}`,
      ], `X-Spec-Changes-Signature: ${signature}\n`);
      console.log('Pushed signed spec-changes manifest through the approved Tailscale exit.');
      process.exit(0);
    } catch {
      if (attempt === 3) throw new Error('Signed delivery failed after three attempts.');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
