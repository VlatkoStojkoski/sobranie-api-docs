import type { Decisions, FieldKind, SharedComponents } from '../types.js';
import type { Suspect } from '../value-registry.js';
import { findOverlappingComponents } from '../decisions.js';
import { parseScopedFieldKey } from '../scoped-field.js';
import type {
  SuggestionAdvice,
  SuggestionUsage,
} from './types.js';
import type {
  SuggestionPromptFunction,
  SuggestionPromptRequest,
} from './prompt-contract.js';
import { promptSuggestionWithGoogleGenAI } from './prompt-google-genai.js';
import { promptSuggestionWithVercel } from './prompt-vercel.js';
import { env } from '../env.js';

export interface SuggestionRequest {
  suspect: Suspect;
  components: SharedComponents;
  decisions: Decisions;
  suspects?: Suspect[];
}

export interface SuggestionResult {
  prompt: string;
  advice?: SuggestionAdvice;
  usage?: SuggestionUsage;
  latencyMs: number;
  error?: string;
  rawResponse?: Record<string, unknown>;
}

export interface SuggestionClient {
  readonly model: string;
  isReady(): { ok: true } | { ok: false; reason: string };
  suggest(input: SuggestionRequest): Promise<SuggestionResult>;
}

export type SuggestionPromptBackend = 'google_genai' | 'vercel';

interface GoogleSuggestionClientOptions {
  model: string;
  apiKey?: string;
  backend: SuggestionPromptBackend;
}

const PROMPT_BACKENDS: Record<SuggestionPromptBackend, SuggestionPromptFunction> = {
  google_genai: promptSuggestionWithGoogleGenAI,
  vercel: promptSuggestionWithVercel,
};

class GoogleSuggestionClient implements SuggestionClient {
  readonly model: string;
  readonly backend: SuggestionPromptBackend;

  private readonly apiKey?: string;
  private readonly promptSuggestion: SuggestionPromptFunction;

  constructor(options: GoogleSuggestionClientOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.backend = options.backend;
    this.promptSuggestion = PROMPT_BACKENDS[options.backend];
  }

  isReady(): { ok: true } | { ok: false; reason: string } {
    if (!this.apiKey) {
      return { ok: false, reason: 'Missing GOOGLE_GENERATIVE_AI_API_KEY' };
    }
    return { ok: true };
  }

  async suggest(input: SuggestionRequest): Promise<SuggestionResult> {
    const prompt = buildPrompt(input);
    const ready = this.isReady();
    if (!ready.ok) {
      return {
        prompt,
        latencyMs: 0,
        error: ready.reason,
      };
    }

    const startedAt = Date.now();

    try {
      const result = await this.promptSuggestion({
        apiKey: this.apiKey!,
        model: this.model,
        prompt,
      } satisfies SuggestionPromptRequest);

      return {
        prompt,
        advice: result.advice,
        usage: result.usage,
        latencyMs: Date.now() - startedAt,
        error: result.error,
        rawResponse: result.rawResponse,
      } satisfies SuggestionResult;
    } catch (error) {
      return {
        prompt,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export interface CreateSuggestionClientOptions {
  provider: 'google';
  model: string;
  backend?: SuggestionPromptBackend;
}

export function createSuggestionClient(
  options: CreateSuggestionClientOptions,
): SuggestionClient {
  switch (options.provider) {
    case 'google':
    default:
      return new GoogleSuggestionClient({
        model: options.model,
        apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
        backend: resolvePromptBackend(options.backend),
      });
  }
}

function resolvePromptBackend(
  requested?: SuggestionPromptBackend,
): SuggestionPromptBackend {
  if (requested) return requested;

  const envValue = env.SUGGESTIONS_PROMPT_BACKEND?.trim().toLowerCase();
  if (envValue === 'vercel') return 'vercel';
  if (envValue === 'google_genai' || envValue === 'google-genai') {
    return 'google_genai';
  }

  return 'google_genai';
}

function buildPrompt(input: SuggestionRequest): string {
  const { suspect, components, decisions } = input;
  const values = Array.from(suspect.entry.values).slice(0, 30);

  const siblingFields = buildSiblingFieldSnapshot(
    suspect,
    input.suspects ?? [],
  );

  const overlapping = findOverlappingComponents(components, values).slice(0, 10).map((m) => ({
    id: m.id,
    kind: m.component.kind,
    baseType: m.component.baseType,
    overlapCount: m.overlapCount,
    sampleValues: m.component.values.slice(0, 12),
  }));

  const decisionSummary = summarizeDecisionContext(decisions, suspect);

  const payload = {
    task: 'Produce suggestions for a source/reference field decision flow.',
    projectContext: {
      objective: [
        'Classify each API field using two independent steps:',
        '1) whether field maps to a canonical model field (source role)',
        '2) whether field references another model field (reference role)',
        'If both are "no", the field is scalar by definition (no extra modeling metadata).',
      ],
      roleDefinitions: {
        source: [
          'source=yes means this API field is itself a model field on the current entity.',
          'The source target is where this field should live in canonical schema.',
        ],
        reference: [
          'reference=yes means this API field points to another model field (relationship).',
          'Reference target should usually be a different model field than source target.',
        ],
      },
      roleExamples: [
        {
          field: 'TypeId on committee rows',
          source: 'yes -> Committee.TypeId',
          reference: 'yes -> Type.Id',
        },
        {
          field: 'Id on committee rows',
          source: 'yes -> Committee.Id',
          reference: 'no',
        },
        {
          field: 'Committees count in dashboard statistics',
          source: 'no',
          reference: 'no',
        },
      ],
      canonicalTargetFormat: 'Model.Field',
      canonicalTargetExamples: [
        'Material.ResponsibleCommittee',
        'Structure.Id',
        'Language.Id',
      ],
      invalidTargetExamples: [
        'GetAllMaterialsForPublicPortal.Items[].ResponsibleCommittee',
        'GetAllX::response::[]::Id',
      ],
      notes: [
        'A field may be both source and reference.',
        'If both are yes, source.yesPayload.fieldId and reference.yesPayload.fieldId must not be identical.',
        'For simple entity Id fields, reference is usually no unless relation evidence is explicit.',
        'Do not rely heavily on value-count statistics; use naming, path, and sibling semantics first.',
        'Use concise singular model names and PascalCase-like identifiers where possible.',
      ],
    },
    suspect: {
      decisionKey: suspect.decisionKey,
      methodName: suspect.methodName,
      direction: suspect.direction,
      parentPath: suspect.parentPath,
      keyName: suspect.keyName,
      primitiveTypes: inferPrimitiveTypes(suspect.entry.values),
      valuePreview: values,
    },
    siblingFields,
    existingModelFields: overlapping.map((entry) => ({
      fieldId: entry.id,
      baseType: entry.baseType,
      overlapCount: entry.overlapCount,
      sampleValues: entry.sampleValues,
    })),
    decisionExamples: decisionSummary,
    namingHints: {
      suggestedModel: suggestModelName(suspect.keyName),
      suggestedField: suggestSimpleFieldName(suspect.keyName),
    },
    outputRequirements: {
      overallReason: 'single short sentence',
      guidance: [
        'Return source/reference sections with yes/no ranked choices and recommended choice for each.',
        'Ranks must be 1..2 with unique ranks and include both yes and no.',
        'Include payloads for both yes and no routes so UI can use suggestions regardless of user path.',
        'For source.yesPayload.fieldId and reference.yesPayload.fieldId, output canonical Model.Field only.',
        'Source and reference targets must represent different roles; do not reuse the exact same fieldId for both.',
        'Never output method/path-based targets.',
        'Keep each reason under 120 characters.',
      ],
    },
  };

  return JSON.stringify(payload, null, 2);
}

function buildSiblingFieldSnapshot(
  suspect: Suspect,
  suspects: Suspect[],
): Array<{
  keyName: string;
  uniqueCount: number;
  primitiveTypes: string[];
  sampleValues: Array<string | number | boolean>;
}> {
  return suspects
    .filter((candidate) => (
      candidate.methodName === suspect.methodName
      && candidate.direction === suspect.direction
      && candidate.parentPath === suspect.parentPath
      && candidate.keyName !== suspect.keyName
    ))
    .sort((a, b) => a.keyName.localeCompare(b.keyName))
    .slice(0, 16)
    .map((candidate) => ({
      keyName: candidate.keyName,
      uniqueCount: candidate.entry.values.size,
      primitiveTypes: inferPrimitiveTypes(candidate.entry.values),
      sampleValues: Array.from(candidate.entry.values).slice(0, 6),
    }));
}

function inferPrimitiveTypes(values: Set<string | number | boolean>): string[] {
  let hasString = false;
  let hasNumber = false;
  let hasInteger = true;
  let hasBoolean = false;
  for (const value of values) {
    if (typeof value === 'string') hasString = true;
    if (typeof value === 'boolean') hasBoolean = true;
    if (typeof value === 'number') {
      hasNumber = true;
      if (!Number.isInteger(value)) hasInteger = false;
    }
  }
  const out: string[] = [];
  if (hasString) out.push('string');
  if (hasNumber) out.push(hasInteger ? 'integer' : 'number');
  if (hasBoolean) out.push('boolean');
  return out;
}

interface ParsedDecisionEntry {
  decisionKey: string;
  methodName: string;
  direction: 'request' | 'response';
  parentPath: string;
  keyName: string;
  kind: FieldKind;
  sourceFieldId?: string;
  referenceFieldId?: string;
}

function summarizeDecisionContext(
  decisions: Decisions,
  suspect: Suspect,
): {
  recentForSameKey: string[];
  recentForSameSuffix: string[];
} {
  const entries = parsedDecisionEntries(decisions);
  const sameKeyName = entries
    .filter((entry) => entry.keyName === suspect.keyName)
    .slice(0, 8);
  const suffix = detectKeySuffix(suspect.keyName);
  const suffixEntries = suffix
    ? entries.filter((entry) => entry.keyName.endsWith(suffix)).slice(0, 8)
    : [];

  return {
    recentForSameKey: sameKeyName.map(formatDecisionExample),
    recentForSameSuffix: suffixEntries.map(formatDecisionExample),
  };
}

function parsedDecisionEntries(decisions: Decisions): ParsedDecisionEntry[] {
  const entries: ParsedDecisionEntry[] = [];
  for (const [decisionKey, decision] of Object.entries(decisions.fields)) {
    const parsed = parseScopedFieldKey(decisionKey);
    if (!parsed) continue;
    entries.push({
      decisionKey,
      methodName: parsed.methodName,
      direction: parsed.direction,
      parentPath: parsed.parentPath,
      keyName: parsed.keyName,
      kind: decision.kind,
      sourceFieldId: decision.sourceFieldId,
      referenceFieldId: decision.referenceFieldId,
    });
  }
  return entries;
}

function formatDecisionExample(entry: ParsedDecisionEntry): string {
  const refs: string[] = [];
  if (entry.sourceFieldId) refs.push(`source=${entry.sourceFieldId}`);
  if (entry.referenceFieldId) refs.push(`reference=${entry.referenceFieldId}`);
  return `${entry.methodName} [${entry.direction}] ${entry.parentPath}.${entry.keyName} => ${entry.kind}${refs.length > 0 ? ` (${refs.join(', ')})` : ''}`;
}

function detectKeySuffix(keyName: string): string | undefined {
  const suffixes = ['TypeId', 'TypeTitle', 'Id', 'Title', 'Name', 'Code'];
  return suffixes.find((suffix) => keyName.endsWith(suffix));
}

function suggestSimpleFieldName(keyName: string): string {
  const bySuffix = (suffix: string): string | null => {
    if (!keyName.endsWith(suffix) || keyName.length <= suffix.length) return null;
    return keyName.slice(0, -suffix.length);
  };
  return bySuffix('Id')
    ?? bySuffix('Title')
    ?? bySuffix('Name')
    ?? keyName;
}

function suggestModelName(keyName: string): string {
  const parsed = suggestSimpleFieldName(keyName);
  if (parsed === keyName) return keyName;
  return parsed;
}
