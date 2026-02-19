import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

import type { Decisions, SharedComponents } from '../types.js';
import type { Suspect } from '../value-registry.js';
import { findOverlappingComponents } from '../decisions.js';
import type { SuggestionAdvice, SuggestionUsage } from './types.js';

const SUGGESTION_SCHEMA = z.object({
  kind: z.enum(['scalar', 'enum', 'fk', 'foreign_value', 'index_source', 'value_source']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(220),
  targetFieldId: z.string().min(1).max(120).optional(),
  reuseComponentId: z.string().min(1).max(120).optional(),
  newComponentName: z.string().min(1).max(120).optional(),
  sourceReferenceFieldId: z.string().min(1).max(120).optional(),
});

export interface SuggestionRequest {
  suspect: Suspect;
  components: SharedComponents;
  decisions: Decisions;
}

export interface SuggestionResult {
  advice?: SuggestionAdvice;
  usage?: SuggestionUsage;
  latencyMs: number;
  error?: string;
}

export interface SuggestionClient {
  readonly model: string;
  isReady(): { ok: true } | { ok: false; reason: string };
  suggest(input: SuggestionRequest): Promise<SuggestionResult>;
}

interface GoogleSuggestionClientOptions {
  model: string;
  apiKey?: string;
}

class GoogleSuggestionClient implements SuggestionClient {
  readonly model: string;
  private readonly apiKey?: string;

  constructor(options: GoogleSuggestionClientOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
  }

  isReady(): { ok: true } | { ok: false; reason: string } {
    if (!this.apiKey) {
      return { ok: false, reason: 'Missing GOOGLE_GENERATIVE_AI_API_KEY' };
    }
    return { ok: true };
  }

  async suggest(input: SuggestionRequest): Promise<SuggestionResult> {
    const ready = this.isReady();
    if (!ready.ok) {
      return {
        latencyMs: 0,
        error: ready.reason,
      };
    }

    const startedAt = Date.now();
    const google = createGoogleGenerativeAI({ apiKey: this.apiKey });

    try {
      const result = await generateText({
        model: google(this.model),
        temperature: 0,
        maxOutputTokens: 220,
        output: Output.object({ schema: SUGGESTION_SCHEMA }),
        system: [
          'You are assisting a schema-discovery CLI.',
          'Return only the structured object.',
          'Prefer conservative suggestions and do not over-assert confidence.',
          'Use kind=scalar when evidence is weak.',
        ].join(' '),
        prompt: buildPrompt(input),
      });

      const usage = usageFromResult(result.usage);
      const advice = normalizeAdvice(result.output);

      return {
        advice,
        usage,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export interface CreateSuggestionClientOptions {
  provider: 'google';
  model: string;
}

export function createSuggestionClient(
  options: CreateSuggestionClientOptions,
): SuggestionClient {
  switch (options.provider) {
    case 'google':
    default:
      return new GoogleSuggestionClient({
        model: options.model,
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
  }
}

function buildPrompt(input: SuggestionRequest): string {
  const { suspect, components, decisions } = input;
  const values = Array.from(suspect.entry.values).slice(0, 30);
  const counts: Array<{ value: string | number | boolean; count: number }> = [];
  for (const [value, count] of suspect.entry.counts.entries()) {
    counts.push({ value, count });
  }
  counts.sort((a, b) => b.count - a.count);

  const overlapping = findOverlappingComponents(components, values).slice(0, 10).map((m) => ({
    id: m.id,
    kind: m.component.kind,
    baseType: m.component.baseType,
    overlapCount: m.overlapCount,
    sampleValues: m.component.values.slice(0, 12),
  }));

  const decisionSample = Object.entries(decisions.fields).slice(0, 120).map(([decisionKey, decision]) => ({
    decisionKey,
    kind: decision.kind,
    componentId: decision.componentId,
    matchesExisting: decision.matchesExisting,
  }));

  const payload = {
    task: 'Classify one suspect field for API schema discovery.',
    suspect: {
      decisionKey: suspect.decisionKey,
      methodName: suspect.methodName,
      direction: suspect.direction,
      parentPath: suspect.parentPath,
      keyName: suspect.keyName,
      uniqueCount: suspect.entry.values.size,
      valuePreview: values,
      topCounts: counts.slice(0, 20),
    },
    existingComponents: overlapping,
    decisionsContext: decisionSample,
    outputRequirements: {
      kind: ['scalar', 'enum', 'fk', 'foreign_value', 'index_source', 'value_source'],
      confidenceRange: '0..1',
      reason: 'single short sentence',
      optionalFields: [
        'targetFieldId',
        'reuseComponentId',
        'newComponentName',
        'sourceReferenceFieldId',
      ],
      guidance: [
        'If kind is enum and an existing enum appears equivalent, set reuseComponentId.',
        'If creating a new enum/component, set newComponentName.',
        'If kind is fk/foreign_value/index_source/value_source, set targetFieldId.',
        'If kind is fk or foreign_value and companion source is likely known, set sourceReferenceFieldId.',
      ],
    },
  };

  return JSON.stringify(payload, null, 2);
}

function usageFromResult(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
): SuggestionUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  };
}

function normalizeAdvice(output: z.infer<typeof SUGGESTION_SCHEMA>): SuggestionAdvice {
  return {
    kind: output.kind,
    confidence: clamp01(output.confidence),
    reason: output.reason.trim(),
    targetFieldId: nonEmpty(output.targetFieldId),
    reuseComponentId: nonEmpty(output.reuseComponentId),
    newComponentName: nonEmpty(output.newComponentName),
    sourceReferenceFieldId: nonEmpty(output.sourceReferenceFieldId),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
