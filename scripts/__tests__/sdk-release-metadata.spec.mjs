import assert from 'node:assert/strict';
import test from 'node:test';

import { factsFromDiff, scopesForServices } from '../sdk-release-metadata.mjs';

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
