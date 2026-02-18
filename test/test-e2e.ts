/**
 * End-to-end integration test: full pipeline without interactive prompts.
 *
 * Simulates: extract → infer → value registry → decisions → transform → validate → emit.
 * Uses real HAR data, applies a few mock decisions, checks everything works end-to-end.
 */
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractFromHar } from '../src/extract.js';
import { inferSchemas } from '../src/infer.js';
import { buildValueRegistry, detectSuspects } from '../src/value-registry.js';
import { saveDecisions, loadDecisions, setFieldDecision, addComponent, generateComponentId } from '../src/decisions.js';
import { transformSchemas } from '../src/schema-transform.js';
import { validateSchemas } from '../src/validate.js';
import { emitOpenApi } from '../src/emit.js';
import type { Decisions, SharedComponents } from '../src/types.js';

const HAR_PATH = 'devproxy-normalized.har';

async function main() {
  console.log('=== E2E Integration Test ===\n');

  const tmp = await mkdtemp(join(tmpdir(), 'test-e2e-'));
  let issues = 0;

  // ── Step 1: Extract ──
  console.log('1. Extract...');
  const corpora = await extractFromHar(HAR_PATH);
  const totalSamples = corpora.reduce((s, c) => s + c.samples.length, 0);
  console.log(`   ${corpora.length} methods, ${totalSamples} samples`);

  // Write samples
  const samplesDir = join(tmp, 'samples');
  for (const corpus of corpora) {
    const reqDir = join(samplesDir, corpus.methodName, 'requests');
    const resDir = join(samplesDir, corpus.methodName, 'responses');
    await mkdir(reqDir, { recursive: true });
    await mkdir(resDir, { recursive: true });
    for (const sample of corpus.samples) {
      await writeFile(join(reqDir, `${sample.id}.json`), JSON.stringify(sample.request, null, 2), 'utf-8');
      await writeFile(join(resDir, `${sample.id}.json`), JSON.stringify(sample.response, null, 2), 'utf-8');
    }
  }
  console.log('   Samples written');

  // ── Step 2: Infer ──
  console.log('2. Infer...');
  const schemas = await inferSchemas(corpora);
  console.log(`   ${schemas.length} schemas`);

  // ── Step 3: Value Registry ──
  console.log('3. Value registry...');
  const registry = buildValueRegistry(corpora);
  const suspects = detectSuspects(registry);
  console.log(`   ${registry.size} keys, ${suspects.length} suspects`);

  // ── Step 4: Apply some decisions ──
  console.log('4. Decisions...');
  const decisions: Decisions = { fields: {} };
  const components: SharedComponents = {};

  // Pick 3 suspects and classify them
  let enumCount = 0;
  let fkCount = 0;
  for (const suspect of suspects) {
    if (enumCount >= 2 && fkCount >= 1) break;

    const uniqueCount = suspect.entry.values.size;
    const allStrings = Array.from(suspect.entry.values).every(v => typeof v === 'string');

    // Skip MethodName and very high-cardinality fields
    if (suspect.keyName === 'MethodName') continue;
    if (uniqueCount > 50) continue;

    if (allStrings && uniqueCount <= 10 && enumCount < 2) {
      const id = generateComponentId(components, suspect.keyName, 'enum');
      const vals = Array.from(suspect.entry.values) as string[];
      addComponent(components, id, { kind: 'enum', baseType: 'string', values: vals.sort() });
      setFieldDecision(decisions, suspect.keyName, { kind: 'enum', componentId: id });
      console.log(`   ENUM: ${suspect.keyName} → ${id} (${vals.length} values)`);
      enumCount++;
    } else if (uniqueCount > 10 && fkCount < 1) {
      const id = generateComponentId(components, suspect.keyName, 'fk');
      addComponent(components, id, { kind: 'fk', baseType: 'string', values: [] });
      setFieldDecision(decisions, suspect.keyName, { kind: 'fk', componentId: id });
      console.log(`   FK: ${suspect.keyName} → ${id}`);
      fkCount++;
    }
  }

  // Save + reload decisions
  const decPath = join(tmp, 'decisions.json');
  await saveDecisions(decPath, decisions, components);
  const reloaded = await loadDecisions(decPath);
  console.log(`   Saved/reloaded: ${Object.keys(reloaded.decisions.fields).length} decisions, ${Object.keys(reloaded.components).length} components`);

  // ── Step 5: Transform ──
  console.log('5. Transform...');
  const transformed = transformSchemas(schemas, reloaded.decisions, reloaded.components);
  console.log(`   ${transformed.length} schemas transformed`);

  // ── Step 6: Validate (baseline without $refs) ──
  console.log('6. Validate baseline (no $refs)...');
  const baselineValidation = validateSchemas(corpora, schemas);
  if (!baselineValidation.allPass) {
    console.error(`   WARNING: baseline has ${baselineValidation.failureRecords.length} failures`);
  } else {
    console.log('   ALL PASS (baseline)');
  }

  // ── Step 7: Emit ──
  console.log('7. Emit...');
  const outDir = join(tmp, 'openapi');
  const { rootPath, fileCount } = await emitOpenApi(transformed, reloaded.components, outDir);
  console.log(`   ${fileCount} files emitted`);

  // Verify output
  const rootContent = await readFile(rootPath, 'utf-8');
  if (!rootContent.includes('openapi: 3.0.3')) {
    console.error('   FAIL: root missing version');
    issues++;
  }

  const pathFiles = await readdir(join(outDir, 'paths'));
  if (pathFiles.length !== 36) {
    console.error(`   FAIL: expected 36 path files, got ${pathFiles.length}`);
    issues++;
  }

  const sharedFiles = await readdir(join(outDir, 'schemas', 'shared'));
  if (sharedFiles.length !== Object.keys(reloaded.components).length) {
    console.error(`   FAIL: shared files count mismatch`);
    issues++;
  }

  // Check bundled JSON
  const bundled = JSON.parse(await readFile(join(outDir, 'openapi.bundled.json'), 'utf-8'));
  const bundledPathCount = Object.keys(bundled.paths).length;
  const bundledSchemaCount = Object.keys(bundled.components.schemas).length;
  console.log(`   Bundled: ${bundledPathCount} paths, ${bundledSchemaCount} schemas`);

  // Cleanup
  await rm(tmp, { recursive: true });

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Issues: ${issues}`);
  console.log(`${issues === 0 ? 'PASS' : 'FAIL'}: E2E Integration Test`);
  console.log('═'.repeat(50) + '\n');
}

main().catch(console.error);
