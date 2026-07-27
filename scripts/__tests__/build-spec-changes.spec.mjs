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
  UserManagementAuthentication: 'UserManagement',
  UserManagementOrganizationMembership: 'OrganizationMembership',
  UserManagementDataProviders: 'Pipes',
};

const serviceMetadata = (manifest) =>
  manifest.changedServices.map(({ service, specHasBreaking, sdkSeverity, hasBreaking }) => ({
    service,
    specHasBreaking,
    sdkSeverity,
    hasBreaking,
  }));

const specBreakingMap = (manifest) =>
  Object.fromEntries(manifest.changedServices.map((s) => [s.service, s.specHasBreaking]));

// ── Key scenario 1: additive op in a single-tag service ──────────────────────
test('additive operation in a non-remounted service → that service, not breaking', () => {
  const report = {
    changes: [{ kind: 'operation-added', serviceName: 'Vault', operationName: 'createObject', classification: 'additive' }],
  };
  const { manifest } = buildSpecChanges({ report, mountRules: MOUNT_RULES });
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'Vault', specHasBreaking: false, sdkSeverity: 'additive', hasBreaking: false },
  ]);
  assert.equal(manifest.changedServices[0].entries.length, 1);
});

// ── Key scenario 2: removed op in a mounted sub-service → parent, breaking ────
test('removed operation in a mounted sub-service → post-mount parent flagged breaking', () => {
  const report = {
    changes: [
      { kind: 'operation-removed', serviceName: 'UserManagementUsers', operationName: 'deleteUser', classification: 'breaking' },
    ],
  };
  const { manifest } = buildSpecChanges({ report, mountRules: MOUNT_RULES });
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'UserManagement', specHasBreaking: true, sdkSeverity: 'breaking', hasBreaking: true },
  ]);
});

// ── Regression: wildcard mount rule folds a sub-service with no exact entry ───
// A pre-mount service that matches only a trailing-`*` pattern (not an exact
// key) must still remap to its parent. A prior exact-only lookup leaked the raw
// pre-mount name (e.g. UserManagementRedirectUris), which `oagen generate
// --services` then rejected — breaking every generate-prs matrix job.
test('wildcard-only sub-service (no exact key) folds to its post-mount parent', () => {
  const WILDCARD_RULES = { 'UserManagement*': 'UserManagement' };
  const report = {
    changes: [
      { kind: 'operation-added', serviceName: 'UserManagementRedirectUris', operationName: 'createRedirectUri', classification: 'additive' },
    ],
  };
  const { manifest } = buildSpecChanges({ report, mountRules: WILDCARD_RULES });
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'UserManagement', specHasBreaking: false, sdkSeverity: 'additive', hasBreaking: false },
  ]);
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
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'SSO', specHasBreaking: false, sdkSeverity: 'additive', hasBreaking: false },
    { service: 'Vault', specHasBreaking: false, sdkSeverity: 'additive', hasBreaking: false },
  ]);
  assert.equal(manifest.changedServices[0].entries[0].summary, 'Add `extra` to `SharedEnvelope`');
  assert.equal(manifest.changedServices[1].entries[0].summary, 'Add `extra` to `SharedEnvelope`');
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
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'Authorization', specHasBreaking: false, sdkSeverity: 'additive', hasBreaking: false },
    { service: 'ClientApi', specHasBreaking: false, sdkSeverity: 'additive', hasBreaking: false },
  ]);
  const auth = manifest.changedServices[0];
  assert.ok(auth.entries.some((entry) => entry.severity === 'fix' && entry.changes[0].kind === 'operation-modified'));
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
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'UserManagement', specHasBreaking: true, sdkSeverity: 'breaking', hasBreaking: true },
  ]);
});

// ── behavior changes (param-default flips) are service-scoped & breaking ─────
test('behaviorChanges fold into their service as breaking', () => {
  const report = {
    changes: [],
    behaviorChanges: [{ serviceName: 'UserManagementInvitations', paramName: 'order', oldDefault: 'desc', newDefault: null }],
  };
  const { manifest } = buildSpecChanges({ report, mountRules: MOUNT_RULES });
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'UserManagement', specHasBreaking: true, sdkSeverity: 'breaking', hasBreaking: true },
  ]);
  assert.equal(manifest.changedServices[0].entries[0].changes[0].kind, 'param-default-changed');
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

// ── endpoint enrichment does not override canonical SDK metadata ─────────────
test('enrich attaches raw endpoint drill-in without changing SDK severity', () => {
  const endpointsByService = new Map([
    ['Vault', [{ method: 'DELETE', path: '/vault/objects/{id}', breaking: true, kind: 'operation-removed' }]],
  ]);
  const entry = { scope: 'vault', severity: 'fix', prefix: 'fix', summary: 'Update Vault', description: '' };
  const [vault] = enrichChangedServices({
    changedServices: [
      {
        service: 'Vault',
        specHasBreaking: true,
        sdkSeverity: 'fix',
        hasBreaking: false,
        entries: [entry],
      },
    ],
    endpointsByService,
  });
  assert.equal(vault.specHasBreaking, true);
  assert.equal(vault.sdkSeverity, 'fix');
  assert.equal(vault.hasBreaking, false);
  assert.deepEqual(vault.entries, [entry]);
  assert.deepEqual(vault.changedEndpoints, endpointsByService.get('Vault'));
});

test('strict completeness rejects an attributed change with no fact policy', () => {
  const report = {
    changes: [
      {
        kind: 'operation-mystery',
        serviceName: 'Vault',
        operationName: 'mystery',
        classification: 'breaking',
      },
    ],
  };
  assert.throws(
    () => buildSpecChanges({ report, mountRules: MOUNT_RULES }),
    /Attributed operation-mystery change Vault\.mystery to Vault but produced no policy-normalized changelog fact/,
  );
});

test('Pipes required field is raw-breaking but SDK-additive', () => {
  const ir = {
    services: [
      {
        name: 'UserManagementDataProviders',
        operations: [
          {
            name: 'create',
            requestBody: { kind: 'model', name: 'CreateDataIntegration' },
            response: { kind: 'model', name: 'DataIntegration' },
          },
        ],
      },
    ],
    models: [
      { name: 'CreateDataIntegration', fields: [] },
      { name: 'DataIntegration', fields: [] },
    ],
  };
  const report = {
    changes: [
      {
        kind: 'model-modified',
        name: 'CreateDataIntegration',
        classification: 'additive',
        fieldChanges: [{ kind: 'field-added', fieldName: 'config', classification: 'additive' }],
      },
      {
        kind: 'model-modified',
        name: 'DataIntegration',
        classification: 'breaking',
        fieldChanges: [{ kind: 'field-added', fieldName: 'config', classification: 'breaking' }],
      },
    ],
  };
  const { manifest } = buildSpecChanges({ report, irs: [ir, ir], mountRules: MOUNT_RULES });
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'Pipes', specHasBreaking: true, sdkSeverity: 'additive', hasBreaking: false },
  ]);
  assert.equal(manifest.changedServices[0].entries[0].scope, 'pipes');
  assert.equal(manifest.changedServices[0].entries[0].summary, 'Add `config` to Pipes models');
});

test('shared SSO model removal attaches its fix entry to every owner', () => {
  const ir = {
    services: [
      { name: 'Connections', operations: [{ name: 'get', response: { kind: 'model', name: 'Connection' } }] },
      { name: 'Vault', operations: [{ name: 'getShared', response: { kind: 'model', name: 'Connection' } }] },
    ],
    models: [{ name: 'Connection', fields: [] }],
  };
  const report = {
    changes: [
      {
        kind: 'model-modified',
        name: 'Connection',
        classification: 'breaking',
        fieldChanges: [{ kind: 'field-removed', fieldName: 'callback_endpoint', classification: 'breaking' }],
      },
    ],
  };
  const { manifest } = buildSpecChanges({ report, irs: [ir, ir], mountRules: MOUNT_RULES });
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'SSO', specHasBreaking: true, sdkSeverity: 'fix', hasBreaking: false },
    { service: 'Vault', specHasBreaking: true, sdkSeverity: 'fix', hasBreaking: false },
  ]);
  for (const service of manifest.changedServices) {
    assert.equal(service.entries.length, 1);
    assert.equal(service.entries[0].scope, 'sso');
    assert.equal(service.entries[0].changes[0].kind, 'field-removed');
  }
});

test('UserManagement inline error response change becomes an SDK fix entry', () => {
  const ir = {
    services: [
      {
        name: 'UserManagementAuthentication',
        operations: [
          {
            name: 'authenticate',
            httpMethod: 'post',
            path: '/user_management/authenticate',
          },
        ],
      },
    ],
  };
  const report = {
    changes: [
      {
        kind: 'operation-modified',
        serviceName: 'UserManagementAuthentication',
        operationName: 'authenticate',
        paramChanges: [],
        responseChanged: false,
        requestBodyChanged: false,
        errorsChanged: true,
        classification: 'breaking',
      },
    ],
  };
  const { manifest } = buildSpecChanges({ report, irs: [ir, ir], mountRules: MOUNT_RULES });
  assert.deepEqual(serviceMetadata(manifest), [
    { service: 'UserManagement', specHasBreaking: true, sdkSeverity: 'fix', hasBreaking: false },
  ]);
  const [entry] = manifest.changedServices[0].entries;
  assert.equal(entry.scope, 'user_management');
  assert.equal(entry.severity, 'fix');
  assert.equal(entry.changes[0].kind, 'errors-changed');
  assert.match(entry.description, /POST \/user_management\/authenticate/);
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
  const map = specBreakingMap(manifest);

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
