import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIndexes, factsFromCompat, factsFromDiff, renderChangelogMarkdown, scopesForServices } from '../sdk-release-metadata.mjs';

// factsFromDiff only reaches indexes.symbolScopes (scope resolution) for the
// kinds under test; an empty index leaves scope unresolved, which is fine — we
// assert on severity/prefix, not scope.
const EMPTY_INDEXES = { symbolScopes: new Map(), enumWireValues: new Map() };

const fieldAddedReport = (classification) => ({
  changes: [
    {
      kind: 'model-modified',
      name: 'OrganizationMembership',
      classification: 'additive',
      fieldChanges: [{ kind: 'field-added', fieldName: 'roles', classification }],
    },
  ],
});

const addedFact = (report) =>
  factsFromDiff(report, EMPTY_INDEXES).find((f) => f.kind === 'field-added');

// Regression: a new field is a feature, never a fix. The differ sometimes flags
// an added field `breaking` (reads it as a request-shape tightening); the
// backend-only severity cap used to collapse that to `fix`, so the field landed
// under **Fixes** in the changelog even though the release bumped minor.
test('field-added flagged breaking is capped to additive (feat), not fix', () => {
  const fact = addedFact(fieldAddedReport('breaking'));
  assert.equal(fact.severity, 'additive');
  assert.equal(fact.prefix, 'feat');
});

test('field-added with an additive classification stays a feature', () => {
  const fact = addedFact(fieldAddedReport('additive'));
  assert.equal(fact.severity, 'additive');
  assert.equal(fact.prefix, 'feat');
});

// A missing/odd classification would previously fall through severityToPrefix to
// `fix`; an addition is additive regardless.
test('field-added with no classification still resolves to a feature', () => {
  const fact = addedFact(fieldAddedReport(undefined));
  assert.equal(fact.severity, 'additive');
  assert.equal(fact.prefix, 'feat');
});

// The cap must NOT leak to altering/removing changes — those stay a fix when the
// differ flags them breaking (field changes are backend-only, never major).
test('field-removed flagged breaking is still capped to fix', () => {
  const report = {
    changes: [
      {
        kind: 'model-modified',
        name: 'OrganizationMembership',
        classification: 'breaking',
        fieldChanges: [{ kind: 'field-removed', fieldName: 'legacy', classification: 'breaking' }],
      },
    ],
  };
  const fact = factsFromDiff(report, EMPTY_INDEXES).find((f) => f.kind === 'field-removed');
  assert.equal(fact.severity, 'fix');
  assert.equal(fact.prefix, 'fix');
});

// A scoped batch's changelog must describe only the staged services, even when
// the spec diff carries an unrelated change that drifted in between staging and
// generation (the bug that titled a Pipes batch after an authorization change).
test('scopesForServices maps staged post-mount names to changelog scope keys', () => {
  assert.deepEqual(scopesForServices('Pipes'), new Set(['pipes']));
  // PipesProvider folds into the pipes scope via the override table.
  assert.deepEqual(scopesForServices('Pipes,PipesProvider'), new Set(['pipes']));
  assert.deepEqual(scopesForServices('UserManagement, SSO'), new Set(['user_management', 'sso']));
});

test('scopesForServices returns null for an empty/absent selection (full generation keeps every scope)', () => {
  assert.equal(scopesForServices(undefined), null);
  assert.equal(scopesForServices(''), null);
  assert.equal(scopesForServices('true'), null); // parseArgs no-value sentinel
});

test('scope filter keeps only the staged services facts and drops drifted-in ones', () => {
  const report = {
    changes: [
      { kind: 'model-added', name: 'PipesDataIntegration' },
      { kind: 'model-added', name: 'Permission' },
    ],
  };
  const facts = factsFromDiff(report, EMPTY_INDEXES);
  assert.deepEqual(
    facts.map((f) => f.scope).sort(),
    ['authorization', 'pipes'],
  );
  const allowed = scopesForServices('Pipes');
  const scoped = facts.filter((fact) => allowed.has(fact.scope));
  assert.deepEqual(
    scoped.map((f) => f.scope),
    ['pipes'],
  );
});

// Regression: when several entries share a scope (e.g. multiple spec commits
// each touching Pipes or Webhooks), the changelog must collapse them under a
// single `* **[scope]**:` heading rather than repeating the heading per entry.
test('renderChangelogMarkdown merges same-scope entries under one heading', () => {
  const entries = [
    {
      prefix: 'feat',
      scope: 'webhooks',
      docs_url: 'https://workos.com/docs/reference/webhooks',
      summary: 'Add webhook API surface',
      description: '- Added `agent.registration.revoked` to `CreateWebhookEndpointEvents`.',
    },
    {
      prefix: 'feat',
      scope: 'webhooks',
      docs_url: 'https://workos.com/docs/reference/webhooks',
      summary: 'Add webhook API surface',
      description: '- Added `agent.registration.deleted` to `CreateWebhookEndpointEvents`.',
    },
  ];
  const markdown = renderChangelogMarkdown(entries, {});
  const headingCount = markdown.split('\n').filter((line) => line.includes('**[webhooks]')).length;
  assert.equal(headingCount, 1, 'renders a single webhooks heading');
  assert.equal(
    markdown,
    [
      '  **Features**',
      '  * **[webhooks](https://workos.com/docs/reference/webhooks)**:',
      '    * Added `agent.registration.revoked` to `CreateWebhookEndpointEvents`',
      '    * Added `agent.registration.deleted` to `CreateWebhookEndpointEvents`',
      '',
    ].join('\n'),
  );
});

// De-dupe within a merged scope so an identical change staged by two commits is
// listed once, not twice under the single heading.
test('renderChangelogMarkdown de-dupes identical detail lines within a scope', () => {
  const line = '- Added `agent.registration.revoked` to `CreateWebhookEndpointEvents`.';
  const entries = [
    { prefix: 'feat', scope: 'webhooks', docs_url: 'https://x', summary: 'a', description: line },
    { prefix: 'feat', scope: 'webhooks', docs_url: 'https://x', summary: 'b', description: line },
  ];
  const markdown = renderChangelogMarkdown(entries, {});
  const detailCount = markdown
    .split('\n')
    .filter((l) => l.includes('agent.registration.revoked')).length;
  assert.equal(detailCount, 1);
});

// Distinct scopes still each get their own heading, in first-seen order.
test('renderChangelogMarkdown keeps distinct scopes as separate headings', () => {
  const entries = [
    { prefix: 'feat', scope: 'pipes', docs_url: 'https://p', summary: 'p', description: '- Added `x`.' },
    { prefix: 'feat', scope: 'sso', docs_url: 'https://s', summary: 's', description: '- Added `y`.' },
  ];
  const markdown = renderChangelogMarkdown(entries, {});
  assert.ok(markdown.includes('**[pipes](https://p)**:'));
  assert.ok(markdown.includes('**[sso](https://s)**:'));
  assert.ok(markdown.indexOf('[pipes]') < markdown.indexOf('[sso]'));
});

// Regression: a compat surface change must resolve to a real scope with a
// docs_url, never the `sdk` fallback (which hard-fails --strict-scopes in CI).
// factsFromCompat distrusts a service scope that is merely `toSnakeCase(root)`
// and defers to scopeFromName; every root below reached CI as `sdk` because
// scopeFromName had no rule for it. These map one-per-scope (the per-scope
// dedup keeps a single breaking fact each) so all four resolve in one pass.
const compatSurfaceScopeCases = [
  { symbol: 'AdminPortal.generate_link', scope: 'admin_portal' },
  { symbol: 'Authorization.assign_role', scope: 'authorization' },
  { symbol: 'Agents.create_validate', scope: 'agents' },
  { symbol: 'ClientApi.create_token', scope: 'client' },
  { symbol: 'CreateApplicationSecret.from_dict', scope: 'connect' },
  // PR #118 regression set: event-payload-only waitlist types and the
  // synthetic authentication-method enum literal have no IR service to
  // resolve through, so the name rules must carry them.
  { symbol: 'WaitlistUserState', scope: 'user_management' },
  { symbol: 'WaitlistUserStateLiteral', scope: 'user_management' },
  { symbol: 'AuthenticateResponseAuthenticationMethodLiteral.DiscordOAuth', scope: 'user_management' },
  { symbol: 'AuthenticationMethod', scope: 'user_management' },
  // PR #137 regression: the synthetic `*Params` type for
  // `PUT /organizations/{id}/audit_logs_retention` carries the audit-logs
  // surface mid-name, so the `AuditLog` rule cannot be anchored.
  { symbol: 'UpdateOrganizationAuditLogsRetentionParams.new', scope: 'audit_logs' },
];

for (const { symbol, scope } of compatSurfaceScopeCases) {
  test(`factsFromCompat resolves ${symbol} to ${scope}, not sdk`, () => {
    const compatReport = {
      changes: [
        {
          severity: 'breaking',
          category: 'parameter_type_narrowed',
          symbol,
          message: `Parameter type changed for "x" on "${symbol}"`,
        },
      ],
    };
    const facts = factsFromCompat(compatReport, [], EMPTY_INDEXES);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].scope, scope);
    assert.notEqual(facts[0].scope, 'sdk');
  });
}

// --- IR-backed compat scope resolution (PR #111 regression set) ---
// The emitters synthesize per-operation parameter models the IR never names
// (`SSO.token` + query params → `TokenQuery`), and generated model names like
// `CreatePasswordResetToken` dodge every name rule. Both must resolve through
// the IR instead of hard-failing --strict-scopes as the `sdk` fallback.

const compatBreak = (symbol) => ({
  changes: [{ severity: 'breaking', category: 'symbol_removed', symbol, message: `Symbol "${symbol}" was removed` }],
});

const IR_FIXTURE = {
  models: [{ name: 'CreatePasswordResetToken', fields: [] }, { name: 'TokenBody', fields: [] }],
  enums: [],
  services: [
    {
      name: 'SSO',
      operations: [
        {
          // Query params but no IR-named body: the emitters synthesize
          // `TokenQuery`/`TokenBody`/... from the operation name.
          name: 'token',
          queryParams: [{ name: 'code', type: { kind: 'primitive', name: 'string' } }],
        },
      ],
    },
    {
      name: 'UserManagementUsers',
      operations: [{ name: 'createPasswordResetToken', response: { kind: 'model', name: 'CreatePasswordResetToken' } }],
    },
    {
      name: 'Pipes',
      operations: [{ name: 'vendCredentials', requestBody: { kind: 'model', name: 'TokenBody' } }],
    },
  ],
};

test('factsFromCompat resolves a synthesized param model (TokenQuery) to its operation service via IR', () => {
  const indexes = buildIndexes([IR_FIXTURE, null]);
  const facts = factsFromCompat(compatBreak('TokenQuery'), [], indexes);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].scope, 'sso');
  assert.equal(facts[0].scope_source, 'compat_ir');
});

test('factsFromCompat resolves a generated model with no name rule (CreatePasswordResetToken) via IR', () => {
  const indexes = buildIndexes([IR_FIXTURE, null]);
  const facts = factsFromCompat(compatBreak('CreatePasswordResetToken'), [], indexes);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].scope, 'user_management');
  assert.equal(facts[0].scope_source, 'compat_ir');
});

// A real IR model must win over a synthesized twin: `TokenBody` is a pipes
// request body, and SSO's `token` operation synthesizing `TokenBody` must not
// make it ambiguous.
test('factsFromCompat prefers real IR ownership over a synthesized name collision', () => {
  const indexes = buildIndexes([IR_FIXTURE, null]);
  const facts = factsFromCompat(compatBreak('TokenBody'), [], indexes);
  assert.equal(facts[0].scope, 'pipes');
  assert.equal(facts[0].scope_source, 'compat_ir');
  assert.deepEqual(facts[0].scope_candidates, ['pipes']);
});

// `getProfileAndToken` is oagen's internal rename of `SSO.token`; its derived
// param types have no IR counterpart, so the name rule must catch them.
test('factsFromCompat resolves GetProfileAndTokenParams to sso via the ProfileAndToken name rule', () => {
  const facts = factsFromCompat(compatBreak('GetProfileAndTokenParams.code'), [], EMPTY_INDEXES);
  assert.equal(facts[0].scope, 'sso');
});

// Unresolved symbols are exempt from the per-scope dedup so --strict-scopes
// names every unmapped symbol in one run (no whack-a-mole), while the same
// root reported by several languages still collapses to one fact.
test('factsFromCompat keeps one fact per unresolved root instead of one per scope', () => {
  const report = {
    changes: [
      { severity: 'breaking', category: 'symbol_removed', symbol: 'MysteryOne', message: 'Symbol "MysteryOne" was removed' },
      { severity: 'breaking', category: 'symbol_removed', symbol: 'MysteryOne', message: 'Symbol "MysteryOne" was removed' },
      { severity: 'breaking', category: 'symbol_removed', symbol: 'MysteryTwo', message: 'Symbol "MysteryTwo" was removed' },
    ],
  };
  const facts = factsFromCompat(report, [], EMPTY_INDEXES);
  const sdkFacts = facts.filter((fact) => fact.scope === 'sdk');
  assert.equal(sdkFacts.length, 2);
  assert.deepEqual(sdkFacts.map((fact) => fact.symbols[0]).sort(), ['MysteryOne', 'MysteryTwo']);
});

// Resolved scopes keep the existing one-breaking-fact-per-scope dedup.
test('factsFromCompat still dedups resolved scopes to one breaking fact', () => {
  const report = {
    changes: [
      { severity: 'breaking', category: 'parameter_type_narrowed', symbol: 'SSO.getProfileAndToken', message: 'x' },
      { severity: 'breaking', category: 'symbol_removed', symbol: 'SSOTokenResponse', message: 'y' },
    ],
  };
  const facts = factsFromCompat(report, [], EMPTY_INDEXES);
  assert.equal(facts.filter((fact) => fact.scope === 'sso').length, 1);
});

// --- Direction-aware compat severity (PR #139 regression set) ---
// Policy: breaking means a change to how a function is called — its name,
// parameter names, or argument arrangement. The compat tool's severity is
// direction-blind, so a *widened* parameter type arrives flagged `breaking`
// even though every existing call still compiles. Passing those through forced
// spurious major bumps across all eight SDKs (batch fcf9458a: 3 of Python's 4
// breaking entries were widenings or a surviving alias).

const paramTypeChange = (oldType, newType) => ({
  changes: [
    {
      severity: 'breaking',
      category: 'parameter_type_narrowed',
      symbol: 'SSO.get_profile_and_token',
      old: { parameter: 'code', type: oldType },
      new: { parameter: 'code', type: newType },
      message: 'Parameter type changed for "code" on "SSO.get_profile_and_token"',
    },
  ],
});

const widenings = [
  ['str', 'str | None'], // Python: required -> optional
  ['List<String>', 'List<String>?'], // Kotlin/Swift/C# nullable suffix
  ['string', '?string'], // PHP nullable prefix
  ['A | B', 'A | B | C'], // request union gained a variant
  ['Optional[str]', 'str | None'], // same type, different spelling
];

for (const [oldType, newType] of widenings) {
  test(`factsFromCompat treats widened parameter "${oldType}" -> "${newType}" as non-breaking`, () => {
    assert.equal(factsFromCompat(paramTypeChange(oldType, newType), [], EMPTY_INDEXES).length, 0);
  });
}

// The mirror image must survive: dropping a member callers could already pass
// is a genuine break, and so is swapping the type outright.
const narrowings = [
  ['str | None', 'str'],
  ['A | B | C', 'A | B'],
  ['UpdateAuditLogsRetention', 'UpdateOrganizationAuditLogsRetentionParamsBody'],
];

for (const [oldType, newType] of narrowings) {
  test(`factsFromCompat keeps narrowed parameter "${oldType}" -> "${newType}" breaking`, () => {
    assert.equal(factsFromCompat(paramTypeChange(oldType, newType), [], EMPTY_INDEXES).length, 1);
  });
}

// A parameter rename IS the call shape changing — the one genuine break in
// batch fcf9458a, and the control that proves the widening check is not a
// blanket suppression of the whole category.
test('factsFromCompat keeps a renamed parameter breaking', () => {
  const report = {
    changes: [
      {
        severity: 'breaking',
        category: 'parameter_renamed',
        symbol: 'AuditLogs.update_organization_audit_logs_retention',
        old: { parameter: 'retention_period_in_days' },
        new: { parameter: 'retention' },
        message: 'Parameter "retention_period_in_days" renamed to "retention"',
      },
    ],
  };
  const facts = factsFromCompat(report, [], EMPTY_INDEXES);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].scope, 'audit_logs');
});

// `ValidateApiKey` was deduplicated into a structurally identical type, and the
// Python/Ruby emitters kept the old name working (`ValidateApiKey =
// CreateSAMLIdpSigningCertificate`). The compat tool reports it as removed but
// says otherwise in `remediation`; trust the remediation.
test('factsFromCompat treats a superset-rename removal as non-breaking', () => {
  const report = {
    changes: [
      {
        severity: 'breaking',
        category: 'symbol_removed',
        symbol: 'ValidateApiKey',
        message: 'Symbol "ValidateApiKey" was removed',
        remediation:
          'Type "ValidateApiKey" appears to have been renamed to "CreateSAMLIdpSigningCertificate" — the new type has every field of the old (a non-strict superset).',
      },
    ],
  };
  assert.equal(factsFromCompat(report, [], EMPTY_INDEXES).length, 0);
});

// Without that remediation the removal stands — the guard must not swallow a
// type that really did disappear.
test('factsFromCompat keeps a plain symbol removal breaking', () => {
  assert.equal(factsFromCompat(compatBreak('ValidateApiKey'), [], EMPTY_INDEXES).length, 1);
});

// Emitters decorate inline enums as `<Model><Field>Literal`, which the IR never
// names, so a dropped enum member looked like an unknown owner and fell through
// to the conservative breaking branch. An enum member is not call shape.
test('factsFromCompat resolves a decorated Literal enum owner and drops the member removal', () => {
  const indexes = buildIndexes([{ models: [], enums: [{ name: 'ConnectionType', values: [] }], services: [] }, null]);
  const report = {
    changes: [
      {
        severity: 'breaking',
        category: 'symbol_removed',
        symbol: 'ConnectionTypeLiteral.DiscordOAuth',
        message: 'Symbol "ConnectionTypeLiteral.DiscordOAuth" was removed',
      },
    ],
  };
  assert.equal(factsFromCompat(report, [], indexes).length, 0);
});
