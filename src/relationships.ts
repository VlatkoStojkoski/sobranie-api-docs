import type { Decisions, SharedComponents } from './types.js';
import { parseScopedFieldKey } from './scoped-field.js';

export interface RelationshipConflict {
  role: 'source' | 'reference';
  field: string;
  sources: string[];
}

export function detectRelationshipConflicts(_decisions: Decisions): RelationshipConflict[] {
  // Duplicate source/reference declarations are allowed.
  return [];
}

export function collectRelationshipWarnings(
  decisions: Decisions,
  components: SharedComponents,
): string[] {
  const warnings: string[] = [];
  const definedFields = new Set(Object.keys(components));

  for (const [decisionKey, decision] of Object.entries(decisions.fields)) {
    if (decision.kind === 'scalar') continue;

    if (decision.sourceFieldId && !definedFields.has(decision.sourceFieldId)) {
      warnings.push(
        `${formatDecision(decisionKey)} declares source field "${decision.sourceFieldId}" but it is not defined.`,
      );
    }

    if (decision.referenceFieldId && !definedFields.has(decision.referenceFieldId)) {
      warnings.push(
        `${formatDecision(decisionKey)} references "${decision.referenceFieldId}" but it is not defined.`,
      );
    }
  }

  return warnings.sort((a, b) => a.localeCompare(b));
}

function formatDecision(decisionKey: string): string {
  const parsed = parseScopedFieldKey(decisionKey);
  if (!parsed) return decisionKey;
  return `${parsed.methodName} [${parsed.direction}] ${parsed.parentPath}.${parsed.keyName}`;
}
