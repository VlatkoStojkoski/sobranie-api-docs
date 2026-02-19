import type { Decisions, FieldDecision, SharedComponents } from './types.js';
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

export function collectRelationshipWarnings(
  decisions: Decisions,
  components: SharedComponents,
): string[] {
  const { indexSources, valueSources } = sourceMaps(decisions);
  const warnings: string[] = [];
  const definedFields = new Set(Object.keys(components));

  for (const [decisionKey, decision] of Object.entries(decisions.fields)) {
    const fieldId = decisionFieldId(decision);
    if ((decision.kind === 'enum_id' || decision.kind === 'enum_value')) {
      const enumName = decision.enumName;
      if (!enumName) {
        warnings.push(
          `${formatDecision(decisionKey)} is ${decision.kind} but enumName is missing.`,
        );
        continue;
      }
      const enumDef = decisions.enums[enumName];
      if (!enumDef) {
        warnings.push(
          `${formatDecision(decisionKey)} references enum "${enumName}" but it is not defined.`,
        );
        continue;
      }
      if (decision.kind === 'enum_id' && enumDef.values.length === 0) {
        warnings.push(
          `${formatDecision(decisionKey)} references enum "${enumName}" id, but no enum_value values are defined yet.`,
        );
      }
      if (decision.kind === 'enum_value' && enumDef.ids.length === 0) {
        warnings.push(
          `${formatDecision(decisionKey)} references enum "${enumName}" value, but no enum_id values are defined yet.`,
        );
      }
      if (enumDef.ids.length > 0 && enumDef.values.length > 0 && enumDef.ids.length !== enumDef.values.length) {
        warnings.push(
          `Enum "${enumName}" has ${enumDef.ids.length} ids and ${enumDef.values.length} values; expected one-to-one mapping.`,
        );
      }
      if (enumDef.members && enumDef.members.length > 0) {
        const ids = new Set<number>();
        const values = new Set<string | number | boolean>();
        for (const member of enumDef.members) {
          if (ids.has(member.id)) {
            warnings.push(`Enum "${enumName}" has duplicate member id ${member.id}.`);
            break;
          }
          ids.add(member.id);
          if (values.has(member.value)) {
            warnings.push(`Enum "${enumName}" has duplicate member value ${String(member.value)}.`);
            break;
          }
          values.add(member.value);
        }
      }
      continue;
    }

    if (!fieldId) continue;

    if (decision.kind === 'fk' && !definedFields.has(fieldId)) {
      warnings.push(
        `${formatDecision(decisionKey)} references undefined model field "${fieldId}" as fk.`,
      );
    } else if (decision.kind === 'foreign_value' && !definedFields.has(fieldId)) {
      warnings.push(
        `${formatDecision(decisionKey)} references undefined model field "${fieldId}" as foreign_value.`,
      );
    } else if (decision.kind === 'index_source' && !definedFields.has(fieldId)) {
      warnings.push(
        `${formatDecision(decisionKey)} declares index_source for undefined model field "${fieldId}".`,
      );
    } else if (decision.kind === 'value_source' && !definedFields.has(fieldId)) {
      warnings.push(
        `${formatDecision(decisionKey)} declares value_source for undefined model field "${fieldId}".`,
      );
    } else if (decision.kind === 'fk' && !indexSources.has(fieldId)) {
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
