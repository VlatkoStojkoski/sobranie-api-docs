import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractFromHar } from '../src/extract.js';
import { inferSchemas } from '../src/infer.js';
import { buildValueRegistry, detectSuspects } from '../src/value-registry.js';
import { setFieldDecision, addComponent, enumComponentId } from '../src/decisions.js';
import { transformSchemas } from '../src/schema-transform.js';
import { validateSchemas } from '../src/validate.js';
import { emitOpenApi } from '../src/emit.js';
import type { Decisions, SharedComponents } from '../src/types.js';

const FIXTURE_HAR = 'test/fixtures/sample.har';

async function main(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'e2e-test-'));

  try {
    const corpora = await extractFromHar(FIXTURE_HAR);
    assert.equal(corpora.length, 4);

    const schemas = await inferSchemas(corpora);
    assert.equal(schemas.length, 4);

    const registry = buildValueRegistry(corpora);
    const suspects = detectSuspects(registry);
    assert.ok(suspects.length > 0);

    const decisions: Decisions = { fields: {}, enums: {} };
    const components: SharedComponents = {};

    const legislationResponseStatus = suspects.find(
      (s) => s.keyName === 'Status' && s.methodName === 'GetLegislation' && s.direction === 'response',
    );
    const sessionsResponseStatus = suspects.find(
      (s) => s.keyName === 'Status' && s.methodName === 'GetSessions' && s.direction === 'response',
    );
    assert.ok(legislationResponseStatus, 'fixture should produce scoped Status suspect for GetLegislation response');
    assert.ok(sessionsResponseStatus, 'fixture should produce scoped Status suspect for GetSessions response');

    const statusValues = [...legislationResponseStatus.entry.values, ...sessionsResponseStatus.entry.values]
      .filter((value): value is string => typeof value === 'string')
      .sort((a, b) => a.localeCompare(b))
      .filter((v, i, arr) => (i === 0 ? true : v !== arr[i - 1]));

    const statusEnumComponent = enumComponentId('Status', 'value');
    addComponent(components, statusEnumComponent, {
      kind: 'enum',
      baseType: 'string',
      values: statusValues,
    });
    decisions.enums.Status = { ids: [], values: statusValues };
    // Two scoped fields can intentionally share a single component.
    setFieldDecision(decisions, legislationResponseStatus.decisionKey, {
      kind: 'enum_value',
      enumName: 'Status',
      componentId: statusEnumComponent,
    });
    setFieldDecision(decisions, sessionsResponseStatus.decisionKey, {
      kind: 'enum_value',
      enumName: 'Status',
      componentId: statusEnumComponent,
    });

    const transformed = transformSchemas(schemas, decisions, components);
    const transformedJson = JSON.stringify(transformed);
    assert.ok(
      transformedJson.includes(`#/components/schemas/${statusEnumComponent}`),
      'transformed schemas should include shared enum refs',
    );

    const validation = validateSchemas(corpora, transformed, components);
    assert.equal(validation.allPass, true, 'all observed samples should validate after transform');

    const outDir = join(tmp, 'openapi');
    const emitted = await emitOpenApi(transformed, components, outDir);
    assert.ok(emitted.fileCount > 0);

    const root = await readFile(join(outDir, 'openapi.yaml'), 'utf-8');
    assert.ok(root.includes('openapi: 3.0.3'));

    const paths = await readdir(join(outDir, 'paths'));
    assert.equal(paths.length, schemas.length);

    const shared = await readdir(join(outDir, 'schemas', 'shared'));
    assert.deepEqual(shared, [`${statusEnumComponent}.yaml`]);

    const bundled = JSON.parse(await readFile(join(outDir, 'openapi.bundled.json'), 'utf-8')) as Record<string, any>;
    assert.equal(Object.keys(bundled.paths).length, schemas.length);
    assert.ok(bundled.components.schemas[statusEnumComponent].enum.length > 0);

    console.log('PASS test-e2e.ts');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
