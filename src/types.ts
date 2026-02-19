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
  methodName: string;
  direction: ScopeDirection;
  parentPath: string;
  keyName: string;
  values: Set<string | number | boolean>;
  counts: Map<string | number | boolean, number>;
}

/** decisionKey (method::request|response::parentPath::field) -> aggregated values within that scope */
export type ValueRegistry = Map<string, ValueEntry>;

export type ScopeDirection = 'request' | 'response';

// ── Decisions ───────────────────────────────────────────────────────

export type FieldKind =
  | 'scalar'
  | 'source'
  | 'reference'
  | 'source_reference';

export interface FieldDecision {
  kind: FieldKind;
  /** Canonical model field id where this field is modeled, e.g. "Material.Title" */
  sourceFieldId?: string;
  /** Canonical target model field this field references, e.g. "Structure.Id" */
  referenceFieldId?: string;
  /** Structured source model reference (optional convenience metadata) */
  modelName?: string;
  /** Structured source field reference (optional convenience metadata) */
  fieldName?: string;
  /** Structured reference model reference (optional convenience metadata) */
  referenceModelName?: string;
  /** Structured reference field reference (optional convenience metadata) */
  referenceFieldName?: string;
}

export interface Decisions {
  /** decisionKey → decision (scoped key preferred: method::request|response::parentPath::fieldName) */
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
  /** Relationship warnings from the last run */
  relationshipWarnings?: string[];
  /** Stack of decision keys for undo */
  undoStack: string[];
}

export interface ValidationFailureRecord {
  methodName: string;
  requestErrors: string[];
  responseErrors: string[];
}

// ── Shared model field registry ─────────────────────────────────────

export interface SharedComponent {
  kind: 'field';
  /** The base type (string, integer, number, boolean, mixed) */
  baseType: string;
  /** Optional explicit base types (used when baseType is mixed) */
  baseTypes?: string[];
  /** Observed values for this modeled field (optional signal for overlap/type inference) */
  values: (string | number | boolean)[];
  /** Description for the component */
  description?: string;
}

/** componentId → component definition */
export type SharedComponents = Record<string, SharedComponent>;
