/**
 * Schema Transform: apply user decisions to quicktype-inferred schemas.
 *
 * For each property in each method schema, if the user decided it's an
 * enum or FK, replace its inline schema with a $ref to the shared component.
 */

import type {
  MethodSchema,
  JsonSchema,
  Decisions,
  SharedComponents,
} from './types.js';

// ── Transform schemas using decisions ───────────────────────────────

/**
 * Walk all method schemas and replace properties matching a decision
 * with $ref to the corresponding shared component.
 * Returns new schema objects (does not mutate originals).
 */
export function transformSchemas(
  schemas: MethodSchema[],
  decisions: Decisions,
  components: SharedComponents,
): MethodSchema[] {
  return schemas.map((method) => ({
    methodName: method.methodName,
    requestSchema: transformSchema(method.requestSchema, decisions, components),
    responseSchema: transformSchema(method.responseSchema, decisions, components),
  }));
}

function transformSchema(
  schema: JsonSchema,
  decisions: Decisions,
  components: SharedComponents,
): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;

  const result: JsonSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      result.properties = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, JsonSchema>)) {
        const decision = decisions.fields[propName];
        if (decision && (decision.kind === 'enum' || decision.kind === 'fk')) {
          const componentId = decision.matchesExisting ?? decision.componentId;
          if (componentId && componentId in components) {
            const comp = components[componentId]!;
            const ref: JsonSchema = { $ref: `#/components/schemas/${componentId}` };

            // Preserve nullable from the original schema
            const isNullable = propSchema.nullable === true ||
              (propSchema.anyOf?.some((s) => s.type === 'null')) ||
              false;

            if (isNullable) {
              result.properties[propName] = {
                anyOf: [ref, { type: 'null' as const }],
                nullable: true,
              };
            } else {
              result.properties[propName] = ref;
            }
            continue;
          }
        }
        // Recurse into non-decided properties
        result.properties[propName] = transformSchema(propSchema, decisions, components);
      }
      continue;
    }

    if (key === 'items' && typeof value === 'object' && value !== null) {
      result.items = transformSchema(value as JsonSchema, decisions, components);
      continue;
    }

    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      result[key] = (value as JsonSchema[]).map((s) =>
        transformSchema(s, decisions, components),
      );
      continue;
    }

    if (key === 'additionalProperties' && typeof value === 'object' && value !== null) {
      result[key] = transformSchema(value as JsonSchema, decisions, components);
      continue;
    }

    if (key === 'definitions' && typeof value === 'object' && value !== null) {
      const defs: Record<string, JsonSchema> = {};
      for (const [k, v] of Object.entries(value as Record<string, JsonSchema>)) {
        defs[k] = transformSchema(v, decisions, components);
      }
      result.definitions = defs;
      continue;
    }

    result[key] = value;
  }

  return result;
}

// ── Build component schemas for OpenAPI ─────────────────────────────

/**
 * Convert SharedComponents into OpenAPI-compatible JsonSchema definitions.
 */
export function buildComponentSchemas(
  components: SharedComponents,
): Record<string, JsonSchema> {
  const schemas: Record<string, JsonSchema> = {};

  for (const [id, comp] of Object.entries(components)) {
    if (comp.kind === 'enum') {
      schemas[id] = {
        type: comp.baseType,
        enum: comp.values,
        description: comp.description ?? `Enum: ${id}`,
      };
    } else {
      schemas[id] = {
        type: comp.baseType,
        description: comp.description ?? `Reference: ${id}`,
      };
    }
  }

  return schemas;
}
