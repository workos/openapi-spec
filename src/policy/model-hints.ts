/**
 * Model placement hints — used by emitters that call
 * `assignModelsToServices` so hinted models land in the configured service
 * instead of the default first-reference winner.
 */
export const modelHints: Record<string, string> = {
  // `UserlandUser` (→ `User`) is referenced from both UserManagement and
  // Authorization paths; pin it to the IR service that mounts onto
  // UserManagement so hand-written imports in existing SDKs keep resolving.
  User: 'UserManagementUsers',
  UserOrganizationMembershipBaseListData: 'Groups',
  // Keep this family pinned for non-Node SDKs that rely on existing
  // user-management model placement. Node freshens newly-adopted API key
  // method models in the emitter, so this global hint does not force the
  // generated Node user API key payloads into UserManagement.
  UserApiKeyOwner: 'UserManagementUsers',
};
