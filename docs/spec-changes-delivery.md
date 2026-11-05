# Spec-change delivery through Tailscale

`spec-changes.yml` builds a manifest without a signing secret or OIDC permission.
A separate delivery job downloads that same-run data artifact, obtains GitHub
OIDC identity, joins Tailscale ephemerally as `tag:ci-sdk-spec-changes`, and signs
the exact manifest file bytes with the existing `SPEC_CHANGES_SECRET`.

The transport is a userspace SOCKS5 listener on `127.0.0.1:1055` through an
explicit internal exit, then TLS to `sdk-automation-bot.workos.tools`. The
Cloudflare Worker remains a public endpoint. It needs no deployment change:
the existing WAF permits the internal exit NAT addresses and the Worker still
authenticates `X-Spec-Changes-Signature` with HMAC. This change does not open a
new public exception or rely on held infra PR #2126.

Delivery refuses missing identity configuration, unsupported workflow/ref/event,
non-userspace Tailscale, a missing/offline/wrong/untagged exit, an unapproved NAT,
proxy failures and redirects. All retries use the same fixed host/path through
the proxy. Before any HTTP request, delivery pins the host's resolved IPv4 with
curl `--resolve` and installs a runner-local iptables OUTPUT reject for direct
TCP/443 to that exact IP. This also blocks tailscaled's host-network fallback
if its exit route disappears. Missing sudo/iptables permission stops delivery;
the rule disappears with the hosted VM. curlrc and `NO_PROXY` cannot select a
direct route. Local DNS plus
`--ipv4`/`socks5://` sends a numeric IPv4 to SOCKS5 without exit DNS permission.
Only the delivery script gets the signing secret; no npm install runs there.
The signature travels to curl over stdin, not its command line, and response
bodies and diagnostics are kept out of logs.

Apply the reviewed `workos/infra` trust/policy PR **before** merging this one.
Two event-specific identities require exact repository/owner numeric IDs,
main ref, workflow path and GitHub-hosted runner. Each has `auth_keys` only.
Their grant permits general IPv4 Internet TCP/443 through tagged internal exits;
it is not a hostname/path ACL. Private/tailnet/link-local/loopback destinations,
IPv6 and other ports are denied. Repository main workflow review remains a
trust boundary; trusted main code can change this workflow.

Set these nonsecret Actions repository variables from the infra output
`sdk_spec_changes_wif` and a reviewed exit:

| Variable | Source |
| --- | --- |
| `SDK_SPEC_CHANGES_PUSH_CLIENT_ID` | output `["push"].client_id` |
| `SDK_SPEC_CHANGES_PUSH_AUDIENCE` | output `["push"].audience` |
| `SDK_SPEC_CHANGES_DISPATCH_CLIENT_ID` | output `["workflow_dispatch"].client_id` |
| `SDK_SPEC_CHANGES_DISPATCH_AUDIENCE` | output `["workflow_dispatch"].audience` |
| `SDK_SPEC_CHANGES_EXIT_NODE` | approved, online internal exit's Tailscale IPv4 address |

Keep the existing `SPEC_CHANGES_SECRET` synchronized with the bot. No new static
Tailscale secret is needed. The action's pinned version uses memory-only state,
requests an ephemeral node and logs out after the job. If the configured exit
is replaced, verify its tag/approval/NAT and update the variable; there is no
automatic selection of an arbitrary or external exit.

The complete human bootstrap, apply, rollback and verification procedure is in
[the infra runbook](https://github.com/workos/infra/blob/codex/github-actions-sdk-tailscale/docs/runbooks/tailscale-control/github-actions-sdk.md).
After landing, manually dispatch on main (workflow-only changes do not match the
spec path filter), then verify the next real spec merge independently. Confirm
the bot's manifest row and ephemeral node removal. Preserve application HMAC
verification; never fall back to direct public delivery on failure.

`node --test scripts/__tests__/push-spec-changes.spec.mjs` checks byte-exact
signing, identity/config/status denial cases, proxy-only commands, NAT checks,
redirects, retries and real curl failure with a closed loopback proxy. SDK
validation CI runs it even when there is no spec change. Live OIDC, tailnet
policy enforcement, actual exit/NAT/Worker access, Linux firewall enforcement
and cleanup need the human
rollout checks. The existing historical `replay-spec-changes.yml` is separate
and receives no trust or transport change in this PR.
