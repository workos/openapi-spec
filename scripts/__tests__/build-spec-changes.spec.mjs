import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildSpecChanges,
  buildChangedEndpoints,
  buildSymbolOwners,
  enrichChangedServices,
  isBreaking,
  servicesForChange,
} from '../build-spec-changes.mjs';
import { scopesForStaged } from '../render-changelog-preview.mjs';

// A representative slice of the real mount-rules, enough to exercise remapping
// without importing the (git-ignored) built bundle. The real-fixture test below
// imports the actual mountRules to guard against drift.
const MOUNT_RULES = {
  Client: 'ClientApi',
  Permissions: 'Authorization',
  Connections: 'SSO',
  Directories: 'DirectorySync',
  UserManagementUsers: 'UserManagement',
  UserManagementInvitations: 'UserManagement',
  UserManagementOrganizationMembership: 'OrganizationMembership',
  UserManagementDataProviders: 'Pipes',
};

const serviceMap = (manifest) => Object.fromEntries(manifest.changedServices.map((s) => [s.service, s.hasBreaking]));

// ── Key scenario 1: additive op in a single-tag service ──────────────────────
test('additive operation in a non-remounted service → that service, not breaking', () => {
  const report = {
    changes: [{ kind: 'operation-added', serviceName: 'Vault', operationName: 'createObject', classification: 'additive' }],
  };
  const { manifest } = buildSpecChanges({ report, mountRules: MOUNT_RULES });
  assert.deepEqual(manifest.changedServices, [{ service: 'Vault', hasBreaking: false }]);
});

// ── Key scenario 2: removed op in a mounted sub-service → parent, breaking ────
test('removed operation in a mounted sub-service → post-mount parent flagged breaking', () => {
  const report = {
    changes: [
      { kind: 'operation-removed', serviceName: 'UserManagementUsers', operationName: 'deleteUser', classification: 'breaking' },
    ],
  };
  const { manifest } = buildSpecChanges({ report, mountRules: MOUNT_RULES });
  assert.deepEqual(manifest.changedServices, [{ service: 'UserManagement', hasBreaking: true }]);
});

// ── Key scenario 3: shared-schema-only change → every referencing service ────
test('shared-model change surfaces every service that references it (incl. transitively)', () => {
  const ir = {
    services: [
      { name: 'Vault', operations: [{ name: 'getObject', response: { kind: 'model', name: 'SharedEnvelope' } }] },
      { name: 'Connections', operations: [{ name: 'getConn', response: { kind: 'model', name: 'Wrapper' } }] },
    ],
    models: [
      { name: 'SharedEnvelope', fields: [] },
      { name: 'Wrapper', fields: [{ name: 'inner', type: { kind: 'model', name: 'SharedEnvelope' } }] },
    ],
  };
  const report = {
    changes: [
      {
        kind: 'model-modified',
        name: 'SharedEnvelope',
        fieldChanges: [{ kind: 'field-added', fieldName: 'extra', classification: 'additive' }],
        classification: 'additive',
      },
    ],
  };
  // Vault references SharedEnvelope directly; Connections (→ SSO) references it
  // transitively through Wrapper.
  const { manifest } = buildSpecChanges({ report, irs: [null, ir], mountRules: MOUNT_RULES });
  assert.deepEqual(manifest.changedServices, [
    { service: 'SSO', hasBreaking: false },
    { service: 'Vault', hasBreaking: false },
  ]);
});

// ── mount-rules remapping ────────────────────────────────────────────────────
test('service/operation changes are remapped to post-mount names and sorted/deduped', () => {
  const report = {
    changes: [
      { kind: 'service-added', name: 'Client', classification: 'additive' },
      { kind: 'operation-added', serviceName: 'Permissions', operationName: 'createRole', classification: 'additive' },
      { kind: 'operation-modified', serviceName: 'Authorization', operationName: 'listResources', classification: 'additive' },
    ],
  };
  const { manifest } = buildSpecChanges({ report, mountRules: MOUNT_RULES });
  // Permissions and Authorization both fold into Authorization (deduped); Client → ClientApi.
  assert.deepEqual(manifest.changedServices, [
    { service: 'Authorization', hasBreaking: false },
    { service: 'ClientApi', hasBreaking: false },
  ]);
});

// ── breaking-flag rollup within a service ────────────────────────────────────
test('a service is breaking if ANY change touching it is breaking', () => {
  const report = {
    changes: [
      { kind: 'operation-added', serviceName: 'UserManagementUsers', operationName: 'createUser', classification: 'additive' },
      { kind: 'operation-removed', serviceName: 'UserManagementInvitations', operationName: 'revoke', classification: 'breaking' },
    ],
  };
  const { manifest } = buildSpecChanges({ report, mountRules: MOUNT_RULES });
  // Both fold into UserManagement; the breaking removal wins the rollup.
  assert.deepEqual(manifest.changedServices, [{ service: 'UserManagement', hasBreaking: true }]);
});

// ── behavior changes (param-default flips) are service-scoped & breaking ─────
test('behaviorChanges fold into their service as breaking', () => {
  const report = {
    changes: [],
    behaviorChanges: [{ serviceName: 'UserManagementInvitations', paramName: 'order', oldDefault: 'desc', newDefault: null }],
  };
  const { manifest } = buildSpecChanges({ report, mountRules: MOUNT_RULES });
  assert.deepEqual(manifest.changedServices, [{ service: 'UserManagement', hasBreaking: true }]);
});

// ── buildChangedEndpoints: method/path from IR, post-mount attribution ───────
test('buildChangedEndpoints resolves method/path and attributes to post-mount service', () => {
  const ir = {
    services: [
      {
        name: 'UserManagementUsers',
        operations: [
          { name: 'createUser', httpMethod: 'post', path: '/user_management/users' },
          { name: 'deleteUser', httpMethod: 'delete', path: '/user_management/users/{id}' },
        ],
      },
    ],
  };
  const report = {
    changes: [
      { kind: 'operation-added', serviceName: 'UserManagementUsers', operationName: 'createUser', classification: 'additive' },
      { kind: 'operation-removed', serviceName: 'UserManagementUsers', operationName: 'deleteUser', classification: 'breaking' },
    ],
  };
  const map = buildChangedEndpoints({ report, irs: [ir, ir], mountRules: MOUNT_RULES });
  assert.deepEqual(map.get('UserManagement'), [
    { method: 'POST', path: '/user_management/users', breaking: false, kind: 'operation-added' },
    { method: 'DELETE', path: '/user_management/users/{id}', breaking: true, kind: 'operation-removed' },
  ]);
});

test('buildChangedEndpoints skips changes whose endpoint is absent from the IR', () => {
  const report = {
    changes: [{ kind: 'operation-added', serviceName: 'Vault', operationName: 'mystery', classification: 'additive' }],
  };
  const map = buildChangedEndpoints({ report, irs: [], mountRules: MOUNT_RULES });
  assert.equal(map.size, 0);
});

// ── isBreaking: trust the rollup, but defend against missing classification ──
test('isBreaking trusts top-level classification', () => {
  assert.equal(isBreaking({ kind: 'operation-modified', classification: 'breaking' }), true);
  assert.equal(isBreaking({ kind: 'operation-added', classification: 'additive' }), false);
});

test('isBreaking treats any *-removed kind as breaking even without classification', () => {
  assert.equal(isBreaking({ kind: 'model-removed', name: 'Foo' }), true);
  assert.equal(isBreaking({ kind: 'service-removed', name: 'Foo' }), true);
});

test('isBreaking detects a breaking sub-change under an additive top-level', () => {
  const change = {
    kind: 'model-modified',
    name: 'Foo',
    classification: 'additive',
    fieldChanges: [{ kind: 'field-removed', fieldName: 'gone', classification: 'breaking' }],
  };
  assert.equal(isBreaking(change), true);
});

// ── servicesForChange direct unit coverage ───────────────────────────────────
test('servicesForChange returns [] for unknown/unmappable shapes', () => {
  assert.deepEqual(servicesForChange({ kind: 'operation-added' }, new Map(), MOUNT_RULES), []);
  assert.deepEqual(servicesForChange({ kind: 'mystery-kind', name: 'X' }, new Map(), MOUNT_RULES), []);
});

// ── buildSymbolOwners attributes through both IRs (removed-model case) ───────
test('buildSymbolOwners indexes a model present only in the OLD ir', () => {
  const oldIr = {
    services: [{ name: 'Vault', operations: [{ name: 'op', response: { kind: 'model', name: 'GoneModel' } }] }],
    models: [{ name: 'GoneModel', fields: [] }],
  };
  const owners = buildSymbolOwners([oldIr, null], MOUNT_RULES);
  assert.deepEqual([...(owners.get('model:GoneModel') ?? [])], ['Vault']);
});

// ── edge cases ───────────────────────────────────────────────────────────────
test('empty report → no changed services', () => {
  const { manifest } = buildSpecChanges({ report: { changes: [] }, mountRules: MOUNT_RULES });
  assert.deepEqual(manifest.changedServices, []);
});

test('model change with no IR → unattributed and counted', () => {
  const report = {
    changes: [{ kind: 'model-modified', name: 'Lonely', fieldChanges: [], classification: 'additive' }],
  };
  const { manifest, unattributedSymbolChanges } = buildSpecChanges({ report, mountRules: MOUNT_RULES });
  assert.deepEqual(manifest.changedServices, []);
  assert.equal(unattributedSymbolChanges, 1);
});

test('manifest carries sha/parentSha/timestamp verbatim', () => {
  const { manifest } = buildSpecChanges({
    report: { changes: [] },
    sha: 'aaa',
    parentSha: 'bbb',
    timestamp: '2026-06-20T00:00:00Z',
    mountRules: MOUNT_RULES,
  });
  assert.equal(manifest.sha, 'aaa');
  assert.equal(manifest.parentSha, 'bbb');
  assert.equal(manifest.timestamp, '2026-06-20T00:00:00Z');
});

// ── enrichChangedServices: reconcile hasBreaking with the enriched evidence ──
// The single changelog scope a non-mounted post-mount service carries — the
// same derivation enrichChangedServices uses to filter entries to a service.
const scopeOf = (service) => [...scopesForStaged([service], MOUNT_RULES)][0];

test('enrich flips hasBreaking when a scoped changelog entry is breaking (orphaned-symbol case)', () => {
  // Owner-attribution left Vault non-breaking (e.g. a removed webhook-event
  // payload referenced by no operation), but the changelog scoped a
  // feat!/breaking entry to it. The emitted flag must agree with the entry.
  const allEntries = [
    { scope: scopeOf('Vault'), severity: 'breaking', prefix: 'feat!', summary: 'Remove X', description: '' },
  ];
  const [vault] = enrichChangedServices({
    changedServices: [{ service: 'Vault', hasBreaking: false }],
    allEntries,
    mountRules: MOUNT_RULES,
  });
  assert.equal(vault.hasBreaking, true);
  assert.equal(vault.entries.length, 1);
  assert.deepEqual(vault.changedEndpoints, []);
});

test('enrich flips hasBreaking when a changed endpoint is breaking', () => {
  const endpointsByService = new Map([
    ['Vault', [{ method: 'DELETE', path: '/vault/objects/{id}', breaking: true, kind: 'operation-removed' }]],
  ]);
  const [vault] = enrichChangedServices({
    changedServices: [{ service: 'Vault', hasBreaking: false }],
    endpointsByService,
    mountRules: MOUNT_RULES,
  });
  assert.equal(vault.hasBreaking, true);
});

test('enrich preserves an owner-attributed breaking flag with no endpoints/entries (naked-flag superset)', () => {
  // A shared symbol flagged Authorization breaking via owner-attribution, but no
  // operation changed and no entry scoped to it. The flag stays true — the bot
  // renders an explanatory note for this no-detail case.
  const [auth] = enrichChangedServices({
    changedServices: [{ service: 'Authorization', hasBreaking: true }],
    mountRules: MOUNT_RULES,
  });
  assert.equal(auth.hasBreaking, true);
  assert.deepEqual(auth.changedEndpoints, []);
  assert.deepEqual(auth.entries, []);
});

test('enrich keeps hasBreaking false with no breaking evidence, and scopes entries to the service', () => {
  const allEntries = [
    { scope: scopeOf('Vault'), severity: 'additive', prefix: 'feat', summary: 'Add Y', description: '' },
    { scope: '__elsewhere__', severity: 'breaking', prefix: 'feat!', summary: 'Other service', description: '' },
  ];
  const endpointsByService = new Map([
    ['Vault', [{ method: 'POST', path: '/vault/objects', breaking: false, kind: 'operation-added' }]],
  ]);
  const [vault] = enrichChangedServices({
    changedServices: [{ service: 'Vault', hasBreaking: false }],
    endpointsByService,
    allEntries,
    mountRules: MOUNT_RULES,
  });
  assert.equal(vault.hasBreaking, false);
  // Only the Vault-scoped entry attaches; a breaking entry from another scope
  // neither attaches nor flips the flag.
  assert.equal(vault.entries.length, 1);
  assert.equal(vault.entries[0].summary, 'Add Y');
});

// ── real captured oagen-diff report against the REAL mount-rules ─────────────
// Validates the operation/service mapping on real data and guards against
// mount-rules drift. Skips gracefully if the policy bundle isn't built.
test('real diff fixture maps to valid post-mount service names', async (t) => {
  let mountRules;
  try {
    ({ mountRules } = await import('../../dist/policy.mjs'));
  } catch {
    t.skip('dist/policy.mjs not built — run `npm run build:policy`');
    return;
  }

  const VALID_POST_MOUNT = new Set([
    'AdminPortal', 'ApiKeys', 'AuditLogs', 'Authorization', 'ClientApi', 'Connect',
    'DirectorySync', 'Events', 'FeatureFlags', 'Groups', 'MultiFactorAuth',
    'OrganizationDomains', 'OrganizationMembership', 'Organizations', 'Pipes',
    'PipesProvider', 'Radar', 'SSO', 'UserManagement', 'Vault', 'Webhooks', 'Widgets',
  ]);

  const report = JSON.parse(readFileSync(new URL('./fixtures/diff-report.json', import.meta.url), 'utf8'));
  // No IR: model/enum changes are intentionally unattributed, so the result is
  // exactly the operation/service-derived services. This isolates the mapping
  // we can assert deterministically without committing a 1.4 MB IR fixture.
  const { manifest } = buildSpecChanges({ report, mountRules });
  const map = serviceMap(manifest);

  // Every emitted name is a real post-mount service (no snake_case, no raw
  // pre-mount names like UserManagementInvitations).
  for (const { service } of manifest.changedServices) {
    assert.ok(VALID_POST_MOUNT.has(service), `${service} is not a valid post-mount service`);
  }

  // The two breaking operation-modified changes land on the right parents.
  assert.equal(map.UserManagement, true);
  assert.equal(map.OrganizationMembership, true);
  // Additive service/operation additions, correctly remapped.
  assert.equal(map.Authorization, false);
  assert.equal(map.ClientApi, false); // Client → ClientApi
  assert.equal(map.PipesProvider, false);

  // Sorted, no duplicates.
  const names = manifest.changedServices.map((s) => s.service);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.equal(names.length, new Set(names).size);
});
