import { readFile, writeFile } from 'node:fs/promises';
import type {
  SuggestionsState,
  SuggestionMetrics,
  SuggestionUsage,
} from './types.js';

export interface SuggestionPricing {
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
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
    return {
      version: 1,
      model: data.model ?? model,
      confidenceThreshold: data.confidenceThreshold ?? confidenceThreshold,
      suggestions: data.suggestions ?? {},
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
