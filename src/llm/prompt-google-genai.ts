import {
  GoogleGenAI,
  Type,
} from '@google/genai';

import type {
  SuggestionPromptFunction,
  SuggestionPromptRequest,
  SuggestionPromptResponse,
} from './prompt-contract.js';
import {
  parseSuggestionOutput,
  SUGGESTION_SYSTEM_PROMPT,
} from './suggestion-format.js';
import type { SuggestionUsage } from './types.js';

const GOOGLE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ['overallReason', 'source', 'reference'],
  properties: {
    overallReason: { type: Type.STRING },
    source: binaryStepSchema({
      required: ['recommended', 'rankedChoices', 'yesPayload', 'noPayload'],
      yesPayload: {
        type: Type.OBJECT,
        required: ['fieldId', 'reason'],
        properties: {
          fieldId: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
      },
      noPayload: {
        type: Type.OBJECT,
        required: ['reason'],
        properties: {
          reason: { type: Type.STRING },
        },
      },
    }),
    reference: binaryStepSchema({
      required: ['recommended', 'rankedChoices', 'yesPayload', 'noPayload'],
      yesPayload: {
        type: Type.OBJECT,
        required: ['fieldId', 'reason'],
        properties: {
          fieldId: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
      },
      noPayload: {
        type: Type.OBJECT,
        required: ['reason'],
        properties: {
          reason: { type: Type.STRING },
        },
      },
    }),
  },
};

export const promptSuggestionWithGoogleGenAI: SuggestionPromptFunction = async (
  input: SuggestionPromptRequest,
): Promise<SuggestionPromptResponse> => {
  const ai = new GoogleGenAI({ apiKey: input.apiKey });

  try {
    const response = await ai.models.generateContent({
      model: input.model,
      contents: input.prompt,
      config: {
        temperature: 0,
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
        responseSchema: GOOGLE_RESPONSE_SCHEMA,
        systemInstruction: SUGGESTION_SYSTEM_PROMPT,
      },
    });

    const text = response.text?.trim();
    if (!text) {
      return { error: 'No output generated.' };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return {
        error: `Invalid JSON output: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      return {
        advice: parseSuggestionOutput(raw),
        usage: usageFromNative(response.usageMetadata),
        rawResponse: toRecord(raw),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        rawResponse: toRecord(raw),
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

function usageFromNative(
  usage: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  } | undefined,
): SuggestionUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    totalTokens: usage.totalTokenCount
      ?? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0),
  };
}

function binaryStepSchema(payloads: {
  required: string[];
  yesPayload: Record<string, unknown>;
  noPayload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    type: Type.OBJECT,
    required: payloads.required,
    properties: {
      recommended: { type: Type.STRING, enum: ['yes', 'no'] },
      rankedChoices: {
        type: Type.ARRAY,
        minItems: 2,
        maxItems: 2,
        items: {
          type: Type.OBJECT,
          required: ['choice', 'rank', 'reason'],
          properties: {
            choice: { type: Type.STRING, enum: ['yes', 'no'] },
            rank: { type: Type.INTEGER, minimum: 1, maximum: 2 },
            reason: { type: Type.STRING },
          },
        },
      },
      yesPayload: payloads.yesPayload,
      noPayload: payloads.noPayload,
    },
  };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}
