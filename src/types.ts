// ── HAR types (subset we need) ──────────────────────────────────────

export interface HarFile {
  log: {
    entries: HarEntry[];
  };
}

export interface HarEntry {
  request: {
    method: string;
    url: string;
    postData?: {
      mimeType?: string;
      text?: string;
    };
  };
  response: {
    status: number;
    content: {
      mimeType?: string;
      text?: string;
      encoding?: string;
    };
  };
}

// ── Domain types ────────────────────────────────────────────────────

export interface Sample {
  id: string;
  request: Record<string, unknown>;
  response: unknown;
}

export interface MethodCorpus {
  methodName: string;
  samples: Sample[];
}

export interface MethodSchema {
  methodName: string;
  requestSchema: JsonSchema;
  responseSchema: JsonSchema;
}

// ── JSON Schema (OpenAPI 3.0 compatible subset) ─────────────────────

export interface JsonSchema {
  type?: string;
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  $ref?: string;
  [key: string]: unknown;
}

// ── Value Registry ──────────────────────────────────────────────────

export interface ValueEntry {
  values: Set<string | number | boolean>;
  counts: Map<string | number | boolean, number>;
}

/** keyName → aggregated values across all methods */
export type ValueRegistry = Map<string, ValueEntry>;

// ── Decisions ───────────────────────────────────────────────────────

export type FieldKind = 'enum' | 'fk' | 'scalar';

export interface FieldDecision {
  kind: FieldKind;
  /** Component name, e.g. "StatusTitleEnum" or "CommitteeIdRef" */
  componentId?: string;
  /** References an existing component by ID when user says "same as X" */
  matchesExisting?: string;
}

export interface Decisions {
  /** keyName → decision */
  fields: Record<string, FieldDecision>;
}

// ── Session ─────────────────────────────────────────────────────────

export type SessionStep =
  | 'recording'
  | 'extracted'
  | 'inferred'
  | 'collecting_values'
  | 'prompting'
  | 'transformed'
  | 'validation_failed'
  | 'validated'
  | 'emitted';

export interface SessionProgress {
  step: SessionStep;
  /** Index of next suspect to prompt (for resume in prompting step) */
  nextPromptIndex?: number;
  /** Validation failures from last run */
  validationFailures?: ValidationFailureRecord[];
  /** Stack of decision keys for undo */
  undoStack: string[];
}

export interface ValidationFailureRecord {
  methodName: string;
  requestErrors: string[];
  responseErrors: string[];
}

// ── Shared component registry (enums + FKs) ────────────────────────

export interface SharedComponent {
  kind: 'enum' | 'fk';
  /** The base type (string, integer, number) */
  baseType: string;
  /** For enums: the closed set of values; for FKs: empty */
  values: (string | number | boolean)[];
  /** Description for the component */
  description?: string;
}

/** componentId → component definition */
export type SharedComponents = Record<string, SharedComponent>;
