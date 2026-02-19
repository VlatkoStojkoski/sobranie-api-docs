import type { Decisions, FieldDecision } from './types.js';
import { parseScopedFieldKey } from './scoped-field.js';

export interface RelationshipConflict {
  role: 'index_source' | 'value_source';
  field: string;
  sources: string[];
}

function decisionFieldId(decision: FieldDecision | undefined): string | undefined {
  if (!decision) return undefined;
  return decision.matchesExisting ?? decision.componentId;
}

function sourceMaps(decisions: Decisions): {
  indexSources: Map<string, string[]>;
  valueSources: Map<string, string[]>;
} {
  const indexSources = new Map<string, string[]>();
  const valueSources = new Map<string, string[]>();

  for (const [decisionKey, decision] of Object.entries(decisions.fields)) {
    const fieldId = decisionFieldId(decision);
    if (!fieldId) continue;

    if (decision.kind === 'index_source') {
      const existing = indexSources.get(fieldId) ?? [];
      existing.push(decisionKey);
      indexSources.set(fieldId, existing);
    } else if (decision.kind === 'value_source') {
      const existing = valueSources.get(fieldId) ?? [];
      existing.push(decisionKey);
      valueSources.set(fieldId, existing);
    }
  }

  return { indexSources, valueSources };
}

export function detectRelationshipConflicts(decisions: Decisions): RelationshipConflict[] {
  // Multi-source is supported: duplicate index_source/value_source declarations are not conflicts.
  void decisions;
  return [];
}

export function collectRelationshipWarnings(decisions: Decisions): string[] {
  const { indexSources, valueSources } = sourceMaps(decisions);
  const warnings: string[] = [];

  for (const [decisionKey, decision] of Object.entries(decisions.fields)) {
    const fieldId = decisionFieldId(decision);
    if (!fieldId) continue;

    if (decision.kind === 'fk' && !indexSources.has(fieldId)) {
      warnings.push(
        `${formatDecision(decisionKey)} references "${fieldId}" as fk, but no index_source is defined for that field.`,
      );
    } else if (decision.kind === 'foreign_value' && !valueSources.has(fieldId)) {
      warnings.push(
        `${formatDecision(decisionKey)} references "${fieldId}" as foreign_value, but no value_source is defined for that field.`,
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
