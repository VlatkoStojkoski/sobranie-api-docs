/**
 * Interactive prompts for user decisions (scalar/enum/fk/foreign value/source roles).
 * Uses @inquirer/prompts for the interactive UI.
 */

import { select, confirm, input } from '@inquirer/prompts';
import type { FieldKind, SharedComponents, SharedComponent } from '../types.js';
import type { Suspect } from '../value-registry.js';
import type { SuggestionAdvice } from '../llm/types.js';
import {
  findOverlappingComponents,
  generateComponentId,
  addComponent,
  mergeIntoComponent,
} from '../decisions.js';

// ── Format helpers ──────────────────────────────────────────────────

function formatValues(values: Set<string | number | boolean>, max: number = 10): string {
  const arr = Array.from(values).map((v) => {
    if (v === '') return '""';
    if (typeof v === 'string' && v.trim() === '' && v.length > 0) return JSON.stringify(v);
    return String(v);
  });
  if (arr.length <= max) return arr.join(', ');
  return arr.slice(0, max).join(', ') + ` ... (+${arr.length - max} more)`;
}

function formatComponent(id: string, comp: SharedComponent): string {
  const vals = comp.values.length > 0
    ? ` [${comp.values.slice(0, 5).map(String).join(', ')}${comp.values.length > 5 ? '...' : ''}]`
    : '';
  return `${id} (${comp.kind}, ${comp.baseType}${vals})`;
}

// ── Prompt for a single suspect ─────────────────────────────────────

export interface PromptResult {
  action: 'apply' | 'back';
  kind?: FieldKind;
  componentId?: string;
  matchesExisting?: string;
}

export async function promptForSuspect(
  suspect: Suspect,
  components: SharedComponents,
  index: number,
  total: number,
  suggestion?: SuggestionAdvice,
): Promise<PromptResult> {
  const { keyName, entry, methodName, direction } = suspect;
  const uniqueCount = entry.values.size;
  let totalOccurrences = 0;
  for (const c of entry.counts.values()) totalOccurrences += c;

  console.log(`\n[${ index + 1}/${total}] Field: ${keyName}`);
  console.log(`  Method: ${methodName}  |  Side: ${direction}  |  Parent: ${suspect.parentPath}`);
  console.log(`  Unique values: ${uniqueCount}  |  Total occurrences: ${totalOccurrences}`);
  console.log(`  Values: ${formatValues(entry.values)}`);
  if (suggestion) {
    const suggestionTarget = suggestedTargetLabel(suggestion);
    const sourceHint = suggestion.sourceReferenceFieldId
      ? ` | source hint: ${suggestion.sourceReferenceFieldId}`
      : '';
    console.log(
      `  Suggested: ${suggestion.kind} (${suggestion.confidence.toFixed(2)})`
      + `${suggestionTarget ? ` -> ${suggestionTarget}` : ''}${sourceHint}`,
    );
    console.log(`  Why: ${suggestion.reason}`);
  }

  // Check for overlapping existing components (enum-only reuse heuristic)
  const valuesArr = Array.from(entry.values);
  const overlaps = findOverlappingComponents(components, valuesArr);

  if (overlaps.length > 0) {
    console.log(`  Overlapping components found:`);
    for (const o of overlaps.slice(0, 5)) {
      console.log(`    - ${formatComponent(o.id, o.component)} (${o.overlapCount} shared values)`);
    }
  }

  const selectChoices: { value: FieldKind | '__back__' | '__accept__'; name: string }[] = [];
  const canAccept = canAcceptSuggestion(suggestion, components);
  if (canAccept && suggestion) {
    selectChoices.push({
      value: '__accept__',
      name: `Accept suggestion: ${suggestion.kind}${suggestedTargetLabel(suggestion) ? ` -> ${suggestedTargetLabel(suggestion)}` : ''}`,
    });
  }
  selectChoices.push({ value: '__back__', name: 'Go back to previous field (undo last decision)' });
  selectChoices.push({ value: 'scalar', name: 'Scalar (plain string/number/boolean)' });
  selectChoices.push({ value: 'enum', name: 'Enum (closed set of known values)' });
  selectChoices.push({ value: 'fk', name: 'Foreign Key (reference to another entity)' });
  selectChoices.push({ value: 'foreign_value', name: 'Foreign Value (resolved/display value from another entity)' });
  selectChoices.push({ value: 'index_source', name: 'Index Source (actual source field for a foreign key)' });
  selectChoices.push({ value: 'value_source', name: 'Value Source (actual source field for a foreign value)' });

  let kindSelection: FieldKind | '__back__' | '__accept__';
  while (true) {
    kindSelection = await select<FieldKind | '__back__' | '__accept__'>({
      message: `What is "${keyName}"?`,
      choices: selectChoices,
    });
    if (kindSelection !== '__accept__') break;
    const accepted = applyAcceptedSuggestion(suggestion, components, keyName, entry.values);
    if (accepted) return accepted;
    console.log('  Suggestion is missing required details. Choose manually.\n');
  }

  if (kindSelection === '__back__') {
    return { action: 'back' };
  }

  const kind = kindSelection;

  if (kind === 'scalar') {
    return { action: 'apply', kind };
  }

  // For enum, check if it matches an existing component
  if (kind === 'enum' && overlaps.length > 0) {
    const suggestedReuse = suggestion?.kind === 'enum'
      ? suggestion.reuseComponentId
      : undefined;
    const canDefaultToReuse = !!suggestedReuse && overlaps.some((o) => o.id === suggestedReuse);
    const matchExisting = await confirm({
      message: 'Does this match an existing component?',
      default: canDefaultToReuse,
    });

    if (matchExisting) {
      const choices = overlaps.map((o) => ({
        value: o.id,
        name: formatComponent(o.id, o.component),
      }));

      const matchId = await select({
        message: 'Which component does it match?',
        choices,
      });

      // If the value sets differ, offer to merge
      const matchComp = components[matchId]!;
      const matchSet = new Set(matchComp.values);
      const newValues = valuesArr.filter((v) => !matchSet.has(v));

      if (newValues.length > 0 && kind === 'enum') {
        const shouldMerge = await confirm({
          message: `Merge ${newValues.length} new value(s) into ${matchId}? (${newValues.map(String).join(', ')})`,
          default: true,
        });

        if (shouldMerge) {
          mergeIntoComponent(components, matchId, valuesArr);
        }
      }

      return { action: 'apply', kind, matchesExisting: matchId };
    }
  }

  // Determine base type from values
  const inferredType = inferBaseType(entry.values);

  // Create or link a field definition.
  const defaultFieldId = suggestFieldId(keyName, kind);
  const suggestedFieldId = suggestedFieldIdForKind(kind, suggestion);
  const fieldId = await input({
    message: kind === 'enum' ? 'Component name:' : 'Field definition (e.g. Committee.Id):',
    default: suggestedFieldId
      ?? (kind === 'enum' ? generateComponentId(components, keyName, kind) : defaultFieldId),
  });

  const existing = components[fieldId];
  if (!existing) {
    const component = componentForKind(kind, inferredType, valuesArr, keyName);
    if (component) {
      addComponent(components, fieldId, component);
    }
  }

  return { action: 'apply', kind, componentId: fieldId };
}

function componentForKind(
  kind: FieldKind,
  inferredType: { baseType: string; baseTypes?: string[] },
  values: (string | number | boolean)[],
  keyName: string,
): SharedComponent | null {
  if (kind === 'scalar') return null;

  const componentKind = (
    kind === 'index_source' ? 'fk'
      : kind === 'value_source' ? 'foreign_value'
        : kind
  );

  return {
    kind: componentKind,
    baseType: inferredType.baseType,
    ...(inferredType.baseTypes ? { baseTypes: inferredType.baseTypes } : {}),
    values: componentKind === 'enum'
      ? values.sort((a, b) => String(a).localeCompare(String(b)))
      : [],
    description: componentKind === 'enum'
      ? `Enum for ${keyName}`
      : componentKind === 'foreign_value'
        ? `Foreign value: ${keyName}`
        : `Reference: ${keyName}`,
  };
}

function inferBaseType(
  values: Set<string | number | boolean>,
): { baseType: string; baseTypes?: string[] } {
  let hasString = false;
  let hasNumber = false;
  let hasInteger = true;
  let hasBoolean = false;

  for (const v of values) {
    if (typeof v === 'string') hasString = true;
    if (typeof v === 'boolean') hasBoolean = true;
    if (typeof v === 'number') {
      hasNumber = true;
      if (!Number.isInteger(v)) hasInteger = false;
    }
  }

  const baseTypes: string[] = [];
  if (hasString) baseTypes.push('string');
  if (hasNumber) baseTypes.push(hasInteger ? 'integer' : 'number');
  if (hasBoolean) baseTypes.push('boolean');

  if (baseTypes.length === 0) return { baseType: 'string' };
  if (baseTypes.length === 1) return { baseType: baseTypes[0]! };
  return { baseType: 'mixed', baseTypes };
}

function suggestFieldId(keyName: string, kind: FieldKind): string {
  if (kind === 'enum') {
    return keyName;
  }

  const bySuffix = (suffix: string): string | null => {
    if (!keyName.endsWith(suffix) || keyName.length <= suffix.length) return null;
    return keyName.slice(0, -suffix.length);
  };

  const idPrefix = bySuffix('Id');
  if (idPrefix) return `${idPrefix}.Id`;

  const titlePrefix = bySuffix('Title');
  if (titlePrefix) return `${titlePrefix}.Title`;

  const namePrefix = bySuffix('Name');
  if (namePrefix) return `${namePrefix}.Name`;

  return keyName.includes('.') ? keyName : `${keyName}.${keyName}`;
}

function suggestedFieldIdForKind(
  kind: FieldKind,
  suggestion?: SuggestionAdvice,
): string | undefined {
  if (!suggestion) return undefined;
  if (suggestion.reuseComponentId && kind === 'enum') return suggestion.reuseComponentId;
  if (suggestion.targetFieldId) return suggestion.targetFieldId;
  if (suggestion.newComponentName && kind === 'enum') return suggestion.newComponentName;
  return undefined;
}

function suggestedTargetLabel(suggestion: SuggestionAdvice): string | undefined {
  return suggestion.reuseComponentId
    ?? suggestion.targetFieldId
    ?? suggestion.newComponentName;
}

function canAcceptSuggestion(
  suggestion: SuggestionAdvice | undefined,
  components: SharedComponents,
): boolean {
  if (!suggestion) return false;
  if (suggestion.kind === 'scalar') return true;

  if (suggestion.kind === 'enum') {
    const reuse = nonEmpty(suggestion.reuseComponentId);
    if (reuse && components[reuse]) return true;
    return !!(nonEmpty(suggestion.newComponentName) || nonEmpty(suggestion.targetFieldId));
  }

  return !!nonEmpty(suggestion.targetFieldId);
}

function applyAcceptedSuggestion(
  suggestion: SuggestionAdvice | undefined,
  components: SharedComponents,
  keyName: string,
  values: Set<string | number | boolean>,
): PromptResult | undefined {
  if (!suggestion) return undefined;

  if (suggestion.kind === 'scalar') {
    return { action: 'apply', kind: 'scalar' };
  }

  const valuesArr = Array.from(values);
  const inferredType = inferBaseType(values);

  if (suggestion.kind === 'enum') {
    const reuse = nonEmpty(suggestion.reuseComponentId);
    if (reuse && components[reuse]) {
      return { action: 'apply', kind: 'enum', matchesExisting: reuse };
    }

    const newId = nonEmpty(suggestion.newComponentName) ?? nonEmpty(suggestion.targetFieldId);
    if (!newId) return undefined;

    if (!components[newId]) {
      const component = componentForKind('enum', inferredType, valuesArr, keyName);
      if (component) addComponent(components, newId, component);
    }

    return { action: 'apply', kind: 'enum', componentId: newId };
  }

  const fieldId = nonEmpty(suggestion.targetFieldId);
  if (!fieldId) return undefined;

  if (!components[fieldId]) {
    const component = componentForKind(suggestion.kind, inferredType, valuesArr, keyName);
    if (component) addComponent(components, fieldId, component);
  }

  return { action: 'apply', kind: suggestion.kind, componentId: fieldId };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Batch review (edit decisions JSON) ──────────────────────────────

export async function promptBatchOrInteractive(): Promise<'interactive' | 'batch'> {
  return select({
    message: 'How would you like to review suspects?',
    choices: [
      { value: 'interactive' as const, name: 'Interactive (one at a time)' },
      { value: 'batch' as const, name: 'Batch (edit decisions.json manually, then continue)' },
    ],
  });
}

// ── Validation failure prompts ──────────────────────────────────────

export type ValidationAction = 'undo' | 'edit' | 'report' | 'retry' | 'force';

export async function promptValidationFailure(): Promise<ValidationAction> {
  return select({
    message: 'Validation failed. What would you like to do?',
    choices: [
      { value: 'undo' as const, name: 'Undo last decision' },
      { value: 'edit' as const, name: 'Edit decisions.json manually' },
      { value: 'report' as const, name: 'View full failure report' },
      { value: 'retry' as const, name: 'Retry validation' },
      { value: 'force' as const, name: 'Force emit anyway (not recommended)' },
    ],
  });
}

// ── Main menu ───────────────────────────────────────────────────────

export type MainAction = 'new' | 'resume' | 'exit';

export async function promptMainMenu(hasSessions: boolean): Promise<MainAction> {
  const choices: { value: MainAction; name: string }[] = [
    { value: 'new', name: 'New session (start recording)' },
  ];

  if (hasSessions) {
    choices.push({ value: 'resume', name: 'Resume existing session' });
  }

  choices.push({ value: 'exit', name: 'Exit' });

  return select({ message: 'What would you like to do?', choices });
}

export async function promptSelectSession(
  sessions: { name: string; step: string }[],
): Promise<string> {
  return select({
    message: 'Select a session to resume:',
    choices: sessions.map((s) => ({
      value: s.name,
      name: `${s.name} (step: ${s.step})`,
    })),
  });
}

export async function promptContinue(message: string): Promise<boolean> {
  return confirm({ message, default: true });
}
