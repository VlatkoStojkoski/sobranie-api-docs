import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

import type {
  SuggestionPromptFunction,
  SuggestionPromptRequest,
  SuggestionPromptResponse,
} from './prompt-contract.js';
import {
  normalizeSuggestionOutput,
  SUGGESTION_SCHEMA,
  SUGGESTION_SYSTEM_PROMPT,
} from './suggestion-format.js';
import type { SuggestionUsage } from './types.js';

export const promptSuggestionWithVercel: SuggestionPromptFunction = async (
  input: SuggestionPromptRequest,
): Promise<SuggestionPromptResponse> => {
  const google = createGoogleGenerativeAI({ apiKey: input.apiKey });

  try {
    const result = await generateText({
      model: google(input.model),
      temperature: 0,
      maxOutputTokens: 2000,
      output: Output.object({ schema: SUGGESTION_SCHEMA }),
      system: SUGGESTION_SYSTEM_PROMPT,
      prompt: input.prompt,
    });

    return {
      advice: normalizeSuggestionOutput(result.output),
      usage: usageFromVercel(result.usage),
      rawResponse: result.output as Record<string, unknown>,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

function usageFromVercel(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
): SuggestionUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  };
}
