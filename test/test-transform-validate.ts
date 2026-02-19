import assert from 'node:assert/strict';
import { transformSchemas, buildComponentSchemas } from '../src/schema-transform.js';
import { validateSchemas } from '../src/validate.js';
import { makeScopedFieldKey } from '../src/scoped-field.js';
import type { Decisions, MethodCorpus, MethodSchema, SharedComponents, JsonSchema } from '../src/types.js';
import { enumComponentId } from '../src/decisions.js';

async function main(): Promise<void> {
  const schemas: MethodSchema[] = [
    {
      methodName: 'GetItems',
      requestSchema: {
        type: 'object',
        properties: {
          MethodName: { type: 'string' },
          Status: { type: 'string' },
          Nested: {
            type: 'object',
            properties: {
              Status: { type: 'string' },
            },
          },
          Rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                Status: { type: 'string' },
              },
            },
          },
          Count: { type: 'integer' },
        },
        required: ['MethodName', 'Status'],
      },
      responseSchema: {
        type: 'object',
        properties: {
          NullableId: {
            anyOf: [{ type: 'integer' }, { type: 'null' }],
            nullable: true,
          },
          Status: { type: 'string' },
          TypeTitle: { type: 'string' },
          CommitteeIdSource: { type: 'integer' },
          CommitteeTitleSource: { type: 'string' },
        },
        required: ['NullableId', 'Status', 'TypeTitle', 'CommitteeIdSource', 'CommitteeTitleSource'],
      },
    },
  ];

  const decisions: Decisions = {
    fields: {
      [makeScopedFieldKey('GetItems', 'request', '$', 'Status')]: {
        kind: 'enum_value',
        enumName: 'Status',
        componentId: enumComponentId('Status', 'value'),
      },
      [makeScopedFieldKey('GetItems', 'response', '$', 'NullableId')]: { kind: 'fk', componentId: 'Committee.Id' },
      [makeScopedFieldKey('GetItems', 'response', '$', 'TypeTitle')]: {
        kind: 'foreign_value',
        componentId: 'Committee.Title',
      },
      [makeScopedFieldKey('GetItems', 'response', '$', 'CommitteeIdSource')]: {
        kind: 'index_source',
        componentId: 'Committee.Id',
      },
      [makeScopedFieldKey('GetItems', 'response', '$', 'CommitteeTitleSource')]: {
        kind: 'value_source',
        componentId: 'Committee.Title',
      },
      MissingComponent: { kind: 'enum_value', enumName: 'Unknown', componentId: enumComponentId('Unknown', 'value') },
    },
    enums: {
      Status: { ids: [1, 2], values: ['active', 'draft'] },
      Unknown: { ids: [], values: [] },
    },
  };

  const components: SharedComponents = {
    [enumComponentId('Status', 'value')]: {
      kind: 'enum',
      baseType: 'string',
      values: ['active', 'draft'],
      description: 'Status enum',
    },
    'Committee.Id': {
      kind: 'fk',
      baseType: 'integer',
      values: [],
      description: 'Nullable foreign key',
    },
    'Committee.Title': {
      kind: 'foreign_value',
      baseType: 'string',
      values: [],
      description: 'Resolved title from type reference',
    },
    MixedAgendaTypeEnum: {
      kind: 'enum',
      baseType: 'mixed',
      baseTypes: ['integer', 'string'],
      values: [1, 8, 'Предлог закон'],
      description: 'Mixed enum should not force a single type',
    },
    MixedAgendaTypeRef: {
      kind: 'fk',
      baseType: 'mixed',
      baseTypes: ['integer', 'string'],
      values: [],
      description: 'Mixed fk should allow integer or string',
    },
  };

  const transformed = transformSchemas(schemas, decisions, components);
  const transformedRequest = transformed[0]!.requestSchema;
  const transformedResponse = transformed[0]!.responseSchema;

  const topLevelStatus = transformedRequest.properties?.Status as JsonSchema | undefined;
  assert.equal(topLevelStatus?.$ref, `#/components/schemas/${enumComponentId('Status', 'value')}`);

  const nestedStatus = (transformedRequest.properties?.Nested as JsonSchema | undefined)
    ?.properties?.Status as JsonSchema | undefined;
  assert.equal(nestedStatus?.$ref, undefined, 'nested status should not be replaced when parent path differs');

  const rowsStatus = ((transformedRequest.properties?.Rows as JsonSchema | undefined)
    ?.items as JsonSchema | undefined)?.properties?.Status as JsonSchema | undefined;
  assert.equal(rowsStatus?.$ref, undefined, 'array item status should not be replaced when parent path differs');

  const nullableId = transformedResponse.properties?.NullableId as JsonSchema | undefined;
  assert.ok(nullableId?.nullable, 'nullable flag should be preserved when replacing with ref');
  assert.ok(
    nullableId?.anyOf?.some((b) => b.$ref === '#/components/schemas/Committee.Id'),
    'nullable ref should include shared component ref branch',
  );
  assert.equal((nullableId as Record<string, unknown>)['x-relationship'] !== undefined, true);

  const typeTitle = transformedResponse.properties?.TypeTitle as JsonSchema | undefined;
  assert.equal(typeTitle?.$ref, '#/components/schemas/Committee.Title');
  assert.equal((typeTitle as Record<string, unknown>)['x-relationship'] !== undefined, true);

  const idSource = transformedResponse.properties?.CommitteeIdSource as JsonSchema | undefined;
  assert.equal(idSource?.$ref, undefined, 'source fields should keep original schema shape');
  assert.deepEqual(
    (idSource as Record<string, unknown>)['x-relationship'],
    { role: 'source', field: 'Committee.Id' },
  );
  assert.deepEqual(
    (idSource as Record<string, unknown>)['x-model-source'],
    { role: 'source', field: 'Committee.Id' },
  );

  const titleSource = transformedResponse.properties?.CommitteeTitleSource as JsonSchema | undefined;
  assert.equal(titleSource?.$ref, undefined, 'source fields should keep original schema shape');
  assert.deepEqual(
    (titleSource as Record<string, unknown>)['x-relationship'],
    { role: 'source', field: 'Committee.Title' },
  );

  const corpora: MethodCorpus[] = [
    {
      methodName: 'GetItems',
      samples: [
        {
          id: '0',
          request: {
            MethodName: 'GetItems',
            Status: 'active',
            Nested: { Status: 'unexpected-free-text' },
            Rows: [{ Status: 'row-status' }],
            Count: 1,
          },
          response: {
            NullableId: null,
            Status: 'active',
            TypeTitle: 'Committee',
            CommitteeIdSource: 22,
            CommitteeTitleSource: 'Committee',
          },
        },
        {
          id: '1',
          request: {
            MethodName: 'GetItems',
            Status: 'draft',
            Nested: { Status: 'another-text' },
            Rows: [{ Status: 'row-status-2' }],
            Count: 2,
          },
          response: {
            NullableId: 22,
            Status: 'draft',
            TypeTitle: 'Commission',
            CommitteeIdSource: 23,
            CommitteeTitleSource: 'Commission',
          },
        },
      ],
    },
  ];

  const passing = validateSchemas(corpora, transformed, components);
  assert.equal(passing.allPass, true, 'shared refs should validate when bundled for Ajv');

  const failingCorpora: MethodCorpus[] = [
    {
      methodName: 'GetItems',
      samples: [
        {
          id: 'bad',
          request: { MethodName: 'GetItems', Status: 'invalid' },
          response: {
            NullableId: 'not-an-integer',
            Status: 'invalid',
            TypeTitle: 123,
            CommitteeIdSource: 'bad',
            CommitteeTitleSource: 999,
          },
        },
      ],
    },
  ];

  const failing = validateSchemas(failingCorpora, transformed, components);
  assert.equal(failing.allPass, false, 'invalid enum/fk/foreign_value values should fail validation');
  assert.ok(failing.results[0]!.requestFailures.length > 0);
  assert.ok(failing.results[0]!.responseFailures.length > 0);

  const missingSchema = validateSchemas(
    [{ methodName: 'UnknownMethod', samples: [{ id: '0', request: {}, response: {} }] }],
    [],
    components,
  );
  assert.equal(missingSchema.allPass, false);
  assert.equal(missingSchema.failureRecords[0]!.requestErrors[0], 'No schema found');

  const componentSchemas = buildComponentSchemas(components);
  assert.deepEqual(componentSchemas[enumComponentId('Status', 'value')]?.enum, ['active', 'draft']);
  assert.equal(componentSchemas['Committee.Id']?.type, 'integer');
  assert.equal(componentSchemas['Committee.Id']?.enum, undefined);
  assert.deepEqual(
    componentSchemas.MixedAgendaTypeEnum?.enum,
    [1, 8, 'Предлог закон'],
    'mixed enums should preserve values',
  );
  assert.equal(
    componentSchemas.MixedAgendaTypeEnum?.type,
    undefined,
    'mixed enums should omit single-type restriction',
  );
  assert.ok(
    Array.isArray(componentSchemas.MixedAgendaTypeRef?.oneOf),
    'mixed fk refs should emit oneOf types',
  );
  assert.equal(
    componentSchemas['Committee.Title']?.type,
    'string',
    'foreign value components should emit scalar type schemas',
  );

  console.log('PASS test-transform-validate.ts');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
