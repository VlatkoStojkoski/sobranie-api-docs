/**
 * Test value-registry.ts with real data.
 */
import { extractFromHar } from '../src/extract.js';
import { buildValueRegistry, detectSuspects, valueSetsOverlap, valueSetsEqual } from '../src/value-registry.js';

const HAR_PATH = 'devproxy-normalized.har';

async function main() {
  console.log('=== Testing value-registry.ts ===\n');

  const corpora = await extractFromHar(HAR_PATH);
  const registry = buildValueRegistry(corpora);

  console.log(`Total keys in registry: ${registry.size}`);

  const suspects = detectSuspects(registry);
  console.log(`Suspects (at least one repeated value): ${suspects.length}\n`);

  // Show first 20 suspects with their stats
  console.log('Top suspects:');
  for (const s of suspects.slice(0, 25)) {
    const maxCount = Math.max(...s.entry.counts.values());
    const sample = Array.from(s.entry.values).slice(0, 3).map(String);
    console.log(`  ${s.keyName}: ${s.entry.values.size} unique, max_repeat=${maxCount}, e.g. [${sample.join(', ')}]`);
  }

  // Sanity checks
  let issues = 0;

  // MethodName should be a suspect (it repeats a LOT)
  const methodNameSuspect = suspects.find(s => s.keyName === 'MethodName');
  if (!methodNameSuspect) {
    console.error('\n  FAIL: MethodName not detected as suspect');
    issues++;
  } else {
    console.log(`\n  OK: MethodName detected (${methodNameSuspect.entry.values.size} unique values)`);
  }

  // Test overlap/equality helpers
  const setA = new Set<string | number | boolean>(['a', 'b', 'c']);
  const setB = new Set<string | number | boolean>(['a', 'b', 'c']);
  const setC = new Set<string | number | boolean>(['a', 'b']);
  const setD = new Set<string | number | boolean>(['x', 'y']);

  if (!valueSetsEqual(setA, setB)) { console.error('  FAIL: equal sets not equal'); issues++; }
  if (valueSetsEqual(setA, setC)) { console.error('  FAIL: unequal sets reported equal'); issues++; }
  if (!valueSetsOverlap(setA, setC)) { console.error('  FAIL: overlapping sets not detected'); issues++; }
  if (valueSetsOverlap(setA, setD)) { console.error('  FAIL: non-overlapping sets detected as overlapping'); issues++; }

  console.log(`\nIssues: ${issues}`);
  console.log(`${issues === 0 ? 'PASS' : 'FAIL'}: value-registry.ts\n`);
}

main().catch(console.error);
