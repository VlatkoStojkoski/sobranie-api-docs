export type SuggestionChoice = 'yes' | 'no';
export type SuggestionBinaryRank = 1 | 2;

export interface SuggestionRankedChoice {
  choice: SuggestionChoice;
  rank: SuggestionBinaryRank;
  reason: string;
}

export interface SuggestionSourceStep {
  recommended: SuggestionChoice;
  rankedChoices: SuggestionRankedChoice[];
  yesPayload: {
    fieldId: string;
    reason: string;
  };
  noPayload: {
    reason: string;
  };
}

export interface SuggestionReferenceStep {
  recommended: SuggestionChoice;
  rankedChoices: SuggestionRankedChoice[];
  yesPayload: {
    fieldId: string;
    reason: string;
  };
  noPayload: {
    reason: string;
  };
}

export interface SuggestionAdvice {
  /**
   * Short summary explaining how source/reference recommendations fit together.
   * Scalar is implied when both source and reference are "no".
   */
  overallReason: string;
  source: SuggestionSourceStep;
  reference: SuggestionReferenceStep;
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
