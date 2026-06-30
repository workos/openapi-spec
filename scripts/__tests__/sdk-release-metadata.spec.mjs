import assert from 'node:assert/strict';
import test from 'node:test';

import { factsFromDiff } from '../sdk-release-metadata.mjs';

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
