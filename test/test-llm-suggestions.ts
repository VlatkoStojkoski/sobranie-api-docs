import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createSuggestionClient } from '../src/llm/suggest.js';
import { makeScopedFieldKey } from '../src/scoped-field.js';
import type { Decisions, SharedComponents, ValueEntry } from '../src/types.js';
import type { Suspect } from '../src/value-registry.js';

async function main(): Promise<void> {
  await loadDotEnvIfPresent();

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) {
    console.log('PASS test-llm-suggestions.ts (skipped: missing GOOGLE_GENERATIVE_AI_API_KEY)');
    return;
  }

  const model = process.env.SUGGESTIONS_MODEL?.trim() || 'gemini-2.5-flash-lite';
  const client = createSuggestionClient({
    provider: 'google',
    model,
    backend: 'google_genai',
  });
  const ready = client.isReady();
  assert.equal(ready.ok, true, `Suggestion client not ready: ${ready.reason}`);

  const suspect = buildTypeIdSuspect();
  const components = buildComponents();
  const decisions = buildDecisions();

  const result = await client.suggest({
    suspect,
    components,
    decisions,
    suspects: [suspect, siblingSuspect('TypeTitle', ['Standing', 'Temporary'])],
  });

  assert.equal(result.error, undefined, `LLM returned error: ${result.error ?? 'unknown'}`);
  assert.ok(result.advice, 'LLM should return advice');
  assert.ok(result.latencyMs >= 0, 'latency should be non-negative');

  const advice = result.advice!;
  assert.ok(advice.overallReason.trim().length > 0, 'overallReason should be non-empty');

  validateBinaryStep(advice.source, true);
  validateBinaryStep(advice.reference, true);

  if (result.usage) {
    assert.ok(result.usage.inputTokens >= 0, 'usage.inputTokens should be non-negative');
    assert.ok(result.usage.outputTokens >= 0, 'usage.outputTokens should be non-negative');
    assert.ok(result.usage.totalTokens >= 0, 'usage.totalTokens should be non-negative');
  }

  console.log(`PASS test-llm-suggestions.ts (${model})`);
}

function validateBinaryStep(
  step: {
    recommended: 'yes' | 'no';
    rankedChoices: Array<{ choice: 'yes' | 'no'; rank: 1 | 2; reason: string }>;
    yesPayload: Record<string, unknown>;
    noPayload: Record<string, unknown>;
  },
  shouldValidateFieldId: boolean,
): void {
  assert.ok(step.recommended === 'yes' || step.recommended === 'no');
  assert.equal(step.rankedChoices.length, 2, 'binary step should contain two choices');
  const choices = new Set(step.rankedChoices.map((item) => item.choice));
  const ranks = new Set(step.rankedChoices.map((item) => item.rank));
  assert.deepEqual(choices, new Set(['yes', 'no']));
  assert.deepEqual(ranks, new Set([1, 2]));
  for (const item of step.rankedChoices) {
    assert.ok(item.reason.trim().length > 0, 'ranked choice reason should be non-empty');
  }
  assert.ok(step.noPayload, 'noPayload should exist');
  assert.ok(step.yesPayload, 'yesPayload should exist');
  if (!shouldValidateFieldId) return;
  const fieldId = String(step.yesPayload.fieldId ?? '');
  assert.ok(
    /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(fieldId),
    `yesPayload.fieldId should be Model.Field, got: ${fieldId}`,
  );
}

function buildTypeIdSuspect(): Suspect {
  const entry: ValueEntry = {
    methodName: 'GetAllCommittees',
    direction: 'response',
    parentPath: '[]',
    keyName: 'TypeId',
    values: new Set([1, 2, 4]),
    counts: new Map([
      [1, 15],
      [2, 8],
      [4, 3],
    ]),
  };
  return {
    decisionKey: makeScopedFieldKey('GetAllCommittees', 'response', '[]', 'TypeId'),
    methodName: entry.methodName,
    direction: entry.direction,
    parentPath: entry.parentPath,
    keyName: entry.keyName,
    entry,
  };
}

function siblingSuspect(keyName: string, values: string[]): Suspect {
  const entry: ValueEntry = {
    methodName: 'GetAllCommittees',
    direction: 'response',
    parentPath: '[]',
    keyName,
    values: new Set(values),
    counts: new Map(values.map((value) => [value, 2] as const)),
  };
  return {
    decisionKey: makeScopedFieldKey('GetAllCommittees', 'response', '[]', keyName),
    methodName: entry.methodName,
    direction: entry.direction,
    parentPath: entry.parentPath,
    keyName: entry.keyName,
    entry,
  };
}

function buildComponents(): SharedComponents {
  return {
    'Committee.TypeId': {
      kind: 'field',
      baseType: 'integer',
      values: [1, 2, 4],
      description: 'Committee type id',
    },
    'Committee.TypeTitle': {
      kind: 'field',
      baseType: 'string',
      values: ['Standing', 'Temporary', 'Special'],
      description: 'Committee type label',
    },
  };
}

function buildDecisions(): Decisions {
  return {
    fields: {
      [makeScopedFieldKey('GetAllDelegations', 'response', '[]', 'TypeId')]: {
        kind: 'source_reference',
        sourceFieldId: 'Delegation.TypeId',
        referenceFieldId: 'Delegation.TypeId',
      },
      [makeScopedFieldKey('GetAllDelegations', 'response', '[]', 'TypeTitle')]: {
        kind: 'source',
        sourceFieldId: 'Delegation.TypeTitle',
      },
      [makeScopedFieldKey('GetAllCommittees', 'response', '[]', 'TypeTitle')]: {
        kind: 'source',
        sourceFieldId: 'Committee.TypeTitle',
      },
    },
  };
}

async function loadDotEnvIfPresent(): Promise<void> {
  try {
    const raw = await readFile('.env', 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      if (!key || process.env[key]) continue;
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      process.env[key] = value;
    }
  } catch {
    // ignore missing .env or read errors
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
