/**
 * Test extract.ts with the real normalized HAR.
 */
import { extractFromHar } from '../src/extract.js';

const HAR_PATH = 'devproxy-normalized.har';

async function main() {
  console.log('=== Testing extract.ts ===\n');

  const corpora = await extractFromHar(HAR_PATH);

  console.log(`Methods found: ${corpora.length}`);
  const totalSamples = corpora.reduce((s, c) => s + c.samples.length, 0);
  console.log(`Total samples: ${totalSamples}\n`);

  // Check normalization: no leading slash, all PascalCase keys
  let slashIssues = 0;
  let casingIssues = 0;

  for (const corpus of corpora) {
    if (corpus.methodName.startsWith('/')) {
      console.error(`  FAIL: method starts with /: ${corpus.methodName}`);
      slashIssues++;
    }

    for (const sample of corpus.samples) {
      // Check request keys are PascalCase
      for (const key of Object.keys(sample.request)) {
        if (key[0] !== key[0].toUpperCase()) {
          casingIssues++;
          if (casingIssues <= 3) console.error(`  FAIL: non-PascalCase request key: "${key}" in ${corpus.methodName}`);
        }
      }

      // Check response keys (if object)
      if (sample.response && typeof sample.response === 'object' && !Array.isArray(sample.response)) {
        for (const key of Object.keys(sample.response as Record<string, unknown>)) {
          if (key[0] !== key[0].toUpperCase()) {
            casingIssues++;
            if (casingIssues <= 3) console.error(`  FAIL: non-PascalCase response key: "${key}" in ${corpus.methodName}`);
          }
        }
      }
    }
  }

  // Show method list
  console.log('Methods:');
  for (const c of corpora) {
    console.log(`  ${c.methodName} (${c.samples.length} samples)`);
  }

  console.log(`\nSlash issues: ${slashIssues}`);
  console.log(`Casing issues: ${casingIssues}`);
  console.log(`\n${slashIssues === 0 && casingIssues === 0 ? 'PASS' : 'FAIL'}: extract.ts\n`);
}

main().catch(console.error);
