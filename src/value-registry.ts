/**
 * Value Registry: collect all observed leaf values per scoped field key.
 * Scope = method + request/response side + parent path + field name.
 *
 * A field is "suspect" if at least one value appears more than once.
 */

import { JSONPath } from 'jsonpath-plus';
import type { MethodCorpus, ValueRegistry, ValueEntry, ScopeDirection } from './types.js';
import { makeScopedFieldKey } from './scoped-field.js';

const EXCLUDED_SUSPECT_KEYS = new Set(['MethodName']);

interface JsonPathMatch {
  value: unknown;
  parentProperty?: string | number;
  pointer?: string;
}

// ── Build registry from all samples ─────────────────────────────────

export function buildValueRegistry(corpora: MethodCorpus[]): ValueRegistry {
  const registry: ValueRegistry = new Map();

  for (const corpus of corpora) {
    for (const sample of corpus.samples) {
      collectLeafValues(sample.request, registry, corpus.methodName, 'request');
      collectLeafValues(sample.response, registry, corpus.methodName, 'response');
    }
  }

  return registry;
}

function collectLeafValues(
  value: unknown,
  registry: ValueRegistry,
  methodName: string,
  direction: ScopeDirection,
): void {
  if (value === null || value === undefined) return;

  const matches = JSONPath({
    path: '$..*',
    json: value,
    resultType: 'all',
  }) as JsonPathMatch[];

  for (const match of matches) {
    const v = match.value;
    if (v === null || v === undefined) continue;

    if (typeof match.parentProperty !== 'string') continue;
    if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) continue;

    const keyName = match.parentProperty;
    const parentPath = parentPathFromPointer(match.pointer);
    const decisionKey = makeScopedFieldKey(methodName, direction, parentPath, keyName);

    let entry = registry.get(decisionKey);
    if (!entry) {
      entry = {
        methodName,
        direction,
        parentPath,
        keyName,
        values: new Set(),
        counts: new Map(),
      };
      registry.set(decisionKey, entry);
    }

    entry.values.add(v);
    entry.counts.set(v, (entry.counts.get(v) ?? 0) + 1);
  }
}

function parentPathFromPointer(pointer?: string): string {
  if (!pointer || pointer === '') return '$';

  const segments = pointer
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));

  if (segments.length <= 1) return '$';

  const parentSegments = segments.slice(0, -1);
  const out: string[] = [];

  for (const segment of parentSegments) {
    if (/^\d+$/.test(segment)) {
      if (out.length === 0) {
        out.push('[]');
      } else {
        out[out.length - 1] = `${out[out.length - 1]}[]`;
      }
    } else {
      out.push(segment);
    }
  }

  if (out.length === 0) return '$';
  return out.join('.');
}

// ── Suspect detection ───────────────────────────────────────────────

export interface Suspect {
  decisionKey: string;
  methodName: string;
  direction: ScopeDirection;
  parentPath: string;
  keyName: string;
  entry: ValueEntry;
}

/**
 * Returns fields where at least one value appears more than once.
 * Sorted by method, request/response direction, parent path, then key name.
 */
export function detectSuspects(registry: ValueRegistry): Suspect[] {
  const suspects: Suspect[] = [];

  for (const [decisionKey, entry] of registry) {
    if (EXCLUDED_SUSPECT_KEYS.has(entry.keyName)) continue;

    let hasRepeat = false;
    for (const count of entry.counts.values()) {
      if (count > 1) {
        hasRepeat = true;
        break;
      }
    }

    if (!hasRepeat) continue;

    suspects.push({
      decisionKey,
      methodName: entry.methodName,
      direction: entry.direction,
      parentPath: entry.parentPath,
      keyName: entry.keyName,
      entry,
    });
  }

  return suspects.sort((a, b) => (
    a.methodName.localeCompare(b.methodName) ||
    a.direction.localeCompare(b.direction) ||
    a.parentPath.localeCompare(b.parentPath) ||
    a.keyName.localeCompare(b.keyName)
  ));
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
