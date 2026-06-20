# `.spec-changes/`

Append-only history of per-commit **changed-services manifests**, one
`<commit-sha>.json` file per spec merge, written by the
[`spec-changes.yml`](../.github/workflows/spec-changes.yml) workflow via
[`scripts/build-spec-changes.mjs`](../scripts/build-spec-changes.mjs).

Each manifest records which **post-mount** services a spec merge changed and
whether any change is breaking:

```jsonc
{
  "sha": "abc123",
  "parentSha": "def456",
  "timestamp": "2026-06-18T20:00:00Z",
  "changedServices": [
    { "service": "Vault", "hasBreaking": false },
    { "service": "UserManagement", "hasBreaking": true }
  ]
}
```

The dashboard bot (Phase 4) reads these to compute pending SDK work and rolls
them up by a watermark; it prunes its own reads, not this directory.

**Why repo-root (not under `spec/`)?** A manifest commit must not re-trigger the
workflows that fire on `spec/**` (`spec-changes.yml`) or `spec/open-api-spec.yaml`
+ `src/policy/**` (`release.yml`). Living at the repo root keeps manifest commits
outside every such path filter — a structural self-trigger guard, preferred over
a `[skip ci]` marker that would suppress all workflows indiscriminately.
