/**
 * Decisions: load/save user decisions (scalar/source/reference classifications)
 * and manage the undo stack.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type {
  Decisions,
  FieldDecision,
  SharedComponents,
  SharedComponent,
  ScopeDirection,
} from './types.js';

// ── Serializable format (JSON-friendly) ─────────────────────────────

interface DecisionsFile {
  version: 4;
  fields: Record<string, FieldDecision>;
  components: SharedComponents;
}

// ── Load / Save ─────────────────────────────────────────────────────

export function createEmptyDecisions(): { decisions: Decisions; components: SharedComponents } {
  return {
    decisions: { fields: {} },
    components: {},
  };
}

export async function loadDecisions(path: string): Promise<{ decisions: Decisions; components: SharedComponents }> {
  try {
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw) as DecisionsFile;
    if (!isDecisionsFile(data)) {
      throw new Error('Invalid decisions.json schema');
    }
    return {
      decisions: { fields: data.fields ?? {} },
      components: data.components ?? {},
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return createEmptyDecisions();
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}

function isDecisionsFile(value: unknown): value is DecisionsFile {
  if (!value || typeof value !== 'object') return false;
  const obj = value as { version?: unknown; fields?: unknown; components?: unknown };
  if (obj.version !== 4) return false;
  if (!obj.fields || typeof obj.fields !== 'object') return false;
  if (!obj.components || typeof obj.components !== 'object') return false;
  return true;
}

/** Optional reference for batch edit: decisionKey -> metadata + values */
export type SuspectReference = Record<string, {
  methodName: string;
  direction: ScopeDirection;
  parentPath: string;
  keyName: string;
  values: (string | number | boolean)[];
  uniqueCount: number;
  totalOccurrences: number;
}>;

export async function saveDecisions(
  path: string,
  decisions: Decisions,
  components: SharedComponents,
  suspectReference?: SuspectReference,
): Promise<void> {
  const data: DecisionsFile & { _suspectValues?: SuspectReference } = {
    version: 4,
    fields: decisions.fields,
    components,
  };
  if (suspectReference && Object.keys(suspectReference).length > 0) {
    data._suspectValues = suspectReference;
  }
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Decision helpers ────────────────────────────────────────────────

export function setFieldDecision(
  decisions: Decisions,
  keyName: string,
  decision: FieldDecision,
): void {
  decisions.fields[keyName] = decision;
}

export function removeFieldDecision(
  decisions: Decisions,
  keyName: string,
): void {
  delete decisions.fields[keyName];
}

// ── Component helpers ───────────────────────────────────────────────

export function addComponent(
  components: SharedComponents,
  id: string,
  component: SharedComponent,
): void {
  components[id] = component;
}

export function removeComponent(
  components: SharedComponents,
  id: string,
): void {
  delete components[id];
}

/**
 * Find existing components whose value sets overlap with the given values.
 * Returns components sorted by overlap size (largest first).
 */
export function findOverlappingComponents(
  components: SharedComponents,
  values: (string | number | boolean)[],
): { id: string; component: SharedComponent; overlapCount: number }[] {
  const valueSet = new Set(values);
  const matches: { id: string; component: SharedComponent; overlapCount: number }[] = [];

  for (const [id, comp] of Object.entries(components)) {
    if (!Array.isArray(comp.values) || comp.values.length === 0) continue;
    let overlap = 0;
    for (const v of comp.values) {
      if (valueSet.has(v)) overlap++;
    }
    if (overlap > 0) {
      matches.push({ id, component: comp, overlapCount: overlap });
    }
  }

  return matches.sort((a, b) => b.overlapCount - a.overlapCount);
}

/**
 * Merge values into an existing component (union).
 */
export function mergeIntoComponent(
  components: SharedComponents,
  id: string,
  newValues: (string | number | boolean)[],
): void {
  const comp = components[id];
  if (!comp) return;
  const existing = new Set(comp.values);
  for (const v of newValues) {
    existing.add(v);
  }
  comp.values = Array.from(existing).sort((a, b) => String(a).localeCompare(String(b)));

  // Keep base type metadata aligned when merged values introduce new primitive types.
  const mergedTypes = inferTypesFromValues(comp.values);
  if (mergedTypes.length === 0) return;
  if (mergedTypes.length === 1) {
    comp.baseType = mergedTypes[0]!;
    delete comp.baseTypes;
  } else {
    comp.baseType = 'mixed';
    comp.baseTypes = mergedTypes;
  }
}

function inferTypesFromValues(values: (string | number | boolean)[]): string[] {
  let hasString = false;
  let hasNumber = false;
  let hasInteger = true;
  let hasBoolean = false;

  for (const value of values) {
    if (typeof value === 'string') hasString = true;
    if (typeof value === 'boolean') hasBoolean = true;
    if (typeof value === 'number') {
      hasNumber = true;
      if (!Number.isInteger(value)) hasInteger = false;
    }
  }

  const out: string[] = [];
  if (hasString) out.push('string');
  if (hasNumber) out.push(hasInteger ? 'integer' : 'number');
  if (hasBoolean) out.push('boolean');
  return out;
}

/**
 * Generate a unique component ID. Auto-derives from keyName;
 * appends a number if it already exists.
 */
export function generateComponentId(
  components: SharedComponents,
  keyName: string,
  kind: 'field',
): string {
  const suffix = kind === 'field' ? 'Field' : 'Field';
  const base = `${keyName}${suffix}`;
  if (!(base in components)) return base;

  let i = 2;
  while (`${base}${i}` in components) i++;
  return `${base}${i}`;
}
