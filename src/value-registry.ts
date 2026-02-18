/**
 * Value Registry: collect all observed leaf values per keyName across all methods.
 * Used to detect suspects (fields that might be enums or foreign keys).
 *
 * A field is "suspect" if at least one value appears more than once.
 */

import type { MethodCorpus, ValueRegistry, ValueEntry } from './types.js';

// ── Build registry from all samples ─────────────────────────────────

export function buildValueRegistry(corpora: MethodCorpus[]): ValueRegistry {
  const registry: ValueRegistry = new Map();

  for (const corpus of corpora) {
    for (const sample of corpus.samples) {
      collectLeafValues(sample.request, registry);
      collectLeafValues(sample.response, registry);
    }
  }

  return registry;
}

function collectLeafValues(value: unknown, registry: ValueRegistry): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLeafValues(item, registry);
    }
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (val === null || val === undefined) continue;

      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        let entry = registry.get(key);
        if (!entry) {
          entry = { values: new Set(), counts: new Map() };
          registry.set(key, entry);
        }
        entry.values.add(val);
        entry.counts.set(val, (entry.counts.get(val) ?? 0) + 1);
      } else {
        collectLeafValues(val, registry);
      }
    }
    return;
  }
}

// ── Suspect detection ───────────────────────────────────────────────

export interface Suspect {
  keyName: string;
  entry: ValueEntry;
}

/**
 * Returns fields where at least one value appears more than once.
 * Sorted by key name for deterministic ordering.
 */
export function detectSuspects(registry: ValueRegistry): Suspect[] {
  const suspects: Suspect[] = [];

  for (const [keyName, entry] of registry) {
    let hasRepeat = false;
    for (const count of entry.counts.values()) {
      if (count > 1) {
        hasRepeat = true;
        break;
      }
    }
    if (hasRepeat) {
      suspects.push({ keyName, entry });
    }
  }

  return suspects.sort((a, b) => a.keyName.localeCompare(b.keyName));
}

// ── Overlap detection ───────────────────────────────────────────────

/**
 * Check if two value sets overlap (share at least one value).
 */
export function valueSetsOverlap(a: Set<string | number | boolean>, b: Set<string | number | boolean>): boolean {
  for (const v of a) {
    if (b.has(v)) return true;
  }
  return false;
}

/**
 * Check if two value sets are exactly equal.
 */
export function valueSetsEqual(a: Set<string | number | boolean>, b: Set<string | number | boolean>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}
