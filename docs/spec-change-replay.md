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

The workflow prints every rebuilt manifest and writes nothing.

For a local preview after `npm ci && npm run build:policy`:

```sh
node scripts/replay-spec-changes.mjs \
  --shas "<full-sha>,<full-sha>" \
  --repository workos/openapi-spec
```

## Upload

After reviewing a dry run, launch the workflow again with the same explicit
SHAs and set **mode** to **upload**. Upload mode is accepted only from the
default branch. The workflow writes one `<sha>.json` per target and uploads the
directory as a `spec-changes-replay-<run_id>` workflow artifact. The SDK bot
pulls that artifact when the run's `workflow_run` webhook lands, exactly as it
does for the regular `spec-changes-<sha>` artifact the producer publishes on
every merge; no request leaves GitHub and no shared secret is involved.

The SDK bot upserts on the target SHA, so repeating the same replay is
idempotent. A target that produces no changed services is shown but not
written. Every target is validated and rebuilt before the first file is
written, and the workflow serializes with the normal spec-change producer to
avoid delivery races.

If the bot missed the webhook, re-run the workflow (or use **Redeliver** on
the delivery in the GitHub App's settings); the artifact stays available for
14 days.
