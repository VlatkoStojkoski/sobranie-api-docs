/**
 * Test infer.ts with real HAR data.
 * Extracts corpora, runs quicktype inference, checks output shapes.
 */
import { extractFromHar } from '../src/extract.js';
import { inferSchemas } from '../src/infer.js';

const HAR_PATH = 'devproxy-normalized.har';

async function main() {
  console.log('=== Testing infer.ts ===\n');

  const corpora = await extractFromHar(HAR_PATH);
  console.log(`Extracted ${corpora.length} methods\n`);

  console.log('Inferring schemas...');
  const schemas = await inferSchemas(corpora);

  console.log(`\nSchemas inferred: ${schemas.length}`);

  let issues = 0;
  for (const schema of schemas) {
    const hasReqType = schema.requestSchema.type || schema.requestSchema.anyOf || schema.requestSchema.oneOf;
    const hasResType = schema.responseSchema.type || schema.responseSchema.anyOf || schema.responseSchema.oneOf || schema.responseSchema.properties;

    if (!hasReqType) {
      console.error(`  FAIL: ${schema.methodName} request schema has no type/anyOf/oneOf`);
      issues++;
    }
    if (!hasResType) {
      console.error(`  FAIL: ${schema.methodName} response schema has no type/anyOf/oneOf/properties`);
      issues++;
    }
  }

  // Spot check: GetMonthlyAgenda should have properties in its response
  const agenda = schemas.find(s => s.methodName === 'GetMonthlyAgenda');
  if (agenda) {
    const hasItems = agenda.responseSchema.properties?.['Items'] ||
                     agenda.responseSchema.items;
    console.log(`\nSpot check GetMonthlyAgenda response:`);
    console.log(`  type: ${agenda.responseSchema.type}`);
    console.log(`  properties: ${Object.keys(agenda.responseSchema.properties ?? {}).length}`);
    if (agenda.responseSchema.properties) {
      console.log(`  keys: ${Object.keys(agenda.responseSchema.properties).slice(0, 10).join(', ')}`);
    }
  }

  // Spot check: GetAllGenders should be simple
  const genders = schemas.find(s => s.methodName === 'GetAllGenders');
  if (genders) {
    console.log(`\nSpot check GetAllGenders response:`);
    console.log(`  type: ${genders.responseSchema.type}`);
    if (genders.responseSchema.properties) {
      console.log(`  keys: ${Object.keys(genders.responseSchema.properties).join(', ')}`);
    }
  }

  console.log(`\nIssues: ${issues}`);
  console.log(`${issues === 0 ? 'PASS' : 'FAIL'}: infer.ts\n`);
}

main().catch(console.error);
