import assert from 'node:assert/strict';
import test from 'node:test';

import { scopesForStaged } from '../render-changelog-preview.mjs';

// Representative slice of the real mount-rules (Client mounts to ClientApi).
const MOUNT_RULES = {
  Client: 'ClientApi',
  Permissions: 'Authorization',
  Connections: 'SSO',
  UserManagementUsers: 'UserManagement',
  UserManagementDataProviders: 'Pipes',
};

// Regression: staging the post-mount ClientApi must include the `client` scope
// the changelog entries actually use — publicScopeFromService('ClientApi') is
// 'client_api', so without the mount-aware union a ClientApi-only preview would
// filter out every (client-scoped) entry and render blank.
test('staged ClientApi resolves to the client scope, not just client_api', () => {
  const scopes = scopesForStaged(['ClientApi'], MOUNT_RULES);
  assert.ok(scopes.has('client'), 'includes client (from the Client -> ClientApi mount)');
});

test('a directly-named service resolves to its own scope', () => {
  const scopes = scopesForStaged(['SSO'], MOUNT_RULES);
  assert.ok(scopes.has('sso'));
});

test('a post-mount parent picks up the scopes of its mounted sub-services', () => {
  // UserManagementUsers + UserManagementDataProviders mount to UserManagement /
  // Pipes; staging UserManagement should at least include user_management.
  const scopes = scopesForStaged(['UserManagement'], MOUNT_RULES);
  assert.ok(scopes.has('user_management'));
});

test('no mountRules → still resolves the post-mount name to its own scope', () => {
  const scopes = scopesForStaged(['Vault'], {});
  assert.ok(scopes.has('vault'));
});
