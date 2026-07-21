import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildServiceIndex,
  canonicalizeServices,
  parseCsv,
} from "../canonicalize-services.mjs";

// Mirror of a slice of `oagen resolve --format json` output. Note `Organizations`:
// most of its ops stay, but one remounts onto `AuditLogs` — so `Organizations`
// is simultaneously a valid post-mount service AND a source tag with a remounted
// op. This split-mount case is the one that must NOT collapse `Organizations`.
const OPERATIONS = [
  { service: "UserManagement", mountOn: null, path: "/user_management/users" },
  { service: "UserManagementRedirectUris", mountOn: "UserManagement", path: "/user_management/redirect_uris" },
  { service: "Connections", mountOn: "SSO", path: "/connections" },
  { service: "SSO", mountOn: null, path: "/sso/authorize" },
  { service: "Organizations", mountOn: null, path: "/organizations" },
  { service: "Organizations", mountOn: "AuditLogs", path: "/organizations/{id}/audit_logs" },
  { service: "Vault", path: "/vault/objects" },
];

test("buildServiceIndex records every valid post-mount service", () => {
  const { postMount } = buildServiceIndex(OPERATIONS);
  for (const s of ["UserManagement", "SSO", "Organizations", "AuditLogs", "Vault"]) {
    assert.ok(postMount.has(s), `expected ${s} in post-mount set`);
  }
  // A pure pre-mount tag is never itself a post-mount target.
  assert.equal(postMount.has("UserManagementRedirectUris"), false);
  assert.equal(postMount.has("Connections"), false);
});

test("buildServiceIndex maps a tag to the sorted set of its operations' targets", () => {
  const { targetsByTag } = buildServiceIndex(OPERATIONS);
  assert.deepEqual(targetsByTag.get("UserManagementRedirectUris"), ["UserManagement"]);
  assert.deepEqual(targetsByTag.get("Connections"), ["SSO"]);
  // Split mount: both the stay-put and remounted targets, sorted.
  assert.deepEqual(targetsByTag.get("Organizations"), ["AuditLogs", "Organizations"]);
});

test("canonicalizeServices folds a pure pre-mount tag onto its post-mount service", () => {
  const index = buildServiceIndex(OPERATIONS);
  assert.deepEqual(
    canonicalizeServices(["UserManagementRedirectUris"], index),
    ["UserManagement"],
  );
});

test("canonicalizeServices keeps a valid post-mount service even when some ops remount away", () => {
  const index = buildServiceIndex(OPERATIONS);
  // The regression that the naive alias map got wrong: Organizations must NOT
  // collapse to AuditLogs just because one op remounts there.
  assert.deepEqual(canonicalizeServices(["Organizations"], index), ["Organizations"]);
});

test("canonicalizeServices de-duplicates when a tag collapses onto a listed service", () => {
  const index = buildServiceIndex(OPERATIONS);
  // The real regression: the full roster carried both the service and its
  // pre-mount tag. After collapse they must not both appear.
  assert.deepEqual(
    canonicalizeServices(
      ["UserManagement", "UserManagementRedirectUris", "Organizations", "Vault"],
      index,
    ),
    ["UserManagement", "Organizations", "Vault"],
  );
});

test("canonicalizeServices preserves first-seen order", () => {
  const index = buildServiceIndex(OPERATIONS);
  assert.deepEqual(
    canonicalizeServices(["Vault", "Connections", "SSO"], index),
    ["Vault", "SSO"],
  );
});

test("canonicalizeServices passes unknown names through unchanged (typos still fail loudly)", () => {
  const index = buildServiceIndex(OPERATIONS);
  assert.deepEqual(
    canonicalizeServices(["UserManagment", "Vault"], index),
    ["UserManagment", "Vault"],
  );
});

test("parseCsv trims whitespace and drops empties", () => {
  assert.deepEqual(parseCsv("Vault, SSO ,,UserManagement"), [
    "Vault",
    "SSO",
    "UserManagement",
  ]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv(undefined), []);
});
