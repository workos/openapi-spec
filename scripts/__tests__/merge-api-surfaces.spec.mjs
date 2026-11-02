import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeApiSurfaces, missingParameters, summarize } from '../merge-api-surfaces.mjs';

const method = (name, params) => [
  {
    name,
    async: false,
    returnType: 'mixed',
    params: params.map((p) => ({ name: p.replace(/\?$/, ''), optional: p.endsWith('?'), type: 'mixed' })),
  },
];

const cls = (name, methods, constructorParams = []) => ({
  name,
  properties: {},
  constructorParams,
  methods: Object.fromEntries(Object.entries(methods).map(([m, params]) => [m, method(m, params)])),
});

const surface = (classes, rest = {}) => ({
  language: 'php',
  extractedFrom: 'x',
  extractedAt: '',
  classes,
  interfaces: {},
  typeAliases: {},
  enums: {},
  exports: {},
  ...rest,
});

// workos-php: v9.5.0 (HEAD) shipped getProfileAndToken with $codeVerifier at its spec
// position and the Pipes upsert with every parameter gone; v9.4.0 is the repair ref.
const head = surface({
  SSO: cls('SSO', {
    getProfileAndToken: ['code?', 'codeVerifier?', 'subjectToken?', 'subjectTokenType?', 'organizationId?', 'options?'],
  }),
  Pipes: cls('Pipes', { updateDataIntegrationApiKey: ['slug', 'options?'] }),
});
const repair = surface({
  SSO: cls('SSO', {
    getProfileAndToken: ['code?', 'subjectToken?', 'subjectTokenType?', 'organizationId?', 'options?'],
  }),
  Pipes: cls('Pipes', {
    updateDataIntegrationApiKey: [
      'slug',
      'userId',
      'secret',
      'organizationId?',
      'connectedAccountId?',
      'connectionOwner?',
      'options?',
    ],
  }),
});

const names = (merged, className, m) => merged.classes[className].methods[m][0].params.map((p) => p.name);

test('a method HEAD only added parameters to keeps HEAD signature', () => {
  const { surface: merged, repaired } = mergeApiSurfaces(head, repair);
  assert.deepEqual(names(merged, 'SSO', 'getProfileAndToken'), [
    'code',
    'codeVerifier',
    'subjectToken',
    'subjectTokenType',
    'organizationId',
    'options',
  ]);
  assert.ok(!repaired.some((r) => r.className === 'SSO'));
});

test('a method HEAD lost parameters on takes the repair signature and is reported', () => {
  const { surface: merged, repaired } = mergeApiSurfaces(head, repair);
  assert.deepEqual(names(merged, 'Pipes', 'updateDataIntegrationApiKey'), [
    'slug',
    'userId',
    'secret',
    'organizationId',
    'connectedAccountId',
    'connectionOwner',
    'options',
  ]);
  assert.deepEqual(repaired, [
    {
      className: 'Pipes',
      method: 'updateDataIntegrationApiKey',
      missing: ['userId', 'secret', 'organizationId', 'connectedAccountId', 'connectionOwner'],
    },
  ]);
});

test('a method or class only the repair ref has is added and reported as missing', () => {
  const extra = surface({
    SSO: cls('SSO', { getProfile: ['options?'], ping: [] }),
    Portal: cls('Portal', { generateLink: ['organization', 'options?'] }),
  });
  const { surface: merged, repaired } = mergeApiSurfaces(head, extra);
  assert.deepEqual(names(merged, 'SSO', 'getProfile'), ['options']);
  // A zero-argument method HEAD lacks is still a missing method.
  assert.deepEqual(names(merged, 'SSO', 'ping'), []);
  assert.deepEqual(names(merged, 'Portal', 'generateLink'), ['organization', 'options']);
  assert.deepEqual(repaired, [
    { className: 'SSO', method: 'getProfile', missing: [] },
    { className: 'SSO', method: 'ping', missing: [] },
    { className: 'Portal', method: 'generateLink', missing: [] },
  ]);
  assert.match(summarize(repaired, 'v9.4.0'), /SSO\.ping \(missing from HEAD\)/);
});

test('a zero-argument method both surfaces have, and an empty repair overload list, change nothing', () => {
  const both = surface({ SSO: cls('SSO', { ping: [] }) });
  const emptyOverloads = surface({ SSO: { ...cls('SSO', {}), methods: { ping: [] } } });
  assert.deepEqual(mergeApiSurfaces(both, both).repaired, []);
  assert.deepEqual(mergeApiSurfaces(both, emptyOverloads).repaired, []);
  assert.deepEqual(names(mergeApiSurfaces(both, emptyOverloads).surface, 'SSO', 'ping'), []);
});

test('constructor parameters follow the same rule', () => {
  const headCtor = surface({ Params: cls('Params', {}, [{ name: 'code', optional: false, type: 'string' }]) });
  const repairCtor = surface({
    Params: cls('Params', {}, [
      { name: 'code', optional: false, type: 'string' },
      { name: 'verifier', optional: false, type: 'string' },
    ]),
  });
  const { surface: merged, repaired } = mergeApiSurfaces(headCtor, repairCtor);
  assert.deepEqual(
    merged.classes.Params.constructorParams.map((p) => p.name),
    ['code', 'verifier'],
  );
  assert.deepEqual(repaired, [{ className: 'Params', method: 'constructor', missing: ['verifier'] }]);
  // Reversed, HEAD only added one: HEAD wins.
  assert.deepEqual(mergeApiSurfaces(repairCtor, headCtor).repaired, []);
});

test('interfaces, enums, type aliases and exports are HEAD only, and the inputs are not mutated', () => {
  const before = JSON.stringify([head, repair]);
  const headRest = surface(head.classes, { enums: { A: { members: ['x'] } }, exports: { 'lib/x.php': ['A'] } });
  const repairRest = surface(repair.classes, { enums: { B: { members: ['y'] } }, interfaces: { I: {} } });
  const { surface: merged } = mergeApiSurfaces(headRest, repairRest);
  assert.deepEqual(merged.enums, { A: { members: ['x'] } });
  assert.deepEqual(merged.interfaces, {});
  assert.deepEqual(merged.exports, { 'lib/x.php': ['A'] });
  assert.equal(JSON.stringify([head, repair]), before);
});

test('missingParameters reads the first overload and never regresses onto an absent repair signature', () => {
  assert.deepEqual(missingParameters(method('m', ['a', 'b?']), method('m', ['a', 'c?'])), ['c']);
  assert.deepEqual(missingParameters(undefined, method('m', ['a'])), ['a']);
  assert.deepEqual(missingParameters(method('m', ['a']), undefined), []);
  assert.deepEqual(missingParameters(method('m', ['a']), []), []);
});

test('the summary names every overlaid signature and what HEAD lacked', () => {
  const { repaired } = mergeApiSurfaces(head, repair);
  assert.equal(
    summarize(repaired, 'v9.4.0'),
    "merge-api-surfaces: baseline is HEAD's surface with 1 signature(s) overlaid from v9.4.0: " +
      'Pipes.updateDataIntegrationApiKey (HEAD lacks userId, secret, organizationId, connectedAccountId, connectionOwner)',
  );
  assert.match(summarize([], 'v9.4.0'), /overlays nothing/);
});

// workos-kotlin: v7.5.0 (HEAD) inserted codeVerifier ahead of v7.4.0's slots, added
// finishConnection, and emptied the Pipes upsert; v7.4.0 is the repair ref.
const kotlinHead = surface({
  SSO: cls('SSO', {
    getProfileAndToken: ['code?', 'codeVerifier?', 'subjectToken?', 'subjectTokenType?', 'organizationId?', 'requestOptions?'],
  }),
  Pipes: cls('Pipes', {
    finishConnection: ['connectCode', 'codeVerifier', 'state?', 'requestOptions?'],
    updateDataIntegrationApiKey: ['slug', 'requestOptions?'],
    deleteUserConnectedAccount: ['userId', 'slug', 'requestOptions?'],
  }),
});
const kotlinRepair = surface({
  SSO: cls('SSO', {
    getProfileAndToken: ['code?', 'subjectToken?', 'subjectTokenType?', 'organizationId?', 'requestOptions?'],
  }),
  Pipes: cls(
    'Pipes',
    {
      updateDataIntegrationApiKey: ['slug', 'userId', 'secret', 'organizationId?', 'connectedAccountId?', 'connectionOwner?', 'requestOptions?'],
      deleteUserConnectedAccount: ['userId', 'slug', 'requestOptions?'],
    },
    [{ name: 'workos', optional: false, type: 'WorkOS' }],
  ),
});

test('overlay mode keeps a signature HEAD only reordered', () => {
  const { surface: merged, repaired } = mergeApiSurfaces(kotlinHead, kotlinRepair);
  assert.deepEqual(names(merged, 'SSO', 'getProfileAndToken'), ['code', 'codeVerifier', 'subjectToken', 'subjectTokenType', 'organizationId', 'requestOptions']);
  assert.deepEqual(repaired.map((r) => `${r.className}.${r.method}`), ['Pipes.updateDataIntegrationApiKey', 'Pipes.constructor']);
});

test('restore mode takes the tag signature wherever the tag has the method and keeps the methods it lacks', () => {
  const before = JSON.stringify([kotlinHead, kotlinRepair]);
  const { surface: merged, repaired } = mergeApiSurfaces(kotlinHead, kotlinRepair, { mode: 'restore' });
  // Reordered by HEAD: the tag's order comes back.
  assert.deepEqual(names(merged, 'SSO', 'getProfileAndToken'), ['code', 'subjectToken', 'subjectTokenType', 'organizationId', 'requestOptions']);
  // Regressed in HEAD: restored as in overlay mode.
  assert.deepEqual(names(merged, 'Pipes', 'updateDataIntegrationApiKey'), ['slug', 'userId', 'secret', 'organizationId', 'connectedAccountId', 'connectionOwner', 'requestOptions']);
  // Added since the tag: HEAD's signature, which handing the emitter the tag alone would drop.
  assert.deepEqual(names(merged, 'Pipes', 'finishConnection'), ['connectCode', 'codeVerifier', 'state', 'requestOptions']);
  // Identical in both: untouched and not reported.
  assert.deepEqual(names(merged, 'Pipes', 'deleteUserConnectedAccount'), ['userId', 'slug', 'requestOptions']);
  assert.deepEqual(merged.classes.Pipes.constructorParams.map((p) => p.name), ['workos']);
  assert.deepEqual(
    repaired.map(({ className, method, missing }) => `${className}.${method}:${missing.join(',')}`),
    ['SSO.getProfileAndToken:', 'Pipes.updateDataIntegrationApiKey:userId,secret,organizationId,connectedAccountId,connectionOwner', 'Pipes.constructor:workos'],
  );
  assert.equal(JSON.stringify([kotlinHead, kotlinRepair]), before);
});

test('restore mode leaves everything that is not a signature to HEAD', () => {
  const headRest = surface(kotlinHead.classes, { enums: { A: { members: ['x'] } }, exports: { 'a.kt': ['A'] } });
  const repairRest = surface(kotlinRepair.classes, { enums: { B: { members: ['y'] } }, interfaces: { I: {} }, typeAliases: { T: {} } });
  const { surface: merged } = mergeApiSurfaces(headRest, repairRest, { mode: 'restore' });
  assert.deepEqual(merged.enums, { A: { members: ['x'] } });
  assert.deepEqual(merged.interfaces, {});
  assert.deepEqual(merged.typeAliases, {});
  assert.deepEqual(merged.exports, { 'a.kt': ['A'] });
});

test('an unknown mode is rejected', () => {
  assert.throws(() => mergeApiSurfaces(kotlinHead, kotlinRepair, { mode: 'replace' }), /unknown mode replace/);
});

test('the restore summary names reordered and regressed signatures and says the tag wins', () => {
  const { repaired } = mergeApiSurfaces(kotlinHead, kotlinRepair, { mode: 'restore' });
  assert.equal(
    summarize(repaired, 'v7.4.0', 'restore'),
    "merge-api-surfaces: baseline is HEAD's surface with 3 signature(s) restored from v7.4.0 (restore mode: the tag wins wherever it has the method): " +
      'SSO.getProfileAndToken (HEAD reordered); ' +
      'Pipes.updateDataIntegrationApiKey (HEAD lacks userId, secret, organizationId, connectedAccountId, connectionOwner); ' +
      'Pipes.constructor (HEAD lacks workos)',
  );
  assert.match(summarize([], 'v7.4.0', 'restore'), /restores nothing/);
});
