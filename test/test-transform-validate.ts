/**
 * Test schema-transform.ts and validate.ts together with real data.
 *
 * 1. Extract + infer (quicktype)
 * 2. Validate with NO decisions (baseline — must pass)
 * 3. Apply some enum/FK decisions
 * 4. Validate transformed schemas (must still pass)
 */
import { extractFromHar } from '../src/extract.js';
import { inferSchemas } from '../src/infer.js';
import { buildValueRegistry, detectSuspects } from '../src/value-registry.js';
import { transformSchemas, buildComponentSchemas } from '../src/schema-transform.js';
import { validateSchemas } from '../src/validate.js';
import type { Decisions, SharedComponents, JsonSchema } from '../src/types.js';

const HAR_PATH = 'devproxy-normalized.har';

async function main() {
  console.log('=== Testing schema-transform.ts + validate.ts ===\n');

  const corpora = await extractFromHar(HAR_PATH);
  const schemas = await inferSchemas(corpora);
  let issues = 0;

  // ── Baseline validation (no transforms) ──
  console.log('Baseline validation (quicktype schemas, no transforms)...');
  const baseline = validateSchemas(corpora, schemas);
  let baselineFailCount = 0;
  for (const r of baseline.results) {
    if (!r.pass) {
      baselineFailCount++;
      const reqFails = r.requestFailures.length;
      const resFails = r.responseFailures.length;
      console.log(`  FAIL: ${r.methodName} (req: ${reqFails}, res: ${resFails})`);
      for (const f of r.responseFailures.slice(0, 2)) {
        console.log(`    ${f.errors[0]}`);
      }
    }
  }

  if (baseline.allPass) {
    console.log('  All 36 methods PASS baseline validation');
  } else {
    console.log(`  ${baselineFailCount} method(s) failed baseline`);
    // This is not necessarily a bug in our code — quicktype can produce
    // schemas that are too strict for some edge cases
    issues++;
  }

  // ── Transform with decisions ──
  console.log('\nApplying enum/FK decisions...');

  const registry = buildValueRegistry(corpora);
  const suspects = detectSuspects(registry);

  // Pick a few suspects that look like real enums for testing
  const decisions: Decisions = { fields: {} };
  const components: SharedComponents = {};

  // Find a good candidate: a field with low cardinality that's clearly an enum
  const descriptionTypeTitle = suspects.find(s => s.keyName === 'DescriptionTypeTitle');
  if (descriptionTypeTitle) {
    const vals = Array.from(descriptionTypeTitle.entry.values) as string[];
    decisions.fields['DescriptionTypeTitle'] = { kind: 'enum', componentId: 'DescriptionTypeTitleEnum' };
    components['DescriptionTypeTitleEnum'] = {
      kind: 'enum', baseType: 'string', values: vals,
    };
    console.log(`  DescriptionTypeTitle → enum [${vals.join(', ')}]`);
  }

  // A FK-like field
  const committeeId = suspects.find(s => s.keyName === 'CommitteeId');
  if (committeeId) {
    decisions.fields['CommitteeId'] = { kind: 'fk', componentId: 'CommitteeIdRef' };
    components['CommitteeIdRef'] = {
      kind: 'fk', baseType: 'string', values: [],
    };
    console.log('  CommitteeId → fk (string ref)');
  }

  const transformed = transformSchemas(schemas, decisions, components);

  // Check that $refs were injected
  let refsFound = 0;
  for (const method of transformed) {
    const check = (schema: JsonSchema, path: string) => {
      if (schema.properties) {
        for (const [key, prop] of Object.entries(schema.properties)) {
          if (prop.$ref && prop.$ref.includes('components/schemas/')) {
            refsFound++;
          }
          // Also check inside anyOf (for nullable refs)
          if (prop.anyOf) {
            for (const branch of prop.anyOf) {
              if (branch.$ref && branch.$ref.includes('components/schemas/')) {
                refsFound++;
              }
            }
          }
        }
      }
    };
    check(method.requestSchema, `${method.methodName}.request`);
    check(method.responseSchema, `${method.methodName}.response`);
  }

  console.log(`  $refs injected: ${refsFound}`);
  if (refsFound === 0 && Object.keys(decisions.fields).length > 0) {
    console.error('  FAIL: no $refs found after transform');
    issues++;
  }

  // Validate transformed schemas. $ref-containing schemas won't validate
  // directly with Ajv (it doesn't resolve our component refs), so this
  // tests that NON-transformed methods still pass and that the transform
  // doesn't break schema structure.
  console.log('\nValidating transformed schemas...');
  const postTransform = validateSchemas(corpora, transformed);

  let transformFailCount = 0;
  for (const r of postTransform.results) {
    if (!r.pass) transformFailCount++;
  }

  // We expect some failures for methods that got $refs injected
  // (Ajv can't resolve $ref to local components), but non-transformed
  // methods should still pass
  const nonTransformedMethods = transformed.filter(m => {
    const hasRef = (s: JsonSchema): boolean => {
      if (s.$ref) return true;
      if (s.properties) {
        for (const p of Object.values(s.properties)) {
          if (hasRef(p)) return true;
        }
      }
      if (s.anyOf) for (const a of s.anyOf) if (hasRef(a)) return true;
      if (s.items && hasRef(s.items)) return true;
      return false;
    };
    return !hasRef(m.requestSchema) && !hasRef(m.responseSchema);
  });

  const nonTransformedNames = new Set(nonTransformedMethods.map(m => m.methodName));
  let nonTransformedFails = 0;
  for (const r of postTransform.results) {
    if (nonTransformedNames.has(r.methodName) && !r.pass) {
      console.error(`  FAIL: non-transformed method ${r.methodName} failed after transform`);
      nonTransformedFails++;
    }
  }

  console.log(`  Total failures: ${transformFailCount} (expected for $ref methods)`);
  console.log(`  Non-transformed failures: ${nonTransformedFails}`);
  if (nonTransformedFails > 0) issues++;

  // Check component schema building
  const compSchemas = buildComponentSchemas(components);
  if (Object.keys(compSchemas).length !== Object.keys(components).length) {
    console.error('  FAIL: component schema count mismatch');
    issues++;
  }
  const enumSchema = compSchemas['DescriptionTypeTitleEnum'];
  if (enumSchema && (!enumSchema.enum || enumSchema.enum.length === 0)) {
    console.error('  FAIL: enum component has no values');
    issues++;
  }
  const fkSchema = compSchemas['CommitteeIdRef'];
  if (fkSchema && fkSchema.enum) {
    console.error('  FAIL: FK component should not have enum');
    issues++;
  }
  console.log('  Component schemas built correctly');

  console.log(`\nIssues: ${issues}`);
  console.log(`${issues === 0 ? 'PASS' : 'FAIL'}: schema-transform.ts + validate.ts\n`);
}

main().catch(console.error);
