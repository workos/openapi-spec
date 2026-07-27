# Replaying spec-change manifests

Use the **Replay spec changes** Actions workflow to rebuild historical
spec-change manifests after the analyzer or SDK changelog policy changes.

The workflow always uses the currently selected checkout's
`scripts/build-spec-changes.mjs`, installed `oagen`, and compiled policy. For
each explicit target SHA, it extracts only
`spec/open-api-spec.yaml` from that commit and its first parent. It preserves
the target commit subject, PR number/URL, commit timestamp, SHA, and parent SHA.

## Preview

1. Open **Actions → Replay spec changes → Run workflow**.
2. Select the default branch.
3. Enter one or more full 40-character merge SHAs, separated by commas or
   spaces. Abbreviated SHAs, refs, ranges, duplicates, non-ancestors, and
   commits off the selected branch's first-parent history or commits that did
   not change the spec are rejected.
4. Keep **mode** set to **dry-run**.

The workflow prints every rebuilt manifest but does not receive the signing
secret or make a network request.

For a local preview after `npm ci && npm run build:policy`:

```sh
node scripts/replay-spec-changes.mjs \
  --shas "<full-sha>,<full-sha>" \
  --repository workos/openapi-spec
```

## Push

After reviewing a dry run, launch the workflow again with the same explicit
SHAs and set **mode** to **push**. Push mode is accepted only from the default
branch. The workflow signs the exact manifest bytes and POSTs them to the
existing SDK bot endpoint.

The SDK bot upserts on the target SHA, so repeating the same replay is
idempotent. A target that produces no changed services is shown but not POSTed.
Every target is validated and rebuilt before the first POST, and the workflow
serializes with the normal spec-change producer to avoid delivery races.

Do not put the signing secret in the SHA input or logs. The workflow exposes
`SPEC_CHANGES_SECRET` only to the confirmed push step.
