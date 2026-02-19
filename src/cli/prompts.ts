/**
 * Interactive prompts for user decisions (scalar/enum/fk/foreign value/source roles).
 * Uses @inquirer/prompts for the interactive UI.
 */

import { select, confirm, input } from '@inquirer/prompts';
import { emitKeypressEvents } from 'node:readline';
import type { FieldKind, SharedComponents, SharedComponent, EnumRegistry } from '../types.js';
import type { Suspect } from '../value-registry.js';
import type { SuggestionAdvice } from '../llm/types.js';
import {
  addComponent,
  enumComponentId,
} from '../decisions.js';

export interface PromptTraceEvent {
  timestamp: string;
  promptType: 'select' | 'confirm' | 'input';
  context: string;
  message: string;
  response: string | number | boolean | null;
  choices?: Array<{ name: string; value: string }>;
}

export type PromptTraceLogger = (event: PromptTraceEvent) => Promise<void> | void;
export type PromptReloadHandler = () => Promise<void> | void;

let promptTraceLogger: PromptTraceLogger | null = null;
let promptReloadHandler: PromptReloadHandler | null = null;
let activePromptAbortController: AbortController | null = null;
let reloadRequested = false;
let keyListenerAttached = false;

export function setPromptTraceLogger(logger: PromptTraceLogger | null): void {
  promptTraceLogger = logger;
}

export function setPromptReloadHandler(handler: PromptReloadHandler | null): void {
  promptReloadHandler = handler;
  ensureReloadKeyListener();
}

async function tracePrompt(event: Omit<PromptTraceEvent, 'timestamp'>): Promise<void> {
  if (!promptTraceLogger) return;
  try {
    await promptTraceLogger({
      timestamp: new Date().toISOString(),
      ...event,
    });
  } catch {
    // ignore logging failures; do not break UX
  }
}

function ensureReloadKeyListener(): void {
  if (keyListenerAttached) return;
  if (!process.stdin.isTTY) return;

  emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', (_str, key: { ctrl?: boolean; name?: string }) => {
    if (!key?.ctrl || key.name !== 'r') return;
    reloadRequested = true;
    activePromptAbortController?.abort();
  });
  keyListenerAttached = true;
}

async function runWithPromptResync<T>(
  context: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  while (true) {
    reloadRequested = false;
    const abortController = new AbortController();
    activePromptAbortController = abortController;
    try {
      return await run(abortController.signal);
    } catch (error) {
      if (reloadRequested) {
        await tracePrompt({
          promptType: 'input',
          context: `${context}.reload`,
          message: 'Ctrl+R reload requested',
          response: 'reloaded',
        });
        if (promptReloadHandler) {
          await promptReloadHandler();
        }
        continue;
      }
      throw error;
    } finally {
      if (activePromptAbortController === abortController) {
        activePromptAbortController = null;
      }
    }
  }
}

async function tracedSelect<T extends string>(
  context: string,
  params: {
    message: string;
    choices: Array<{ value: T; name: string }>;
  },
): Promise<T> {
  const value = await runWithPromptResync(context, (signal) => select<T>(params, { signal }));
  await tracePrompt({
    promptType: 'select',
    context,
    message: params.message,
    response: String(value),
    choices: params.choices.map((c) => ({ name: c.name, value: String(c.value) })),
  });
  return value;
}

async function tracedConfirm(
  context: string,
  params: {
    message: string;
    default?: boolean;
  },
): Promise<boolean> {
  const value = await runWithPromptResync(context, (signal) => confirm(params, { signal }));
  await tracePrompt({
    promptType: 'confirm',
    context,
    message: params.message,
    response: value,
  });
  return value;
}

async function tracedInput(
  context: string,
  params: {
    message: string;
    default?: string;
  },
): Promise<string> {
  const value = await runWithPromptResync(context, (signal) => input(params, { signal }));
  await tracePrompt({
    promptType: 'input',
    context,
    message: params.message,
    response: value,
  });
  return value;
}

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

interface ModelFieldRef {
  modelName: string;
  fieldName: string;
}

// ── Prompt for a single suspect ─────────────────────────────────────

export interface PromptResult {
  action: 'apply' | 'back';
  kind?: FieldKind;
  componentId?: string;
  matchesExisting?: string;
  enumName?: string;
}

export async function promptForSuspect(
  suspect: Suspect,
  components: SharedComponents,
  enums: EnumRegistry,
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

  const valuesArr = Array.from(entry.values);

  const selectChoices: { value: FieldKind | '__back__' | '__accept__'; name: string }[] = [];
  const canAccept = canAcceptSuggestion(suggestion);
  if (canAccept && suggestion) {
    selectChoices.push({
      value: '__accept__',
      name: `Accept suggestion: ${suggestion.kind}${suggestedTargetLabel(suggestion) ? ` -> ${suggestedTargetLabel(suggestion)}` : ''}`,
    });
  }
  selectChoices.push({ value: '__back__', name: 'Go back to previous field (undo last decision)' });
  selectChoices.push({ value: 'scalar', name: 'Scalar (plain string/number/boolean)' });
  selectChoices.push({ value: 'enum_id', name: 'Enum ID (ordinal integer id)' });
  selectChoices.push({ value: 'enum_value', name: 'Enum Value (display/value label)' });
  selectChoices.push({ value: 'fk', name: 'Foreign Key (reference to another entity)' });
  selectChoices.push({ value: 'foreign_value', name: 'Foreign Value (resolved/display value from another entity)' });
  selectChoices.push({ value: 'index_source', name: 'Index Source (actual source field for a foreign key)' });
  selectChoices.push({ value: 'value_source', name: 'Value Source (actual source field for a foreign value)' });

  let kindSelection: FieldKind | '__back__' | '__accept__';
  while (true) {
    kindSelection = await tracedSelect<FieldKind | '__back__' | '__accept__'>('suspect.kind', {
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

  // Determine base type from values
  const inferredType = inferBaseType(entry.values);

  if (kind === 'enum_id' || kind === 'enum_value') {
    const suggestedEnumName = nonEmpty(suggestion?.newComponentName)
      ?? nonEmpty(suggestion?.targetFieldId)
      ?? suggestModelName(keyName);
    const enumName = await promptEnumName(enums, suggestedEnumName);
    const fieldId = enumComponentId(enumName, kind === 'enum_id' ? 'id' : 'value');

    if (!components[fieldId]) {
      const component = componentForKind(kind, inferredType, valuesArr, keyName);
      if (component) {
        addComponent(components, fieldId, component);
      }
    }

    return { action: 'apply', kind, componentId: fieldId, enumName };
  }

  // Create or link a model field definition.
  const modelField = await promptForModelField(kind, components, keyName, suggestion);
  const fieldId = `${modelField.modelName}.${modelField.fieldName}`;

  const shouldDefineField = (
    kind === 'index_source'
    || kind === 'value_source'
  );
  if (shouldDefineField && !components[fieldId]) {
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
    kind === 'enum_id' || kind === 'enum_value' ? 'enum'
      : kind === 'index_source' ? 'fk'
        : kind === 'value_source' ? 'foreign_value'
          : kind
  );

  return {
    kind: componentKind,
    baseType: kind === 'enum_id' ? 'integer' : inferredType.baseType,
    ...(kind !== 'enum_id' && inferredType.baseTypes ? { baseTypes: inferredType.baseTypes } : {}),
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

function suggestedFieldIdForKind(
  kind: FieldKind,
  suggestion?: SuggestionAdvice,
): string | undefined {
  if (!suggestion) return undefined;
  if (suggestion.reuseComponentId && (kind === 'enum_id' || kind === 'enum_value')) {
    return suggestion.reuseComponentId;
  }
  if (suggestion.targetFieldId) return suggestion.targetFieldId;
  if (suggestion.newComponentName && (kind === 'enum_id' || kind === 'enum_value')) {
    return suggestion.newComponentName;
  }
  return undefined;
}

function suggestedTargetLabel(suggestion: SuggestionAdvice): string | undefined {
  return suggestion.reuseComponentId
    ?? suggestion.targetFieldId
    ?? suggestion.newComponentName;
}

function canAcceptSuggestion(
  suggestion: SuggestionAdvice | undefined,
): boolean {
  if (!suggestion) return false;
  if (suggestion.kind === 'scalar') return true;

  const candidateId = nonEmpty(suggestion.reuseComponentId)
    ?? nonEmpty(suggestion.targetFieldId)
    ?? nonEmpty(suggestion.newComponentName);
  if (!candidateId) return false;
  if (suggestion.kind === 'enum_id' || suggestion.kind === 'enum_value') {
    return candidateId.trim().length > 0;
  }
  const parsed = parseModelFieldId(candidateId);
  if (!parsed) return false;
  if (suggestion.kind === 'index_source' || suggestion.kind === 'value_source') return true;
  // fk/foreign_value may legitimately reference undefined model fields.
  return parsed.modelName.length > 0 && parsed.fieldName.length > 0;
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
  const candidateId = nonEmpty(suggestion.reuseComponentId)
    ?? nonEmpty(suggestion.targetFieldId)
    ?? nonEmpty(suggestion.newComponentName);
  if (!candidateId) return undefined;

  if (suggestion.kind === 'enum_id' || suggestion.kind === 'enum_value') {
    const enumName = candidateId.trim();
    if (!enumName) return undefined;
    const componentId = enumComponentId(enumName, suggestion.kind === 'enum_id' ? 'id' : 'value');
    if (!components[componentId]) {
      const component = componentForKind(suggestion.kind, inferredType, valuesArr, keyName);
      if (component) addComponent(components, componentId, component);
    }
    return { action: 'apply', kind: suggestion.kind, componentId, enumName };
  }

  const parsed = parseModelFieldId(candidateId);
  if (!parsed) return undefined;

  if (
    (suggestion.kind === 'index_source' || suggestion.kind === 'value_source')
    && !components[candidateId]
  ) {
    const component = componentForKind(suggestion.kind, inferredType, valuesArr, keyName);
    if (component) addComponent(components, candidateId, component);
  }

  return { action: 'apply', kind: suggestion.kind, componentId: candidateId };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function promptForModelField(
  kind: FieldKind,
  components: SharedComponents,
  keyName: string,
  suggestion?: SuggestionAdvice,
): Promise<ModelFieldRef> {
  const known = knownModels(components);
  const suggestedFieldId = suggestedFieldIdForKind(kind, suggestion);
  const suggested = parseModelFieldId(suggestedFieldId);

  const defaultModelName = suggested?.modelName ?? suggestModelName(keyName);
  const modelName = await promptModelName(known, defaultModelName);

  const defaultFieldName = suggested?.fieldName ?? suggestSimpleFieldName(keyName);
  const existingFields = known.get(modelName) ?? [];
  const fieldName = await promptFieldName(existingFields, defaultFieldName, modelName);

  return { modelName, fieldName };
}

async function promptEnumName(
  enums: EnumRegistry,
  defaultEnumName: string,
): Promise<string> {
  const enumNames = Object.keys(enums).sort((a, b) => a.localeCompare(b));
  if (enumNames.length === 0) {
    const raw = await tracedInput('enum.name', { message: 'Enum name:', default: defaultEnumName });
    return requireText(raw, defaultEnumName);
  }

  const enumChoice = await tracedSelect<string>('enum.select', {
    message: 'Select enum:',
    choices: [
      ...enumNames.map((name) => ({ value: name, name })),
      { value: '__new__', name: 'Create new enum' },
    ],
  });

  if (enumChoice !== '__new__') return enumChoice;
  const raw = await tracedInput('enum.new', { message: 'New enum name:', default: defaultEnumName });
  return requireText(raw, defaultEnumName);
}

function knownModels(components: SharedComponents): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const id of Object.keys(components)) {
    const parsed = parseModelFieldId(id);
    if (!parsed) continue;
    const existing = map.get(parsed.modelName) ?? [];
    if (!existing.includes(parsed.fieldName)) existing.push(parsed.fieldName);
    map.set(parsed.modelName, existing);
  }
  for (const [modelName, fields] of map.entries()) {
    fields.sort((a, b) => a.localeCompare(b));
    map.set(modelName, fields);
  }
  return map;
}

async function promptModelName(
  known: Map<string, string[]>,
  defaultModelName: string,
): Promise<string> {
  const modelNames = Array.from(known.keys()).sort((a, b) => a.localeCompare(b));
  if (modelNames.length === 0) {
    const raw = await tracedInput('model.name', { message: 'Model name:', default: defaultModelName });
    return requireText(raw, defaultModelName);
  }

  const modelChoice = await tracedSelect<string>('model.select', {
    message: 'Select model:',
    choices: [
      ...modelNames.map((name) => ({ value: name, name })),
      { value: '__new__', name: 'Create new model' },
    ],
  });

  if (modelChoice !== '__new__') return modelChoice;
  const raw = await tracedInput('model.new', { message: 'New model name:', default: defaultModelName });
  return requireText(raw, defaultModelName);
}

async function promptFieldName(
  existingFields: string[],
  defaultFieldName: string,
  modelName: string,
): Promise<string> {
  if (existingFields.length === 0) {
    const raw = await tracedInput('field.name', { message: `Field name for ${modelName}:`, default: defaultFieldName });
    return requireText(raw, defaultFieldName);
  }

  const fieldChoice = await tracedSelect<string>('field.select', {
    message: `Select field for ${modelName}:`,
    choices: [
      ...existingFields.map((name) => ({ value: name, name })),
      { value: '__new__', name: 'Create new field' },
    ],
  });

  if (fieldChoice !== '__new__') return fieldChoice;
  const raw = await tracedInput('field.new', { message: `New field name for ${modelName}:`, default: defaultFieldName });
  return requireText(raw, defaultFieldName);
}

function parseModelFieldId(value: string | undefined): ModelFieldRef | null {
  if (!value) return null;
  const trimmed = value.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0 || lastDot >= trimmed.length - 1) return null;
  const modelName = trimmed.slice(0, lastDot).trim();
  const fieldName = trimmed.slice(lastDot + 1).trim();
  if (!modelName || !fieldName) return null;
  return { modelName, fieldName };
}

function suggestModelName(keyName: string): string {
  const parsed = suggestSimpleFieldName(keyName);
  if (parsed === keyName) return keyName;
  return parsed;
}

function suggestSimpleFieldName(keyName: string): string {
  const bySuffix = (suffix: string): string | null => {
    if (!keyName.endsWith(suffix) || keyName.length <= suffix.length) return null;
    return keyName.slice(0, -suffix.length);
  };
  return bySuffix('Id')
    ?? bySuffix('Title')
    ?? bySuffix('Name')
    ?? keyName;
}

function requireText(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 0) return trimmed;
  return fallback;
}

// ── Batch review (edit decisions JSON) ──────────────────────────────

export async function promptBatchOrInteractive(): Promise<'interactive' | 'batch'> {
  return tracedSelect('review.mode', {
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
  return tracedSelect('validation.failure', {
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

  return tracedSelect('main.menu', { message: 'What would you like to do?', choices });
}

export async function promptSelectSession(
  sessions: { name: string; step: string }[],
): Promise<string> {
  return tracedSelect('session.select', {
    message: 'Select a session to resume:',
    choices: sessions.map((s) => ({
      value: s.name,
      name: `${s.name} (step: ${s.step})`,
    })),
  });
}

export async function promptContinue(message: string): Promise<boolean> {
  return tracedConfirm('continue.confirm', { message, default: true });
}
