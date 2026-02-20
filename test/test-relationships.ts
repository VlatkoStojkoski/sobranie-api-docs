import assert from 'node:assert/strict';
import { detectRelationshipConflicts, collectRelationshipWarnings } from '../src/relationships.js';
import { makeScopedFieldKey } from '../src/scoped-field.js';
import type { Decisions } from '../src/types.js';

function main(): void {
  const decisions: Decisions = {
    fields: {
      [makeScopedFieldKey('A', 'response', '$', 'CommitteeId')]: {
        kind: 'source_reference',
        sourceFieldId: 'Committee.Id',
        referenceFieldId: 'Committee.Id',
      },
      [makeScopedFieldKey('B', 'response', '$', 'CommitteeTitle')]: {
        kind: 'source',
        sourceFieldId: 'Committee.Title',
      },
      [makeScopedFieldKey('C', 'response', '$', 'UnresolvedReference')]: {
        kind: 'reference',
        referenceFieldId: 'Other.Id',
      },
      [makeScopedFieldKey('D', 'response', '$', 'UnresolvedSource')]: {
        kind: 'source',
        sourceFieldId: 'Other.Title',
      },
    },
  };

  const conflicts = detectRelationshipConflicts(decisions);
  assert.deepEqual(conflicts, [], 'duplicate source/reference declarations should not conflict');

  const warnings = collectRelationshipWarnings(decisions, {
    'Committee.Id': { kind: 'field', baseType: 'integer', values: [] },
    'Committee.Title': { kind: 'field', baseType: 'string', values: [] },
  });
  assert.ok(
    warnings.some((w) => w.includes('Other.Id') && w.includes('not defined')),
    'missing reference field should generate warning',
  );
  assert.ok(
    warnings.some((w) => w.includes('Other.Title') && w.includes('not defined')),
    'missing source field should generate warning',
  );
  assert.ok(
    !warnings.some((w) => w.includes('Committee.Id') || w.includes('Committee.Title')),
    'resolved source/reference fields should not produce warnings',
  );

  console.log('PASS test-relationships.ts');
}

main();
