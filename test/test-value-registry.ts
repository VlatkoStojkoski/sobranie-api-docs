import assert from 'node:assert/strict';
import { extractFromHar } from '../src/extract.js';
import { buildValueRegistry, detectSuspects, valueSetsOverlap, valueSetsEqual } from '../src/value-registry.js';
import { makeScopedFieldKey } from '../src/scoped-field.js';
import type { MethodCorpus } from '../src/types.js';

const FIXTURE_HAR = 'test/fixtures/sample.har';

async function testFixtureRegistry(): Promise<void> {
  const corpora = await extractFromHar(FIXTURE_HAR);
  const registry = buildValueRegistry(corpora);
  const suspects = detectSuspects(registry);

  assert.ok(registry.size > 0, 'registry should contain extracted scoped keys');

  const membersMethodName = registry.get(makeScopedFieldKey('GetMembers', 'request', '$', 'MethodName'));
  assert.ok(membersMethodName, 'MethodName should be tracked per method and side');
  assert.equal(membersMethodName.values.size, 1, 'request.MethodName for one method has a single value');
  assert.equal(membersMethodName.counts.get('GetMembers'), 3);

  const legislationStatusRequest = registry.get(makeScopedFieldKey('GetLegislation', 'request', '$', 'Status'));
  assert.ok(legislationStatusRequest, 'Status in GetLegislation request should exist');
  assert.equal(legislationStatusRequest.counts.get('active'), 1);
  assert.equal(legislationStatusRequest.counts.get('draft'), 1);

  const legislationStatusItems = registry.get(makeScopedFieldKey('GetLegislation', 'response', 'Items[]', 'Status'));
  assert.ok(legislationStatusItems, 'Status under response.Items[] should be tracked separately');
  assert.equal(legislationStatusItems.counts.get('active'), 2);
  assert.equal(legislationStatusItems.counts.get('draft'), 1);

  const legislationStatusFilters = registry.get(makeScopedFieldKey('GetLegislation', 'response', 'Filters', 'Status'));
  assert.ok(legislationStatusFilters, 'Status under response.Filters should be tracked separately');
  assert.equal(legislationStatusFilters.counts.get('active'), 1);
  assert.equal(legislationStatusFilters.counts.get('draft'), 1);

  const statusSuspects = suspects.filter((s) => s.keyName === 'Status');
  assert.ok(
    statusSuspects.some((s) => s.methodName === 'GetLegislation' && s.direction === 'response' && s.parentPath === 'Items[]'),
    'status suspect should be scoped to the repeated parent path only',
  );
  assert.ok(
    !statusSuspects.some((s) => s.methodName === 'GetLegislation' && s.direction === 'request'),
    'request-side status is not a suspect when values do not repeat in that scope',
  );

  assert.ok(
    !suspects.some((s) => s.keyName === 'MethodName'),
    'MethodName is an internal transport field and should not be prompted',
  );

  const sorted = [...suspects].sort(
    (a, b) => (
      a.methodName.localeCompare(b.methodName) ||
      a.direction.localeCompare(b.direction) ||
      a.parentPath.localeCompare(b.parentPath) ||
      a.keyName.localeCompare(b.keyName)
    ),
  );
  assert.deepEqual(
    suspects.map((s) => s.decisionKey),
    sorted.map((s) => s.decisionKey),
    'suspects should be deterministically sorted by method/side/path/key',
  );
}

function testSyntheticLeafCollection(): void {
  const corpora: MethodCorpus[] = [
    {
      methodName: 'Synthetic',
      samples: [
        {
          id: '0',
          request: {
            A: 1,
            Nested: [{ A: '1' }, { B: true }],
            IgnoreNull: null,
          },
          response: {
            B: true,
            Items: [{ C: 'x' }, { C: 'x' }, { C: 'y' }],
          },
        },
      ],
    },
  ];

  const registry = buildValueRegistry(corpora);

  const requestA = registry.get(makeScopedFieldKey('Synthetic', 'request', '$', 'A'));
  assert.equal(requestA?.values.has(1), true, 'numeric values should be tracked');

  const nestedArrayA = registry.get(makeScopedFieldKey('Synthetic', 'request', 'Nested[]', 'A'));
  assert.equal(nestedArrayA?.values.has('1'), true, 'path-scoped values in arrays should be tracked separately');

  const responseC = registry.get(makeScopedFieldKey('Synthetic', 'response', 'Items[]', 'C'));
  assert.equal(responseC?.counts.get('x'), 2, 'nested array leaves should be counted');

  assert.ok(
    !registry.has(makeScopedFieldKey('Synthetic', 'request', '$', 'IgnoreNull')),
    'null leaves should be ignored',
  );

  const suspects = detectSuspects(registry);
  assert.deepEqual(
    suspects.map((s) => s.decisionKey),
    [makeScopedFieldKey('Synthetic', 'response', 'Items[]', 'C')],
    'repeats should be detected per method, side, and parent path',
  );
}

function testSetHelpers(): void {
  const setA = new Set<string | number | boolean>(['a', 1, true]);
  const setB = new Set<string | number | boolean>(['a', 1, true]);
  const setC = new Set<string | number | boolean>(['a', 1]);
  const setD = new Set<string | number | boolean>(['z']);

  assert.equal(valueSetsEqual(setA, setB), true);
  assert.equal(valueSetsEqual(setA, setC), false);
  assert.equal(valueSetsOverlap(setA, setC), true);
  assert.equal(valueSetsOverlap(setA, setD), false);
}

async function main(): Promise<void> {
  await testFixtureRegistry();
  testSyntheticLeafCollection();
  testSetHelpers();
  console.log('PASS test-value-registry.ts');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
