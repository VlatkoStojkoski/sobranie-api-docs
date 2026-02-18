import assert from 'node:assert/strict';
import { detectRelationshipConflicts, collectRelationshipWarnings } from '../src/relationships.js';
import { makeScopedFieldKey } from '../src/scoped-field.js';
import type { Decisions } from '../src/types.js';

function main(): void {
  const decisions: Decisions = {
    fields: {
      [makeScopedFieldKey('A', 'response', '$', 'CommitteeId')]: {
        kind: 'fk',
        componentId: 'Committee.Id',
      },
      [makeScopedFieldKey('B', 'response', '$', 'CommitteeName')]: {
        kind: 'foreign_value',
        componentId: 'Committee.Title',
      },
      [makeScopedFieldKey('C', 'response', '$', 'CommitteeIdSource')]: {
        kind: 'index_source',
        componentId: 'Committee.Id',
      },
      [makeScopedFieldKey('D', 'response', '$', 'CommitteeTitleSource1')]: {
        kind: 'value_source',
        componentId: 'Committee.Title',
      },
      [makeScopedFieldKey('E', 'response', '$', 'CommitteeTitleSource2')]: {
        kind: 'value_source',
        componentId: 'Committee.Title',
      },
      [makeScopedFieldKey('F', 'response', '$', 'UnresolvedFk')]: {
        kind: 'fk',
        componentId: 'Other.Id',
      },
      [makeScopedFieldKey('G', 'response', '$', 'UnresolvedValue')]: {
        kind: 'foreign_value',
        componentId: 'Other.Title',
      },
    },
  };

  const conflicts = detectRelationshipConflicts(decisions);
  assert.deepEqual(conflicts, [
    {
      role: 'value_source',
      field: 'Committee.Title',
      sources: [
        makeScopedFieldKey('D', 'response', '$', 'CommitteeTitleSource1'),
        makeScopedFieldKey('E', 'response', '$', 'CommitteeTitleSource2'),
      ],
    },
  ]);

  const warnings = collectRelationshipWarnings(decisions);
  assert.ok(
    warnings.some((w) => w.includes('Other.Id') && w.includes('no index_source')),
    'missing index source should generate warning for fk refs',
  );
  assert.ok(
    warnings.some((w) => w.includes('Other.Title') && w.includes('no value_source')),
    'missing value source should generate warning for foreign value refs',
  );
  assert.ok(
    !warnings.some((w) => w.includes('Committee.Id') || w.includes('Committee.Title')),
    'resolved relationships should not produce warnings',
  );

  console.log('PASS test-relationships.ts');
}

main();
