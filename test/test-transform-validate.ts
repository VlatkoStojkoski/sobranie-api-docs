import assert from 'node:assert/strict';
import { transformSchemas, buildComponentSchemas } from '../src/schema-transform.js';
import { validateSchemas } from '../src/validate.js';
import { makeScopedFieldKey } from '../src/scoped-field.js';
import type { Decisions, MethodCorpus, MethodSchema, SharedComponents, JsonSchema } from '../src/types.js';

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
          TypeTitle: { type: 'string' },
          CommitteeRef: { type: 'integer' },
        },
        required: ['NullableId', 'TypeTitle', 'CommitteeRef'],
      },
    },
  ];

  const decisions: Decisions = {
    fields: {
      [makeScopedFieldKey('GetItems', 'request', '$', 'Status')]: {
        kind: 'source',
        sourceFieldId: 'Status.Value',
      },
      [makeScopedFieldKey('GetItems', 'response', '$', 'NullableId')]: {
        kind: 'source_reference',
        sourceFieldId: 'Committee.Id',
        referenceFieldId: 'Committee.Id',
      },
      [makeScopedFieldKey('GetItems', 'response', '$', 'TypeTitle')]: {
        kind: 'source',
        sourceFieldId: 'Committee.Title',
      },
      [makeScopedFieldKey('GetItems', 'response', '$', 'CommitteeRef')]: {
        kind: 'reference',
        referenceFieldId: 'Committee.Id',
      },
    },
  };

  const components: SharedComponents = {
    'Status.Value': {
      kind: 'field',
      baseType: 'string',
      values: ['active', 'draft'],
      description: 'Status text',
    },
    'Committee.Id': {
      kind: 'field',
      baseType: 'integer',
      values: [1, 2, 3],
      description: 'Committee identifier',
    },
    'Committee.Title': {
      kind: 'field',
      baseType: 'string',
      values: ['Committee', 'Commission'],
      description: 'Committee title',
    },
    'Agenda.Mixed': {
      kind: 'field',
      baseType: 'mixed',
      baseTypes: ['integer', 'string'],
      values: [1, 'Draft'],
      description: 'Mixed model field',
    },
  };

  const transformed = transformSchemas(schemas, decisions, components);
  const transformedRequest = transformed[0]!.requestSchema;
  const transformedResponse = transformed[0]!.responseSchema;

  const topLevelStatus = transformedRequest.properties?.Status as JsonSchema | undefined;
  assert.equal(topLevelStatus?.$ref, '#/components/schemas/Status.Value');
  assert.deepEqual((topLevelStatus as Record<string, unknown>)['x-model-source'], { role: 'source', field: 'Status.Value' });

  const nestedStatus = (transformedRequest.properties?.Nested as JsonSchema | undefined)
    ?.properties?.Status as JsonSchema | undefined;
  assert.equal(nestedStatus?.$ref, undefined, 'nested status should not be replaced when parent path differs');

  const nullableId = transformedResponse.properties?.NullableId as JsonSchema | undefined;
  assert.ok(nullableId?.nullable, 'nullable flag should be preserved when replacing with ref');
  assert.ok(
    nullableId?.anyOf?.some((branch) => branch.$ref === '#/components/schemas/Committee.Id'),
    'nullable source-ref should include component ref branch',
  );
  assert.deepEqual(
    (nullableId as Record<string, unknown>)['x-model-source'],
    { role: 'source', field: 'Committee.Id' },
  );
  assert.deepEqual(
    (nullableId as Record<string, unknown>)['x-relationship'],
    { role: 'reference', field: 'Committee.Id' },
  );

  const typeTitle = transformedResponse.properties?.TypeTitle as JsonSchema | undefined;
  assert.equal(typeTitle?.$ref, '#/components/schemas/Committee.Title');
  assert.deepEqual(
    (typeTitle as Record<string, unknown>)['x-model-source'],
    { role: 'source', field: 'Committee.Title' },
  );

  const committeeRef = transformedResponse.properties?.CommitteeRef as JsonSchema | undefined;
  assert.equal(committeeRef?.$ref, undefined, 'reference-only should keep inline schema');
  assert.deepEqual(
    (committeeRef as Record<string, unknown>)['x-relationship'],
    { role: 'reference', field: 'Committee.Id' },
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
            Nested: { Status: 'free-text' },
          },
          response: {
            NullableId: null,
            TypeTitle: 'Committee',
            CommitteeRef: 22,
          },
        },
        {
          id: '1',
          request: {
            MethodName: 'GetItems',
            Status: 'draft',
            Nested: { Status: 'another-text' },
          },
          response: {
            NullableId: 22,
            TypeTitle: 'Commission',
            CommitteeRef: 44,
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
          request: { MethodName: 'GetItems', Status: 123 },
          response: {
            NullableId: 'not-an-integer',
            TypeTitle: 999,
            CommitteeRef: 'bad',
          },
        },
      ],
    },
  ];

  const failing = validateSchemas(failingCorpora, transformed, components);
  assert.equal(failing.allPass, false, 'invalid model field values should fail validation');
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
  assert.equal(componentSchemas['Committee.Id']?.type, 'integer');
  assert.equal(componentSchemas['Committee.Title']?.type, 'string');
  assert.ok(
    Array.isArray(componentSchemas['Agenda.Mixed']?.oneOf),
    'mixed model fields should emit oneOf types',
  );

  console.log('PASS test-transform-validate.ts');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
