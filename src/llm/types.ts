import type { FieldKind } from '../types.js';

export interface SuggestionAdvice {
  kind: FieldKind;
  confidence: number;
  reason: string;
  /**
   * Canonical field/component id to use when selecting fk/foreign_value/source kinds.
   * Example: "Committee.Id"
   */
  targetFieldId?: string;
  /**
   * Existing component id to reuse (mainly for enums).
   */
  reuseComponentId?: string;
  /**
   * Suggested new component/type name when creating a new shared definition.
   */
  newComponentName?: string;
  /**
   * Companion source field id suggestion:
   * - for fk, usually an index_source id
   * - for foreign_value, usually a value_source id
   */
  sourceReferenceFieldId?: string;
}

export interface SuggestionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SuggestionCacheEntry {
  model: string;
  createdAt: string;
  latencyMs: number;
  advice: SuggestionAdvice;
  usage?: SuggestionUsage;
}

export interface SuggestionMetrics {
  attemptedCalls: number;
  completedCalls: number;
  failedCalls: number;
  cacheHits: number;
  suggestionsShown: number;
  decisionCount: number;
  decisionsWithSuggestion: number;
  acceptedKind: number;
  acceptedExact: number;
  decisionTimeMsTotal: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface SuggestionsState {
  version: 1;
  model: string;
  confidenceThreshold: number;
  suggestions: Record<string, SuggestionCacheEntry>;
  metrics: SuggestionMetrics;
}
