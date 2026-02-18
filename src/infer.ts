/**
 * Schema inference using quicktype-core.
 *
 * Feeds all request/response samples per method into quicktype,
 * which infers a merged JSON Schema, then converts to OpenAPI 3.0.
 */

import {
  quicktype,
  InputData,
  jsonInputForTargetLanguage,
} from 'quicktype-core';
import type { MethodCorpus, MethodSchema, JsonSchema } from './types.js';

// ── quicktype → JSON Schema ─────────────────────────────────────────

async function samplesToSchema(
  typeName: string,
  samples: unknown[],
): Promise<JsonSchema> {
  if (samples.length === 0) return { type: 'object' };

  const jsonInput = jsonInputForTargetLanguage('schema');
  await jsonInput.addSource({
    name: typeName,
    samples: samples.map((s) => JSON.stringify(s)),
  });

  const inputData = new InputData();
  inputData.addInput(jsonInput);

  const result = await quicktype({
    inputData,
    lang: 'schema',
    rendererOptions: {},
  });

  const schemaText = result.lines.join('\n');
  const rawSchema = JSON.parse(schemaText);

  const { schema, definitions: auxDefs } = inlineRefs(rawSchema, rawSchema.definitions ?? {});
  const s = toOpenApi30(schema);
  // Merge auxiliary definitions (cyclic refs) into schema for valid self-references
  if (auxDefs && Object.keys(auxDefs).length > 0) {
    (s as Record<string, unknown>).definitions = Object.fromEntries(
      Object.entries(auxDefs).map(([k, v]) => [k, toOpenApi30(v)]),
    );
  }
  return s;
}

interface InlineResult {
  schema: JsonSchema;
  definitions: Record<string, JsonSchema>;
}

// ── Inline $ref / definitions (keep self-references) ─────────────────

function inlineRefs(
  schema: Record<string, unknown>,
  definitions: Record<string, unknown>,
  resolving: Set<string> = new Set(),
): InlineResult {
  if (!schema || typeof schema !== 'object') {
    return { schema: schema as JsonSchema, definitions: {} };
  }

  if (typeof schema['$ref'] === 'string' && definitions) {
    const refName = (schema['$ref'] as string).replace('#/definitions/', '');
    if (resolving.has(refName)) {
      // Cyclic reference: keep $ref for valid self-reference in OpenAPI
      return { schema: { $ref: `#/definitions/${refName}` }, definitions: {} };
    }
    const resolved = definitions[refName];
    if (resolved && typeof resolved === 'object') {
      resolving.add(refName);
      const inner = inlineRefs(resolved as Record<string, unknown>, definitions, resolving);
      resolving.delete(refName);
      return {
        schema: inner.schema,
        definitions: { [refName]: inner.schema as JsonSchema, ...inner.definitions },
      };
    }
  }

  const result: Record<string, unknown> = {};
  let mergedDefs: Record<string, JsonSchema> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'definitions' || key === '$schema' || key === '$id' || key === '$comment') continue;

    if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'object' && item !== null) {
          const inner = inlineRefs(item as Record<string, unknown>, definitions, resolving);
          Object.assign(mergedDefs, inner.definitions);
          return inner.schema;
        }
        return item;
      });
    } else if (typeof value === 'object' && value !== null) {
      const inner = inlineRefs(value as Record<string, unknown>, definitions, resolving);
      result[key] = inner.schema;
      Object.assign(mergedDefs, inner.definitions);
    } else {
      result[key] = value;
    }
  }

  return { schema: result as JsonSchema, definitions: mergedDefs };
}

// ── JSON Schema → OpenAPI 3.0 compat ────────────────────────────────

function toOpenApi30(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;

  const result: JsonSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    if (['$schema', '$id', 'definitions', '$comment'].includes(key)) continue;

    if (key === 'type' && Array.isArray(value)) {
      const types = (value as string[]).filter((t) => t !== 'null');
      const hasNull = (value as string[]).includes('null');
      if (types.length === 1) {
        result.type = types[0];
        if (hasNull) result.nullable = true;
      } else if (types.length > 1) {
        result.anyOf = types.map((t) => ({ type: t }));
        if (hasNull) result.nullable = true;
      }
      continue;
    }

    if (key === 'properties' && typeof value === 'object' && value !== null) {
      result.properties = {};
      for (const [pn, ps] of Object.entries(value as Record<string, JsonSchema>)) {
        result.properties[pn] = toOpenApi30(ps);
      }
      continue;
    }
    if (key === 'items' && typeof value === 'object' && value !== null) {
      result.items = toOpenApi30(value as JsonSchema);
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      result[key] = (value as JsonSchema[]).map(toOpenApi30);
      continue;
    }

    result[key] = value;
  }

  return result;
}

// ── Public API ──────────────────────────────────────────────────────

export async function inferSchemas(
  corpora: MethodCorpus[],
): Promise<MethodSchema[]> {
  const results: MethodSchema[] = [];

  for (const corpus of corpora) {
    console.log(
      `  [quicktype] ${corpus.methodName} (${corpus.samples.length} samples)`,
    );

    const requestSchema = await samplesToSchema(
      `${corpus.methodName}Request`,
      corpus.samples.map((s) => s.request),
    );

    const responseSchema = await samplesToSchema(
      `${corpus.methodName}Response`,
      corpus.samples.map((s) => s.response),
    );

    results.push({
      methodName: corpus.methodName,
      requestSchema,
      responseSchema,
    });
  }

  return results;
}
