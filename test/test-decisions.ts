/**
 * Test decisions.ts: load, save, round-trip, component helpers.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyDecisions,
  saveDecisions,
  loadDecisions,
  setFieldDecision,
  removeFieldDecision,
  addComponent,
  removeComponent,
  findOverlappingComponents,
  mergeIntoComponent,
  generateComponentId,
} from '../src/decisions.js';

async function main() {
  console.log('=== Testing decisions.ts ===\n');

  const tmp = await mkdtemp(join(tmpdir(), 'test-decisions-'));
  const path = join(tmp, 'decisions.json');
  let issues = 0;

  // 1. Create empty, save, reload
  let { decisions, components } = createEmptyDecisions();

  setFieldDecision(decisions, 'StatusTitle', { kind: 'enum', componentId: 'StatusTitleEnum' });
  setFieldDecision(decisions, 'CommitteeId', { kind: 'fk', componentId: 'CommitteeIdRef' });
  setFieldDecision(decisions, 'Title', { kind: 'scalar' });

  addComponent(components, 'StatusTitleEnum', {
    kind: 'enum', baseType: 'string', values: ['Active', 'Inactive', 'Pending'],
  });
  addComponent(components, 'CommitteeIdRef', {
    kind: 'fk', baseType: 'string', values: [],
  });

  await saveDecisions(path, decisions, components);
  console.log('  Saved decisions to disk');

  // 2. Reload
  const loaded = await loadDecisions(path);
  if (Object.keys(loaded.decisions.fields).length !== 3) {
    console.error(`  FAIL: expected 3 fields, got ${Object.keys(loaded.decisions.fields).length}`);
    issues++;
  }
  if (Object.keys(loaded.components).length !== 2) {
    console.error(`  FAIL: expected 2 components, got ${Object.keys(loaded.components).length}`);
    issues++;
  }
  if (loaded.decisions.fields['StatusTitle']?.kind !== 'enum') {
    console.error('  FAIL: StatusTitle kind mismatch');
    issues++;
  }
  console.log('  Reload round-trip OK');

  // 3. Remove
  removeFieldDecision(loaded.decisions, 'Title');
  if ('Title' in loaded.decisions.fields) {
    console.error('  FAIL: Title not removed');
    issues++;
  }
  console.log('  Remove decision OK');

  // 4. Component overlap
  addComponent(loaded.components, 'TypeTitleEnum', {
    kind: 'enum', baseType: 'string', values: ['Active', 'Closed'],
  });

  const overlaps = findOverlappingComponents(loaded.components, ['Active', 'Pending']);
  if (overlaps.length !== 2) {
    console.error(`  FAIL: expected 2 overlaps, got ${overlaps.length}`);
    issues++;
  } else {
    // StatusTitleEnum has 2 overlap (Active, Pending), TypeTitleEnum has 1 (Active)
    if (overlaps[0]!.overlapCount !== 2) {
      console.error(`  FAIL: first overlap count expected 2, got ${overlaps[0]!.overlapCount}`);
      issues++;
    }
  }
  console.log('  Overlap detection OK');

  // 5. Merge
  mergeIntoComponent(loaded.components, 'StatusTitleEnum', ['Active', 'Dormant']);
  const merged = loaded.components['StatusTitleEnum']!;
  if (!merged.values.includes('Dormant')) {
    console.error('  FAIL: Dormant not merged');
    issues++;
  }
  if (merged.values.length !== 4) {
    console.error(`  FAIL: expected 4 values after merge, got ${merged.values.length}`);
    issues++;
  }
  console.log('  Merge OK');

  // 6. Generate ID (collision avoidance)
  const id1 = generateComponentId(loaded.components, 'StatusTitle', 'enum');
  if (id1 !== 'StatusTitleEnum2') {
    console.error(`  FAIL: expected StatusTitleEnum2, got ${id1}`);
    issues++;
  }
  const id2 = generateComponentId(loaded.components, 'NewField', 'fk');
  if (id2 !== 'NewFieldRef') {
    console.error(`  FAIL: expected NewFieldRef, got ${id2}`);
    issues++;
  }
  console.log('  ID generation OK');

  // 7. Load nonexistent file
  const empty = await loadDecisions(join(tmp, 'nonexistent.json'));
  if (Object.keys(empty.decisions.fields).length !== 0) {
    console.error('  FAIL: nonexistent file should return empty');
    issues++;
  }
  console.log('  Nonexistent file load OK');

  await rm(tmp, { recursive: true });

  console.log(`\nIssues: ${issues}`);
  console.log(`${issues === 0 ? 'PASS' : 'FAIL'}: decisions.ts\n`);
}

main().catch(console.error);
