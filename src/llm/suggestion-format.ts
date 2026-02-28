import { z } from 'zod';

import type {
  SuggestionAdvice,
  SuggestionBinaryRank,
  SuggestionChoice,
  SuggestionRankedChoice,
} from './types.js';

export const SUGGESTION_SYSTEM_PROMPT = [
  'You are assisting a schema-discovery CLI.',
  'Return only the structured object.',
  'Distinguish API field scope from canonical Model.Field targets.',
  'Reason about two independent decisions: source-field and reference-field.',
  'source=yes means the API field belongs to current entity row and maps to Model.Field.',
  'reference=yes means the API field points to another model field (usually OtherModel.Id).',
  'Scalar is implied only when both decisions are "no".',
  'If both source and reference are yes, they must target different Model.Field values.',
  'Always provide yes/no payloads so the user can choose any path.',
  'Targets must be canonical Model.Field identifiers (e.g. Material.ResponsibleCommittee).',
  'Never output method/path targets like GetAllX.Items[].Field.',
  'Keep each reason concise and concrete.',
].join(' ');

const CHOICE_SCHEMA = z.enum(['yes', 'no']);
const RANK_SCHEMA = z.number().int().min(1).max(2);

const RANKED_CHOICE_SCHEMA = z.object({
  choice: CHOICE_SCHEMA,
  rank: RANK_SCHEMA,
  reason: z.string().min(1).max(140),
});

const FIELD_STEP_SCHEMA = z.object({
  recommended: CHOICE_SCHEMA,
  rankedChoices: z.array(RANKED_CHOICE_SCHEMA).min(2).max(2),
  yesPayload: z.object({
    fieldId: z.string().min(1).max(120),
    reason: z.string().min(1).max(140),
  }),
  noPayload: z.object({
    reason: z.string().min(1).max(140),
  }),
});

export const SUGGESTION_SCHEMA = z.object({
  overallReason: z.string().min(1).max(360),
  source: FIELD_STEP_SCHEMA,
  reference: FIELD_STEP_SCHEMA,
});

export type SuggestionSchemaOutput = z.infer<typeof SUGGESTION_SCHEMA>;

export function parseSuggestionOutput(output: unknown): SuggestionAdvice {
  return normalizeSuggestionOutput(SUGGESTION_SCHEMA.parse(output));
}

export function normalizeSuggestionOutput(output: SuggestionSchemaOutput): SuggestionAdvice {
  const normalized: SuggestionAdvice = {
    overallReason: nonEmpty(output.overallReason)
      ?? 'Recommendations are based on field name semantics and surrounding context.',
    source: {
      recommended: normalizeChoice(output.source.recommended),
      rankedChoices: normalizeRankedChoices(output.source.rankedChoices),
      yesPayload: {
        fieldId: normalizeModelFieldId(output.source.yesPayload.fieldId),
        reason: nonEmpty(output.source.yesPayload.reason)
          ?? 'Map this field into a canonical model field.',
      },
      noPayload: {
        reason: nonEmpty(output.source.noPayload.reason)
          ?? 'This field should not be modeled as a source field.',
      },
    },
    reference: {
      recommended: normalizeChoice(output.reference.recommended),
      rankedChoices: normalizeRankedChoices(output.reference.rankedChoices),
      yesPayload: {
        fieldId: normalizeModelFieldId(output.reference.yesPayload.fieldId),
        reason: nonEmpty(output.reference.yesPayload.reason)
          ?? 'Treat this field as a relationship reference.',
      },
      noPayload: {
        reason: nonEmpty(output.reference.noPayload.reason)
          ?? 'No relationship reference is needed.',
      },
    },
  };

  return sanitizeImpossibleSelfReference(normalized);
}

function normalizeRankedChoices(input: SuggestionSchemaOutput['source']['rankedChoices']): SuggestionRankedChoice[] {
  const seen = new Set<SuggestionChoice>();
  const seenRanks = new Set<number>();
  const out: SuggestionRankedChoice[] = [];

  for (const item of input) {
    const choice = normalizeChoice(item.choice);
    if (seen.has(choice)) continue;
    const rank = pickRank(seenRanks, asRank(item.rank));
    seen.add(choice);
    seenRanks.add(rank);
    out.push({
      choice,
      rank,
      reason: nonEmpty(item.reason) ?? 'Based on available context.',
    });
  }

  for (const fallback of ['yes', 'no'] as const) {
    if (seen.has(fallback)) continue;
    const rank = pickRank(seenRanks, fallback === 'yes' ? 1 : 2);
    seen.add(fallback);
    seenRanks.add(rank);
    out.push({
      choice: fallback,
      rank,
      reason: 'Backfilled option for completeness.',
    });
  }

  return out.sort((a, b) => a.rank - b.rank);
}

function normalizeChoice(choice: SuggestionChoice): SuggestionChoice {
  return choice === 'yes' ? 'yes' : 'no';
}

function asRank(value: number): SuggestionBinaryRank {
  if (value <= 1) return 1;
  return 2;
}

function pickRank(
  used: Set<number>,
  preferred: SuggestionBinaryRank,
): SuggestionBinaryRank {
  if (!used.has(preferred)) return preferred;
  return preferred === 1 ? 2 : 1;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeModelFieldId(value: string | undefined): string {
  if (!value) return 'Entity.Id';
  const trimmed = value.trim();
  if (trimmed.includes('[]') || trimmed.includes('::') || trimmed.includes('/')) {
    return 'Entity.Id';
  }
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0 || lastDot >= trimmed.length - 1) return 'Entity.Id';
  const model = trimmed.slice(0, lastDot).trim();
  const field = trimmed.slice(lastDot + 1).trim();
  if (!model || !field) return 'Entity.Id';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(model)) return 'Entity.Id';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return 'Entity.Id';
  return `${model}.${field}`;
}

function sanitizeImpossibleSelfReference(advice: SuggestionAdvice): SuggestionAdvice {
  if (advice.source.recommended !== 'yes' || advice.reference.recommended !== 'yes') {
    return advice;
  }

  if (advice.source.yesPayload.fieldId !== advice.reference.yesPayload.fieldId) {
    return advice;
  }

  const reason = 'Disabled: reference target cannot equal source target.';
  return {
    ...advice,
    overallReason: `${advice.overallReason} ${reason}`.trim(),
    reference: forceRecommendedChoice(advice.reference, 'no', reason),
  };
}

function forceRecommendedChoice(
  step: SuggestionAdvice['reference'],
  recommended: SuggestionChoice,
  reason: string,
): SuggestionAdvice['reference'] {
  const byChoice = new Map(step.rankedChoices.map((entry) => [entry.choice, entry.reason]));
  const yesReason = byChoice.get('yes') ?? step.yesPayload.reason;
  const noReason = recommended === 'no'
    ? reason
    : (byChoice.get('no') ?? step.noPayload.reason);

  const rankedChoices: SuggestionRankedChoice[] = recommended === 'yes'
    ? [
      { choice: 'yes', rank: 1, reason: yesReason },
      { choice: 'no', rank: 2, reason: noReason },
    ]
    : [
      { choice: 'no', rank: 1, reason: noReason },
      { choice: 'yes', rank: 2, reason: yesReason },
    ];

  return {
    ...step,
    recommended,
    rankedChoices,
    noPayload: {
      reason: noReason,
    },
  };
}
