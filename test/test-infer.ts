import assert from 'node:assert/strict';
import { extractFromHar } from '../src/extract.js';
import { inferSchemas } from '../src/infer.js';
import type { JsonSchema } from '../src/types.js';

const FIXTURE_HAR = 'test/fixtures/sample.har';

function hasType(schema: JsonSchema, type: string): boolean {
  if (schema.type === type) return true;
  if (schema.anyOf) return schema.anyOf.some((s) => hasType(s, type));
  if (schema.oneOf) return schema.oneOf.some((s) => hasType(s, type));
  return false;
}

async function main(): Promise<void> {
  const empty = await inferSchemas([]);
  assert.equal(empty.length, 0, 'empty corpora should infer no schemas');

  const corpora = await extractFromHar(FIXTURE_HAR);
  const schemas = await inferSchemas(corpora);

  assert.equal(schemas.length, corpora.length, 'schema count should match method count');
  assert.deepEqual(
    schemas.map((s) => s.methodName),
    corpora.map((c) => c.methodName),
    'schema order should match corpus order',
  );

  for (const schema of schemas) {
    assert.ok(schema.requestSchema.properties, `${schema.methodName} request should be object-like`);
    assert.ok(schema.responseSchema.properties, `${schema.methodName} response should be object-like`);
    assert.ok(
      !JSON.stringify(schema.requestSchema).includes('"$schema"') &&
      !JSON.stringify(schema.responseSchema).includes('"$schema"'),
      'OpenAPI conversion should remove draft-only $schema metadata',
    );
  }

  const getSessions = schemas.find((s) => s.methodName === 'GetSessions');
  assert.ok(getSessions, 'GetSessions schema should exist');
  const bodyIdSchema = getSessions.requestSchema.properties?.BodyId as JsonSchema | undefined;
  assert.ok(bodyIdSchema, 'GetSessions request should contain BodyId');
  assert.ok(hasType(bodyIdSchema, 'integer'), 'BodyId should allow integer');
  assert.ok(hasType(bodyIdSchema, 'null'), 'BodyId should allow null');

  const searchContent = schemas.find((s) => s.methodName === 'SearchContent');
  assert.ok(searchContent, 'SearchContent schema should exist');
  const resultsSchema = searchContent.responseSchema.properties?.Results as JsonSchema | undefined;
  assert.equal(resultsSchema?.type, 'array', 'SearchContent.Results should be an array');
  const resultItem = resultsSchema?.items as JsonSchema | undefined;
  assert.ok(resultItem?.properties?.Type, 'SearchContent result items should have Type');
  assert.ok(resultItem?.properties?.Snippet, 'SearchContent result items should have Snippet');

  console.log('PASS test-infer.ts');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
