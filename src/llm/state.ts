import { readFile, writeFile } from 'node:fs/promises';
import type {
  SuggestionAdvice,
  SuggestionCacheEntry,
  SuggestionsState,
  SuggestionMetrics,
  SuggestionUsage,
} from './types.js';

export interface SuggestionPricing {
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
}

export interface SessionUsageSnapshot {
  version: 1;
  updatedAt: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
  calls: {
    attempted: number;
    completed: number;
    failed: number;
    cacheHits: number;
    promptResponses: number;
  };
  pricing: {
    inputUsdPer1M: number;
    outputUsdPer1M: number;
  };
}

export function defaultSuggestionMetrics(): SuggestionMetrics {
  return {
    attemptedCalls: 0,
    completedCalls: 0,
    failedCalls: 0,
    cacheHits: 0,
    suggestionsShown: 0,
    decisionCount: 0,
    decisionsWithSuggestion: 0,
    acceptedKind: 0,
    acceptedExact: 0,
    decisionTimeMsTotal: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  };
}

export function createEmptySuggestionsState(
  model: string,
  confidenceThreshold: number,
): SuggestionsState {
  return {
    version: 1,
    model,
    confidenceThreshold,
    suggestions: {},
    metrics: defaultSuggestionMetrics(),
  };
}

export async function loadSuggestionsState(
  path: string,
  model: string,
  confidenceThreshold: number,
): Promise<SuggestionsState> {
  try {
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw) as Partial<SuggestionsState>;
    const suggestions = normalizeSuggestionCacheEntries(data.suggestions);
    return {
      version: 1,
      model: data.model ?? model,
      confidenceThreshold: data.confidenceThreshold ?? confidenceThreshold,
      suggestions,
      metrics: {
        ...defaultSuggestionMetrics(),
        ...(data.metrics ?? {}),
      },
    };
  } catch {
    return createEmptySuggestionsState(model, confidenceThreshold);
  }
}

export async function saveSuggestionsState(
  path: string,
  state: SuggestionsState,
): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
}

export async function saveSessionUsageSnapshot(
  path: string,
  state: SuggestionsState,
  pricing: SuggestionPricing,
): Promise<void> {
  const snapshot: SessionUsageSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    model: state.model,
    usage: {
      inputTokens: state.metrics.inputTokens,
      outputTokens: state.metrics.outputTokens,
      totalTokens: state.metrics.totalTokens,
      estimatedCostUsd: state.metrics.estimatedCostUsd,
    },
    calls: {
      attempted: state.metrics.attemptedCalls,
      completed: state.metrics.completedCalls,
      failed: state.metrics.failedCalls,
      cacheHits: state.metrics.cacheHits,
      promptResponses: state.metrics.completedCalls + state.metrics.failedCalls,
    },
    pricing: {
      inputUsdPer1M: pricing.inputUsdPer1M ?? 0,
      outputUsdPer1M: pricing.outputUsdPer1M ?? 0,
    },
  };
  await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf-8');
}

export function applyUsageToMetrics(
  metrics: SuggestionMetrics,
  usage: SuggestionUsage | undefined,
  pricing: SuggestionPricing,
): void {
  if (!usage) return;
  metrics.inputTokens += usage.inputTokens;
  metrics.outputTokens += usage.outputTokens;
  metrics.totalTokens += usage.totalTokens;
  metrics.estimatedCostUsd += estimateUsageCostUsd(usage, pricing);
}

export function estimateUsageCostUsd(
  usage: SuggestionUsage,
  pricing: SuggestionPricing,
): number {
  const inputRate = pricing.inputUsdPer1M ?? 0;
  const outputRate = pricing.outputUsdPer1M ?? 0;
  const inputCost = (usage.inputTokens / 1_000_000) * inputRate;
  const outputCost = (usage.outputTokens / 1_000_000) * outputRate;
  return inputCost + outputCost;
}

function normalizeSuggestionCacheEntries(
  input: unknown,
): Record<string, SuggestionCacheEntry> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, SuggestionCacheEntry> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<SuggestionCacheEntry> & { advice?: unknown };
    const advice = normalizeSuggestionAdvice(entry.advice);
    if (!advice) continue;
    out[key] = {
      model: typeof entry.model === 'string' ? entry.model : 'unknown',
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
      latencyMs: typeof entry.latencyMs === 'number' ? entry.latencyMs : 0,
      advice,
      usage: entry.usage,
    };
  }
  return out;
}

function normalizeSuggestionAdvice(input: unknown): SuggestionAdvice | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<SuggestionAdvice>;
  if (typeof value.overallReason !== 'string') return null;
  if (!value.source || !value.reference) return null;
  return value as SuggestionAdvice;
}
