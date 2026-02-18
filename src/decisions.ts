/**
 * Decisions: load/save user decisions (enum/FK/scalar classifications)
 * and manage the undo stack.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { Decisions, FieldDecision, SharedComponents, SharedComponent } from './types.js';

// ── Serializable format (JSON-friendly) ─────────────────────────────

interface DecisionsFile {
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
    const data: DecisionsFile = JSON.parse(raw);
    return {
      decisions: { fields: data.fields ?? {} },
      components: data.components ?? {},
    };
  } catch {
    return createEmptyDecisions();
  }
}

/** Optional reference for batch edit: keyName -> { values, uniqueCount, totalOccurrences } */
export type SuspectReference = Record<string, { values: (string | number | boolean)[]; uniqueCount: number; totalOccurrences: number }>;

export async function saveDecisions(
  path: string,
  decisions: Decisions,
  components: SharedComponents,
  suspectReference?: SuspectReference,
): Promise<void> {
  const data: DecisionsFile & { _suspectValues?: SuspectReference } = {
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
    if (comp.kind !== 'enum') continue;
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
}

/**
 * Generate a unique component ID. Auto-derives from keyName;
 * appends a number if it already exists.
 */
export function generateComponentId(
  components: SharedComponents,
  keyName: string,
  kind: 'enum' | 'fk',
): string {
  const suffix = kind === 'enum' ? 'Enum' : 'Ref';
  const base = `${keyName}${suffix}`;
  if (!(base in components)) return base;

  let i = 2;
  while (`${base}${i}` in components) i++;
  return `${base}${i}`;
}
