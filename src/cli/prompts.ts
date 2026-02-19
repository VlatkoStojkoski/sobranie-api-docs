/**
 * Interactive prompts for user decisions.
 * Decision flow:
 * 1) choose accept/back/manual path
 * 2) decide source role (optional)
 * 3) decide reference role (optional)
 * Scalar is implied when both source and reference are not selected.
 */

import { select, confirm, input } from '@inquirer/prompts';
import { emitKeypressEvents } from 'node:readline';
import type { FieldKind, SharedComponents, SharedComponent } from '../types.js';
import type { Suspect } from '../value-registry.js';
import type { SuggestionAdvice, SuggestionChoice } from '../llm/types.js';
import { addComponent } from '../decisions.js';

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
  sourceFieldId?: string;
  referenceFieldId?: string;
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

  console.log(`\n[${index + 1}/${total}] Field: ${keyName}`);
  console.log(`  Method: ${methodName}  |  Side: ${direction}  |  Parent: ${suspect.parentPath}`);
  console.log(`  Unique values: ${uniqueCount}  |  Total occurrences: ${totalOccurrences}`);
  console.log(`  Values: ${formatValues(entry.values)}`);
  if (suggestion) {
    const sourceText = suggestion.source.recommended === 'yes'
      ? `yes -> ${suggestion.source.yesPayload.fieldId}`
      : 'no';
    const referenceText = suggestion.reference.recommended === 'yes'
      ? `yes -> ${suggestion.reference.yesPayload.fieldId}`
      : 'no';
    console.log(`  Suggested source step: ${sourceText}`);
    console.log(`  Suggested reference step: ${referenceText}`);
    if (suggestion.source.recommended === 'no' && suggestion.reference.recommended === 'no') {
      console.log('  Implied scalar outcome: yes (both roles are no)');
    }
    console.log(`  Why: ${suggestion.overallReason}`);
  }

  const inferredType = inferBaseType(entry.values);
  const valuesArr = Array.from(entry.values);
  const topSelectChoices: { value: '__manual__' | '__back__' | '__accept__'; name: string }[] = [];
  if (canAcceptSuggestion(suggestion)) {
    topSelectChoices.push({ value: '__accept__', name: `Accept full suggestion path` });
  }
  topSelectChoices.push({ value: '__back__', name: 'Go back to previous field (undo last decision)' });
  topSelectChoices.push({ value: '__manual__', name: 'Choose source/reference roles manually' });

  while (true) {
    const startAction = await tracedSelect<'__manual__' | '__back__' | '__accept__'>('suspect.path', {
      message: `How should "${keyName}" be classified?`,
      choices: topSelectChoices,
    });

    if (startAction === '__back__') return { action: 'back' };
    if (startAction === '__accept__') {
      const accepted = await applyAcceptedSuggestion(
        suggestion,
        components,
        keyName,
        inferredType,
        valuesArr,
      );
      if (accepted) return accepted;
      console.log('  Suggestion path is incomplete. Choose manually.\n');
      continue;
    }

    // Manual role selection flow.
    const sourceDecision = await promptBinaryStep(
      'suspect.source',
      'Should this field map to a source model field?',
      suggestion?.source.recommended,
      suggestion?.source.yesPayload.fieldId,
    );
    const sourceFieldId = sourceDecision === 'yes'
      ? await promptForModelField(
        components,
        keyName,
        suggestion?.source.yesPayload.fieldId,
      )
      : undefined;

    const referenceDecision = await promptBinaryStep(
      'suspect.reference',
      'Should this field reference another model field?',
      suggestion?.reference.recommended,
      suggestion?.reference.yesPayload.fieldId,
    );
    const referenceFieldId = referenceDecision === 'yes'
      ? await promptForModelField(
        components,
        `${keyName}Reference`,
        suggestion?.reference.yesPayload.fieldId,
      )
      : undefined;

    if (sourceFieldId) {
      ensureComponent(components, sourceFieldId, inferredType, valuesArr, `Model field for ${keyName}`);
    }
    if (referenceFieldId && !components[referenceFieldId]) {
      // For pure reference targets, create a placeholder field component if it does not yet exist.
      ensureComponent(components, referenceFieldId, inferredType, [], `Reference target for ${keyName}`);
    }

    return {
      action: 'apply',
      kind: fieldKindFromFlags(!!sourceFieldId, !!referenceFieldId),
      sourceFieldId,
      referenceFieldId,
    };
  }
}

async function promptBinaryStep(
  context: string,
  message: string,
  suggested: SuggestionChoice | undefined,
  suggestedFieldId?: string,
): Promise<SuggestionChoice> {
  const yesLabel = suggested === 'yes'
    ? `Yes (suggested${suggestedFieldId ? ` -> ${suggestedFieldId}` : ''})`
    : 'Yes';
  const noLabel = suggested === 'no' ? 'No (suggested)' : 'No';
  return tracedSelect<SuggestionChoice>(context, {
    message,
    choices: [
      { value: 'yes', name: yesLabel },
      { value: 'no', name: noLabel },
    ],
  });
}

function canAcceptSuggestion(suggestion: SuggestionAdvice | undefined): boolean {
  if (!suggestion) return false;
  return (
    suggestion.source.recommended === 'yes'
    || suggestion.reference.recommended === 'yes'
    || (suggestion.source.recommended === 'no' && suggestion.reference.recommended === 'no')
  );
}

async function applyAcceptedSuggestion(
  suggestion: SuggestionAdvice | undefined,
  components: SharedComponents,
  keyName: string,
  inferredType: { baseType: string; baseTypes?: string[] },
  values: (string | number | boolean)[],
): Promise<PromptResult | undefined> {
  if (!suggestion) return undefined;

  let sourceFieldId = suggestion.source.recommended === 'yes'
    ? normalizeModelFieldId(suggestion.source.yesPayload.fieldId)
    : undefined;
  let referenceFieldId = suggestion.reference.recommended === 'yes'
    ? normalizeModelFieldId(suggestion.reference.yesPayload.fieldId)
    : undefined;

  if (suggestion.source.recommended === 'yes') {
    const sourceChoice = await tracedSelect<'use' | 'edit' | 'skip'>('suggestion.accept.source', {
      message: `Apply suggested source target${sourceFieldId ? ` (${sourceFieldId})` : ''}?`,
      choices: [
        { value: 'use', name: 'Use suggested source target' },
        { value: 'edit', name: 'Edit source target' },
        { value: 'skip', name: 'Do not set source role' },
      ],
    });
    if (sourceChoice === 'edit') {
      sourceFieldId = await promptForModelField(components, keyName, sourceFieldId);
    } else if (sourceChoice === 'skip') {
      sourceFieldId = undefined;
    }
  }

  if (suggestion.reference.recommended === 'yes') {
    const referenceChoice = await tracedSelect<'use' | 'edit' | 'skip'>('suggestion.accept.reference', {
      message: `Apply suggested reference target${referenceFieldId ? ` (${referenceFieldId})` : ''}?`,
      choices: [
        { value: 'use', name: 'Use suggested reference target' },
        { value: 'edit', name: 'Edit reference target' },
        { value: 'skip', name: 'Do not set reference role' },
      ],
    });
    if (referenceChoice === 'edit') {
      referenceFieldId = await promptForModelField(
        components,
        `${keyName}Reference`,
        referenceFieldId,
      );
    } else if (referenceChoice === 'skip') {
      referenceFieldId = undefined;
    }
  }

  if (!sourceFieldId && !referenceFieldId) {
    // Implied scalar outcome: neither source nor reference role is selected.
    return { action: 'apply', kind: 'scalar' };
  }

  if (sourceFieldId) {
    ensureComponent(components, sourceFieldId, inferredType, values, `Model field for ${keyName}`);
  }
  if (referenceFieldId && !components[referenceFieldId]) {
    ensureComponent(components, referenceFieldId, inferredType, [], `Reference target for ${keyName}`);
  }

  return {
    action: 'apply',
    kind: fieldKindFromFlags(!!sourceFieldId, !!referenceFieldId),
    sourceFieldId,
    referenceFieldId,
  };
}

function fieldKindFromFlags(
  hasSource: boolean,
  hasReference: boolean,
): FieldKind {
  if (hasSource && hasReference) return 'source_reference';
  if (hasSource) return 'source';
  if (hasReference) return 'reference';
  return 'scalar';
}

function ensureComponent(
  components: SharedComponents,
  fieldId: string,
  inferredType: { baseType: string; baseTypes?: string[] },
  values: (string | number | boolean)[],
  description: string,
): void {
  if (components[fieldId]) return;
  const component: SharedComponent = {
    kind: 'field',
    baseType: inferredType.baseType,
    ...(inferredType.baseTypes ? { baseTypes: inferredType.baseTypes } : {}),
    values: [...values],
    description,
  };
  addComponent(components, fieldId, component);
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

async function promptForModelField(
  components: SharedComponents,
  keyName: string,
  suggestedFieldId?: string,
): Promise<string> {
  const known = knownModels(components);
  const suggested = parseModelFieldId(suggestedFieldId);

  const defaultModelName = suggested?.modelName ?? suggestModelName(keyName);
  const modelName = await promptModelName(known, defaultModelName);

  const defaultFieldName = suggested?.fieldName ?? suggestSimpleFieldName(keyName);
  const existingFields = known.get(modelName) ?? [];
  const fieldName = await promptFieldName(existingFields, defaultFieldName, modelName);
  return `${modelName}.${fieldName}`;
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

function normalizeModelFieldId(value: string | undefined): string | undefined {
  const parsed = parseModelFieldId(value);
  if (!parsed) return undefined;
  return `${parsed.modelName}.${parsed.fieldName}`;
}

function parseModelFieldId(value: string | undefined): ModelFieldRef | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.includes('[]') || trimmed.includes('::') || trimmed.includes('/')) return null;
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0 || lastDot >= trimmed.length - 1) return null;
  const modelName = trimmed.slice(0, lastDot).trim();
  const fieldName = trimmed.slice(lastDot + 1).trim();
  if (!modelName || !fieldName) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(modelName)) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)) return null;
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
