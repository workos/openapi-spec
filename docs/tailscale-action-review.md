# Pinned Tailscale action argument-flow review

The two Socket warnings on [PR #264](https://github.com/workos/openapi-spec/pull/264#issuecomment-6666124487)
were reviewed on 2026-11-05 for action commit
`064b10558093f38325e838ddea35486bdc6b1d5c`. Neither warning was ignored or
suppressed. The Socket package alert detail identifies these two sources and
sinks; its source-location UI currently renders the sink objects as
`[object Object]`, so the exact code locations below come from the pinned
upstream source and its executed bundle.

| Socket instance | Exact source and path | Sink | Our supplied value |
| --- | --- | --- | --- |
| 1 | `core.getInput("version")`, `src/main.ts:261`, through `parseVersion`, `resolvedVersion`, and fixed vendor `downloadUrl` | `tc.downloadTool(downloadUrl, tarDest)` at line 519 (Linux), and `tc.downloadTool(downloadUrl, msiPath)` at line 637 (Windows) | Literal `1.104.4`; hosted Ubuntu selects Linux. No event, PR, dispatch or repository variable controls this input. |
| 2 | `core.getInput("statedir")`, `src/main.ts:272`, through `config.stateDir`, `stateArgs` and daemon `args` | `spawn("sudo", ["-E", cmdTailscaled, ...args], ...)` at line 771 | Omitted/empty, which selects `--state=mem:` at lines 755–757. No writable state directory or user-controlled shell command is supplied. |

The version parser permits only a numeric version (optionally prefixed `v`) or
the named release tracks. Our workflow uses a fixed numeric version. The
download host is `pkgs.tailscale.com`; the action verifies the downloaded
archive's SHA-256 before installing. `statedir` reaches an argument-array spawn
with no `shell: true`. These are input-to-download/process flows, not proof of
credential disclosure or command injection in this workflow configuration.

The other action inputs are public client ID/audience, a fixed tag, fixed
userspace/proxy flags, numeric GitHub run identifiers, and the exit IPv4
validated by `--check-config` before the action runs. We supply no `authkey`,
`oauth-secret`, dynamic `version`, or `statedir`. The normal producer and replay
use distinct exact workflow/event trusts. No PR or dispatch text is interpolated
into the action's command arguments.

## OIDC and signing-secret exposure

The action obtains the short-lived JWT using `core.getIDToken(config.audience)`
at `src/main.ts:866`, then passes it to the Tailscale CLI as
`--id-token=${token}` at line 869. In the pinned executed `dist/index.js`, the
bundled `OidcClient.getIDToken` calls `core.setSecret(id_token)` before returning
the token (including the bundled copy at lines 11647–11659). The logging wrapper
normally suppresses command output; debug mode can print commands, but the raw
JWT is already registered with GitHub's runner masking. The two Socket warnings
do not trace this JWT or the HMAC secret to their sinks.

The JWT **is briefly present in the Tailscale CLI's process arguments**. Log
masking does not conceal argv from privileged or same-user processes on the
runner. This is why these jobs use fresh GitHub-hosted VMs, run no npm install
or artifact code in delivery, and must not be moved onto shared/persistent
self-hosted runners without a separate credential-isolation review. A
compromised action/runner can access a token it is authorized to use; this review
does not establish safety against that compromise.

`SPEC_CHANGES_SECRET` is scoped only to the later delivery-script step, so it is
not provided to the Tailscale action. The script passes only the derived HMAC
header to curl over stdin and does not log it, the secret, or response bodies.
The data-building jobs receive neither signing secret nor OIDC permission.

For these pinned inputs, neither Socket flow requires a code change. The
alerts remain visible for review. This is a static source/bundle analysis:
no production OIDC token was minted and no live credential/log exposure was
tested.

Sources:

- [Socket's two argument-to-sink instances](https://socket.dev/actions/package/tailscale/github-action/alerts/064b10558093f38325e838ddea35486bdc6b1d5c?alert_name=ghaArgToSink)
- [Pinned input parsing and version validation](https://github.com/tailscale/github-action/blob/064b10558093f38325e838ddea35486bdc6b1d5c/src/main.ts#L242)
- [Pinned Linux download sink](https://github.com/tailscale/github-action/blob/064b10558093f38325e838ddea35486bdc6b1d5c/src/main.ts#L519)
- [Pinned Windows download sink](https://github.com/tailscale/github-action/blob/064b10558093f38325e838ddea35486bdc6b1d5c/src/main.ts#L637)
- [Pinned memory-state branch and daemon spawn](https://github.com/tailscale/github-action/blob/064b10558093f38325e838ddea35486bdc6b1d5c/src/main.ts#L751)
- [Pinned OIDC argument construction](https://github.com/tailscale/github-action/blob/064b10558093f38325e838ddea35486bdc6b1d5c/src/main.ts#L866)
- [Executed bundle token masking](https://github.com/tailscale/github-action/blob/064b10558093f38325e838ddea35486bdc6b1d5c/dist/index.js#L11647)
- [Pinned logging wrapper](https://github.com/tailscale/github-action/blob/064b10558093f38325e838ddea35486bdc6b1d5c/src/logging.ts#L65)
