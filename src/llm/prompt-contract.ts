import type {
  SuggestionAdvice,
  SuggestionUsage,
} from './types.js';

export interface SuggestionPromptRequest {
  model: string;
  apiKey: string;
  prompt: string;
}

export interface SuggestionPromptResponse {
  advice?: SuggestionAdvice;
  usage?: SuggestionUsage;
  rawResponse?: Record<string, unknown>;
  error?: string;
}

export type SuggestionPromptFunction = (
  input: SuggestionPromptRequest,
) => Promise<SuggestionPromptResponse>;
