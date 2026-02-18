import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'decisions-test-'));
  const file = join(dir, 'decisions.json');

  try {
    const { decisions, components } = createEmptyDecisions();

    setFieldDecision(decisions, 'Status', { kind: 'enum', componentId: 'StatusEnum' });
    setFieldDecision(decisions, 'CommitteeId', { kind: 'fk', componentId: 'CommitteeIdRef' });
    setFieldDecision(decisions, 'Title', { kind: 'scalar' });

    addComponent(components, 'StatusEnum', {
      kind: 'enum',
      baseType: 'string',
      values: ['draft', 'active', 'closed'],
    });
    addComponent(components, 'StatusEnum2', {
      kind: 'enum',
      baseType: 'string',
      values: ['active', 'paused'],
    });
    addComponent(components, 'CommitteeIdRef', {
      kind: 'fk',
      baseType: 'integer',
      values: [],
    });

    await saveDecisions(file, decisions, components, {
      Status: { values: ['draft', 'active', 'closed'], uniqueCount: 3, totalOccurrences: 10 },
    });

    const raw = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
    assert.ok(raw._suspectValues, 'save should include optional suspect reference');

    const loaded = await loadDecisions(file);
    assert.equal(Object.keys(loaded.decisions.fields).length, 3);
    assert.equal(Object.keys(loaded.components).length, 3);

    const overlaps = findOverlappingComponents(loaded.components, ['active', 'draft']);
    assert.deepEqual(
      overlaps.map((o) => o.id),
      ['StatusEnum', 'StatusEnum2'],
      'overlap should be sorted by highest overlap and ignore fk components',
    );
    assert.equal(overlaps[0]!.overlapCount, 2);
    assert.equal(overlaps[1]!.overlapCount, 1);

    mergeIntoComponent(loaded.components, 'StatusEnum', ['active', 'archived']);
    assert.deepEqual(
      loaded.components.StatusEnum?.values,
      ['active', 'archived', 'closed', 'draft'],
      'merge should de-duplicate and sort values',
    );

    mergeIntoComponent(loaded.components, 'DoesNotExist', ['x']);

    assert.equal(generateComponentId(loaded.components, 'Status', 'enum'), 'StatusEnum3');
    assert.equal(generateComponentId(loaded.components, 'Language', 'enum'), 'LanguageEnum');
    assert.equal(generateComponentId(loaded.components, 'CommitteeId', 'fk'), 'CommitteeIdRef2');
    assert.equal(generateComponentId(loaded.components, 'TypeTitle', 'foreign_value'), 'TypeTitleValue');

    removeFieldDecision(loaded.decisions, 'Title');
    assert.ok(!('Title' in loaded.decisions.fields));
    removeComponent(loaded.components, 'CommitteeIdRef');
    assert.ok(!('CommitteeIdRef' in loaded.components));

    const missing = await loadDecisions(join(dir, 'missing.json'));
    assert.deepEqual(missing.decisions.fields, {}, 'missing file should return empty decisions');
    assert.deepEqual(missing.components, {}, 'missing file should return empty components');

    await writeFile(file, '{not json', 'utf-8');
    const invalid = await loadDecisions(file);
    assert.deepEqual(invalid.decisions.fields, {}, 'invalid JSON should return empty decisions');
    assert.deepEqual(invalid.components, {}, 'invalid JSON should return empty components');

    console.log('PASS test-decisions.ts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
