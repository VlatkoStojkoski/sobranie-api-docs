import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { emitOpenApi } from '../src/emit.js';
import type { MethodSchema, SharedComponents } from '../src/types.js';

async function main(): Promise<void> {
  const outputDir = await mkdtemp(join(tmpdir(), 'emit-test-'));

  const schemas: MethodSchema[] = [
    {
      methodName: 'Get Members',
      requestSchema: {
        type: 'object',
        properties: { MethodName: { type: 'string' } },
      },
      responseSchema: {
        type: 'object',
        properties: { Items: { type: 'array', items: { type: 'string' } } },
      },
    },
    {
      methodName: 'Get/Sessions?',
      requestSchema: {
        type: 'object',
        properties: { Year: { type: 'integer' } },
      },
      responseSchema: {
        type: 'object',
        properties: { Total: { type: 'integer' } },
      },
    },
  ];

  const components: SharedComponents = {
    'Status.Value': { kind: 'field', baseType: 'string', values: ['active', 'draft'] },
    'Committee.Id': { kind: 'field', baseType: 'integer', values: [] },
  };

  try {
    const result = await emitOpenApi(schemas, components, outputDir);
    assert.ok(result.rootPath.endsWith('openapi.yaml'));
    assert.equal(result.fileCount, 12, 'expected shared + model + per-method + root + bundled file count');

    await stat(join(outputDir, 'openapi.yaml'));
    await stat(join(outputDir, 'openapi.bundled.json'));

    const pathFiles = await readdir(join(outputDir, 'paths'));
    assert.deepEqual(pathFiles.sort(), ['Get_Members.yaml', 'Get_Sessions_.yaml']);

    const sharedFiles = await readdir(join(outputDir, 'schemas', 'shared'));
    assert.deepEqual(sharedFiles.sort(), ['Committee.Id.yaml', 'Status.Value.yaml']);
    const modelFiles = await readdir(join(outputDir, 'schemas', 'models'));
    assert.deepEqual(modelFiles.sort(), ['Committee.yaml', 'Status.yaml']);

    const rootDoc = yaml.load(await readFile(join(outputDir, 'openapi.yaml'), 'utf-8')) as Record<string, any>;
    assert.equal(rootDoc.openapi, '3.0.3');
    assert.ok(rootDoc.paths['/rpc/Get_Members']);
    assert.ok(rootDoc.paths['/rpc/Get_Sessions_']);
    assert.equal(rootDoc.components.schemas['Status.Value'].$ref, 'schemas/shared/Status.Value.yaml');

    const bundled = JSON.parse(await readFile(join(outputDir, 'openapi.bundled.json'), 'utf-8')) as Record<string, any>;
    assert.ok(bundled.paths['/rpc/Get_Members']);
    assert.ok(bundled.paths['/rpc/Get_Sessions_']);
    assert.equal(bundled.components.schemas['Status.Value'].type, 'string');
    assert.equal(bundled.components.schemas['Committee.Id'].type, 'integer');

    const pathDoc = yaml.load(await readFile(join(outputDir, 'paths', 'Get_Sessions_.yaml'), 'utf-8')) as Record<string, any>;
    assert.equal(pathDoc.post.operationId, 'Get_Sessions_');
    assert.equal(
      pathDoc.post.responses['200'].content['application/json'].schema.$ref,
      '../schemas/Get_Sessions_/Response.yaml',
    );

    console.log('PASS test-emit.ts');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
