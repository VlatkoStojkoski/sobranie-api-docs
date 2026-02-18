/**
 * Test emit.ts: multi-file OpenAPI output with real data.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractFromHar } from '../src/extract.js';
import { inferSchemas } from '../src/infer.js';
import { emitOpenApi } from '../src/emit.js';
import type { SharedComponents } from '../src/types.js';

const HAR_PATH = 'devproxy-normalized.har';

async function main() {
  console.log('=== Testing emit.ts ===\n');

  const corpora = await extractFromHar(HAR_PATH);
  const schemas = await inferSchemas(corpora);

  // Add some shared components
  const components: SharedComponents = {
    StatusTitleEnum: { kind: 'enum', baseType: 'string', values: ['Active', 'Closed'] },
    CommitteeIdRef: { kind: 'fk', baseType: 'string', values: [] },
  };

  const tmp = await mkdtemp(join(tmpdir(), 'test-emit-'));
  let issues = 0;

  console.log('Emitting...');
  const { rootPath, fileCount } = await emitOpenApi(schemas, components, tmp);
  console.log(`  Root: ${rootPath}`);
  console.log(`  Files: ${fileCount}`);

  // Check root exists and is valid YAML
  const rootContent = await readFile(rootPath, 'utf-8');
  if (!rootContent.includes('openapi: 3.0.3')) {
    console.error('  FAIL: root missing openapi version');
    issues++;
  }
  if (!rootContent.includes('Sobranie.mk RPC API')) {
    console.error('  FAIL: root missing title');
    issues++;
  }
  console.log('  Root YAML valid');

  // Check paths directory
  const pathFiles = await readdir(join(tmp, 'paths'));
  if (pathFiles.length !== schemas.length) {
    console.error(`  FAIL: expected ${schemas.length} path files, got ${pathFiles.length}`);
    issues++;
  }
  console.log(`  Path files: ${pathFiles.length}`);

  // Check schema directories
  const schemaDirs = await readdir(join(tmp, 'schemas'));
  const methodDirs = schemaDirs.filter(d => d !== 'shared');
  if (methodDirs.length !== schemas.length) {
    console.error(`  FAIL: expected ${schemas.length} schema dirs, got ${methodDirs.length}`);
    issues++;
  }
  console.log(`  Schema dirs: ${methodDirs.length} methods + shared`);

  // Check shared dir has our components
  const sharedFiles = await readdir(join(tmp, 'schemas', 'shared'));
  if (sharedFiles.length !== 2) {
    console.error(`  FAIL: expected 2 shared files, got ${sharedFiles.length}`);
    issues++;
  }
  console.log(`  Shared files: ${sharedFiles.join(', ')}`);

  // Check bundled JSON exists and has all methods
  const bundledPath = join(tmp, 'openapi.bundled.json');
  const bundled = JSON.parse(await readFile(bundledPath, 'utf-8'));
  const bundledPaths = Object.keys(bundled.paths ?? {});
  if (bundledPaths.length !== schemas.length) {
    console.error(`  FAIL: bundled has ${bundledPaths.length} paths, expected ${schemas.length}`);
    issues++;
  }
  const bundledSchemas = Object.keys(bundled.components?.schemas ?? {});
  // Should have request + response per method + 2 shared
  const expectedSchemas = schemas.length * 2 + 2;
  if (bundledSchemas.length !== expectedSchemas) {
    console.error(`  FAIL: bundled has ${bundledSchemas.length} schemas, expected ${expectedSchemas}`);
    issues++;
  }
  console.log(`  Bundled JSON: ${bundledPaths.length} paths, ${bundledSchemas.length} schemas`);

  // Spot check: a path file should reference the correct schema
  const samplePathContent = await readFile(join(tmp, 'paths', 'GetMonthlyAgenda.yaml'), 'utf-8');
  if (!samplePathContent.includes('GetMonthlyAgenda')) {
    console.error('  FAIL: path file missing method reference');
    issues++;
  }
  console.log('  Path content spot check OK');

  // Spot check: a Request.yaml should have type info
  const sampleReq = await readFile(join(tmp, 'schemas', 'GetMonthlyAgenda', 'Request.yaml'), 'utf-8');
  if (!sampleReq.includes('type:')) {
    console.error('  FAIL: request schema missing type');
    issues++;
  }
  console.log('  Schema content spot check OK');

  await rm(tmp, { recursive: true });

  console.log(`\nIssues: ${issues}`);
  console.log(`${issues === 0 ? 'PASS' : 'FAIL'}: emit.ts\n`);
}

main().catch(console.error);
