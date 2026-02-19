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
  enumComponentId,
} from '../src/decisions.js';

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'decisions-test-'));
  const file = join(dir, 'decisions.json');

  try {
    const { decisions, components } = createEmptyDecisions();

    setFieldDecision(decisions, 'Status', {
      kind: 'enum_value',
      enumName: 'Status',
      componentId: enumComponentId('Status', 'value'),
    });
    setFieldDecision(decisions, 'CommitteeId', { kind: 'fk', componentId: 'CommitteeIdRef' });
    setFieldDecision(decisions, 'Title', { kind: 'scalar' });
    decisions.enums.Status = { ids: [1, 2], values: ['active', 'closed'] };

    addComponent(components, enumComponentId('Status', 'value'), {
      kind: 'enum',
      baseType: 'string',
      values: ['draft', 'active', 'closed'],
    });
    addComponent(components, enumComponentId('StatusLegacy', 'value'), {
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
    assert.equal(raw.version, 3, 'save should write schema version');
    assert.ok(raw._suspectValues, 'save should include optional suspect reference');

    const loaded = await loadDecisions(file);
    assert.equal(Object.keys(loaded.decisions.fields).length, 3);
    assert.equal(Object.keys(loaded.decisions.enums).length, 1);
    assert.equal(Object.keys(loaded.components).length, 3);

    const overlaps = findOverlappingComponents(loaded.components, ['active', 'draft']);
    assert.deepEqual(
      overlaps.map((o) => o.id),
      [enumComponentId('Status', 'value'), enumComponentId('StatusLegacy', 'value')],
      'overlap should be sorted by highest overlap and ignore fk components',
    );
    assert.equal(overlaps[0]!.overlapCount, 2);
    assert.equal(overlaps[1]!.overlapCount, 1);

    mergeIntoComponent(loaded.components, enumComponentId('Status', 'value'), ['active', 'archived']);
    assert.deepEqual(
      loaded.components[enumComponentId('Status', 'value')]?.values,
      ['active', 'archived', 'closed', 'draft'],
      'merge should de-duplicate and sort values',
    );

    mergeIntoComponent(loaded.components, 'DoesNotExist', ['x']);

    assert.equal(generateComponentId(loaded.components, 'Status', 'enum'), 'StatusEnum');
    assert.equal(generateComponentId(loaded.components, 'Language', 'enum'), 'LanguageEnum');
    assert.equal(generateComponentId(loaded.components, 'CommitteeId', 'fk'), 'CommitteeIdRef2');
    assert.equal(generateComponentId(loaded.components, 'TypeTitle', 'foreign_value'), 'TypeTitleValue');

    removeFieldDecision(loaded.decisions, 'Title');
    assert.ok(!('Title' in loaded.decisions.fields));
    removeComponent(loaded.components, 'CommitteeIdRef');
    assert.ok(!('CommitteeIdRef' in loaded.components));

    const missing = await loadDecisions(join(dir, 'missing.json'));
    assert.deepEqual(missing.decisions.fields, {}, 'missing file should return empty decisions');
    assert.deepEqual(missing.decisions.enums, {}, 'missing file should return empty enums');
    assert.deepEqual(missing.components, {}, 'missing file should return empty components');

    await writeFile(file, '{not json', 'utf-8');
    await assert.rejects(loadDecisions(file), /Unexpected token|Expected property name|Invalid decisions\.json schema/);

    console.log('PASS test-decisions.ts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
