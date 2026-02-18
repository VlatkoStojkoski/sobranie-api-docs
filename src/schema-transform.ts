/**
 * Schema Transform: apply user decisions to quicktype-inferred schemas.
 *
 * For each property in each method schema, apply scoped user decisions:
 * - enum/fk/foreign_value => reference shared component + x-relationship metadata
 * - index_source/value_source => keep inline schema + source metadata
 */

import type {
  MethodSchema,
  JsonSchema,
  Decisions,
  SharedComponents,
  ScopeDirection,
} from './types.js';
import { decisionLookupKeys } from './scoped-field.js';

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
    requestSchema: transformSchema(
      method.requestSchema,
      decisions,
      components,
      method.methodName,
      'request',
      '$',
    ),
    responseSchema: transformSchema(
      method.responseSchema,
      decisions,
      components,
      method.methodName,
      'response',
      '$',
    ),
  }));
}

function transformSchema(
  schema: JsonSchema,
  decisions: Decisions,
  components: SharedComponents,
  methodName: string,
  direction: ScopeDirection,
  parentPath: string,
): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;

  const result: JsonSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      result.properties = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, JsonSchema>)) {
        const decision = decisionLookupKeys(methodName, direction, parentPath, propName)
          .map((decisionKey) => decisions.fields[decisionKey])
          .find(Boolean);
        if (decision) {
          const fieldId = decision.matchesExisting ?? decision.componentId;
          if (
            fieldId &&
            (decision.kind === 'index_source' || decision.kind === 'value_source')
          ) {
            const transformed = transformSchema(
              propSchema,
              decisions,
              components,
              methodName,
              direction,
              appendObjectPath(parentPath, propName),
            );
            result.properties[propName] = addSourceMetadata(transformed, fieldId);
            continue;
          }

          if (
            fieldId &&
            (decision.kind === 'enum' || decision.kind === 'fk' || decision.kind === 'foreign_value') &&
            fieldId in components
          ) {
            const ref: JsonSchema = { $ref: `#/components/schemas/${fieldId}` };

            // Preserve nullable from the original schema
            const isNullable = propSchema.nullable === true ||
              (propSchema.anyOf?.some((s) => s.type === 'null')) ||
              false;

            if (isNullable) {
              result.properties[propName] = {
                anyOf: [ref, { type: 'null' as const }],
                nullable: true,
                'x-relationship': {
                  role: decision.kind,
                  field: fieldId,
                },
              };
            } else {
              result.properties[propName] = {
                ...ref,
                'x-relationship': {
                  role: decision.kind,
                  field: fieldId,
                },
              };
            }
            continue;
          }

          if (
            fieldId &&
            (decision.kind === 'fk' || decision.kind === 'foreign_value')
          ) {
            const transformed = transformSchema(
              propSchema,
              decisions,
              components,
              methodName,
              direction,
              appendObjectPath(parentPath, propName),
            );
            result.properties[propName] = {
              ...transformed,
              'x-relationship': {
                role: decision.kind,
                field: fieldId,
              },
            };
            continue;
          }
        }
        // Recurse into non-decided properties
        result.properties[propName] = transformSchema(
          propSchema,
          decisions,
          components,
          methodName,
          direction,
          appendObjectPath(parentPath, propName),
        );
      }
      continue;
    }

    if (key === 'items' && typeof value === 'object' && value !== null) {
      result.items = transformSchema(
        value as JsonSchema,
        decisions,
        components,
        methodName,
        direction,
        appendArrayPath(parentPath),
      );
      continue;
    }

    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      result[key] = (value as JsonSchema[]).map((s) =>
        transformSchema(s, decisions, components, methodName, direction, parentPath),
      );
      continue;
    }

    if (key === 'additionalProperties' && typeof value === 'object' && value !== null) {
      result[key] = transformSchema(
        value as JsonSchema,
        decisions,
        components,
        methodName,
        direction,
        parentPath,
      );
      continue;
    }

    if (key === 'definitions' && typeof value === 'object' && value !== null) {
      const defs: Record<string, JsonSchema> = {};
      for (const [k, v] of Object.entries(value as Record<string, JsonSchema>)) {
        defs[k] = transformSchema(v, decisions, components, methodName, direction, parentPath);
      }
      result.definitions = defs;
      continue;
    }

    result[key] = value;
  }

  return result;
}

function appendObjectPath(parentPath: string, key: string): string {
  if (parentPath === '$') return key;
  if (parentPath === '[]') return `${parentPath}.${key}`;
  return `${parentPath}.${key}`;
}

function appendArrayPath(parentPath: string): string {
  if (parentPath === '$') return '[]';
  return `${parentPath}[]`;
}

function addSourceMetadata(schema: JsonSchema, fieldId: string): JsonSchema {
  return {
    ...schema,
    'x-relationship': {
      role: 'source',
      field: fieldId,
    },
    'x-model-source': {
      role: 'source',
      field: fieldId,
    },
  };
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
    const resolvedTypes = resolveComponentTypes(comp);
    if (comp.kind === 'enum') {
      schemas[id] = {
        ...(resolvedTypes.length === 1 ? { type: resolvedTypes[0]! } : {}),
        enum: comp.values,
        description: comp.description ?? `Enum: ${id}`,
      };
    } else {
      const fallbackDescription = comp.kind === 'foreign_value'
        ? `Foreign value: ${id}`
        : `Reference: ${id}`;
      if (resolvedTypes.length === 1) {
        schemas[id] = {
          type: resolvedTypes[0]!,
          description: comp.description ?? fallbackDescription,
        };
      } else if (resolvedTypes.length > 1) {
        schemas[id] = {
          oneOf: resolvedTypes.map((t) => ({ type: t })),
          description: comp.description ?? fallbackDescription,
        };
      } else {
        schemas[id] = {
          description: comp.description ?? fallbackDescription,
        };
      }
    }
  }

  return schemas;
}

function resolveComponentTypes(component: {
  baseType: string;
  baseTypes?: string[];
  values: (string | number | boolean)[];
}): string[] {
  if (component.baseTypes && component.baseTypes.length > 0) {
    return Array.from(new Set(component.baseTypes));
  }

  if (component.baseType !== 'mixed') {
    return [component.baseType];
  }

  let hasString = false;
  let hasNumber = false;
  let hasInteger = true;
  let hasBoolean = false;
  for (const v of component.values) {
    if (typeof v === 'string') hasString = true;
    if (typeof v === 'boolean') hasBoolean = true;
    if (typeof v === 'number') {
      hasNumber = true;
      if (!Number.isInteger(v)) hasInteger = false;
    }
  }

  const out: string[] = [];
  if (hasString) out.push('string');
  if (hasNumber) out.push(hasInteger ? 'integer' : 'number');
  if (hasBoolean) out.push('boolean');
  return out;
}
