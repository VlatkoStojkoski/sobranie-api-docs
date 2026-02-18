/**
 * Validation gate: every observed sample MUST validate against its method's schema.
 * Uses Ajv with a conversion layer from OpenAPI 3.0 to JSON Schema draft-07.
 *
 * Schemas may contain $ref to shared components. We build a bundled document
 * (schema + components in one) so Ajv can resolve refs. The OpenAPI output
 * stays unchanged; this is a translation step for validation only.
 *
 * The caller (CLI) is responsible for blocking emit when validation fails.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import type { MethodCorpus, MethodSchema, JsonSchema, ValidationFailureRecord, SharedComponents } from './types.js';
import { buildComponentSchemas } from './schema-transform.js';

// ── Bundle schema for Ajv (resolve $ref by embedding components) ───

/**
 * Build a single document with schema + components so Ajv can resolve $ref.
 * Used only for validation; does not modify the canonical OpenAPI output.
 */
function bundleForValidation(
  schema: JsonSchema,
  sharedComponents: Record<string, JsonSchema>,
): Record<string, unknown> {
  const base = toJsonSchemaDraft(schema) as Record<string, unknown>;
  if (Object.keys(sharedComponents).length === 0) return base;
  return {
    ...base,
    components: { schemas: Object.fromEntries(
      Object.entries(sharedComponents).map(([k, v]) => [k, toJsonSchemaDraft(v)]),
    ) },
  };
}

// ── OpenAPI 3.0 schema → JSON Schema draft-07 ──────────────────────

function toJsonSchemaDraft(schema: JsonSchema): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return (schema ?? {}) as Record<string, unknown>;

  const isNullable = schema['nullable'] === true;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'nullable' || key === 'discriminator') continue;

    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const props: Record<string, unknown> = {};
      for (const [pn, ps] of Object.entries(value as Record<string, JsonSchema>)) {
        props[pn] = toJsonSchemaDraft(ps);
      }
      result['properties'] = props;
      continue;
    }

    if (key === 'items' && typeof value === 'object' && value !== null) {
      result['items'] = toJsonSchemaDraft(value as JsonSchema);
      continue;
    }

    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      result['anyOf'] = (value as JsonSchema[]).map(toJsonSchemaDraft);
      continue;
    }

    if (key === 'additionalProperties' && typeof value === 'object' && value !== null) {
      result[key] = toJsonSchemaDraft(value as JsonSchema);
      continue;
    }

    if (key === 'definitions' && typeof value === 'object' && value !== null) {
      const defs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, JsonSchema>)) {
        defs[k] = toJsonSchemaDraft(v);
      }
      result.definitions = defs;
      continue;
    }

    // Keep $ref — resolved via bundleForValidation (components in same document)
    if (key === '$ref') {
      result[key] = value;
      continue;
    }

    result[key] = value;
  }

  if (isNullable) {
    if (Array.isArray(result['anyOf'])) {
      (result['anyOf'] as unknown[]).push({ type: 'null' });
    } else if (Array.isArray(result['oneOf'])) {
      const oneOf = result['oneOf'];
      delete result['oneOf'];
      return { anyOf: [{ oneOf }, { type: 'null' }] };
    } else {
      const base = { ...result };
      return { anyOf: [base, { type: 'null' }] };
    }
  }

  return result;
}

// ── Public types ────────────────────────────────────────────────────

export interface ValidationResult {
  methodName: string;
  totalSamples: number;
  requestFailures: { sampleId: string; errors: string[] }[];
  responseFailures: { sampleId: string; errors: string[] }[];
  pass: boolean;
}

export interface ValidationSummary {
  results: ValidationResult[];
  allPass: boolean;
  /** For persisting to progress.json */
  failureRecords: ValidationFailureRecord[];
}

// ── Validate ────────────────────────────────────────────────────────

export function validateSchemas(
  corpora: MethodCorpus[],
  schemas: MethodSchema[],
  sharedComponents?: SharedComponents,
): ValidationSummary {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schemaMap = new Map(schemas.map((s) => [s.methodName, s]));
  const componentSchemas = sharedComponents
    ? buildComponentSchemas(sharedComponents)
    : {};
  const results: ValidationResult[] = [];
  const failureRecords: ValidationFailureRecord[] = [];

  for (const corpus of corpora) {
    const schema = schemaMap.get(corpus.methodName);
    if (!schema) {
      results.push({
        methodName: corpus.methodName,
        totalSamples: corpus.samples.length,
        requestFailures: [],
        responseFailures: [],
        pass: false,
      });
      failureRecords.push({
        methodName: corpus.methodName,
        requestErrors: ['No schema found'],
        responseErrors: [],
      });
      continue;
    }

    let reqValidate: ValidateFunction;
    let resValidate: ValidateFunction;

    try {
      reqValidate = ajv.compile(
        bundleForValidation(schema.requestSchema, componentSchemas),
      );
    } catch (e) {
      results.push({
        methodName: corpus.methodName,
        totalSamples: corpus.samples.length,
        requestFailures: [{ sampleId: '*', errors: [String(e)] }],
        responseFailures: [],
        pass: false,
      });
      failureRecords.push({
        methodName: corpus.methodName,
        requestErrors: [String(e)],
        responseErrors: [],
      });
      continue;
    }

    try {
      resValidate = ajv.compile(
        bundleForValidation(schema.responseSchema, componentSchemas),
      );
    } catch (e) {
      results.push({
        methodName: corpus.methodName,
        totalSamples: corpus.samples.length,
        requestFailures: [],
        responseFailures: [{ sampleId: '*', errors: [String(e)] }],
        pass: false,
      });
      failureRecords.push({
        methodName: corpus.methodName,
        requestErrors: [],
        responseErrors: [String(e)],
      });
      continue;
    }

    const requestFailures: { sampleId: string; errors: string[] }[] = [];
    const responseFailures: { sampleId: string; errors: string[] }[] = [];

    for (const sample of corpus.samples) {
      if (!reqValidate(sample.request)) {
        requestFailures.push({
          sampleId: sample.id,
          errors: (reqValidate.errors ?? []).map(
            (e) => `${e.instancePath} ${e.message}`,
          ),
        });
      }

      if (!resValidate(sample.response)) {
        responseFailures.push({
          sampleId: sample.id,
          errors: (resValidate.errors ?? []).map(
            (e) => `${e.instancePath} ${e.message}`,
          ),
        });
      }
    }

    const pass = requestFailures.length === 0 && responseFailures.length === 0;

    results.push({
      methodName: corpus.methodName,
      totalSamples: corpus.samples.length,
      requestFailures,
      responseFailures,
      pass,
    });

    if (!pass) {
      failureRecords.push({
        methodName: corpus.methodName,
        requestErrors: requestFailures.slice(0, 5).flatMap((f) => f.errors.slice(0, 2)),
        responseErrors: responseFailures.slice(0, 5).flatMap((f) => f.errors.slice(0, 2)),
      });
    }
  }

  return {
    results,
    allPass: results.every((r) => r.pass),
    failureRecords,
  };
}
