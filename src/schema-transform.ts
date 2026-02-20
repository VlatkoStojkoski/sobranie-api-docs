/**
 * Schema Transform: apply user decisions to quicktype-inferred schemas.
 *
 * For each property in each method schema, apply scoped user decisions:
 * - scalar => keep inline schema as inferred.
 * - source => annotate field as modeled source field (Model.Field).
 * - reference => annotate field as relationship reference (Model.Field).
 * - source_reference => annotate both roles.
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

        if (!decision || decision.kind === 'scalar') {
          result.properties[propName] = transformSchema(
            propSchema,
            decisions,
            components,
            methodName,
            direction,
            appendObjectPath(parentPath, propName),
          );
          continue;
        }

        const transformed = transformSchema(
          propSchema,
          decisions,
          components,
          methodName,
          direction,
          appendObjectPath(parentPath, propName),
        );

        const sourceFieldId = decision.sourceFieldId;
        const referenceFieldId = decision.referenceFieldId;
        const sourceRef = sourceFieldId && (sourceFieldId in components)
          ? buildRefSchema(propSchema, sourceFieldId)
          : transformed;

        result.properties[propName] = withRoleMetadata(
          sourceRef,
          sourceFieldId,
          referenceFieldId,
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
      for (const [defKey, defValue] of Object.entries(value as Record<string, JsonSchema>)) {
        defs[defKey] = transformSchema(defValue, decisions, components, methodName, direction, parentPath);
      }
      result.definitions = defs;
      continue;
    }

    result[key] = value;
  }

  return result;
}

function buildRefSchema(original: JsonSchema, fieldId: string): JsonSchema {
  const ref: JsonSchema = { $ref: `#/components/schemas/${fieldId}` };
  const isNullable = original.nullable === true
    || (original.anyOf?.some((s) => s.type === 'null') ?? false);

  if (!isNullable) return ref;

  return {
    anyOf: [ref, { type: 'null' as const }],
    nullable: true,
  };
}

function withRoleMetadata(
  schema: JsonSchema,
  sourceFieldId: string | undefined,
  referenceFieldId: string | undefined,
): JsonSchema {
  return {
    ...schema,
    ...(sourceFieldId
      ? {
        'x-model-source': {
          role: 'source',
          field: sourceFieldId,
        },
      }
      : {}),
    ...(referenceFieldId
      ? {
        'x-relationship': {
          role: 'reference',
          field: referenceFieldId,
        },
      }
      : {}),
  };
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

// ── Build component schemas for OpenAPI ─────────────────────────────

export function buildComponentSchemas(
  components: SharedComponents,
): Record<string, JsonSchema> {
  const schemas: Record<string, JsonSchema> = {};

  for (const [id, comp] of Object.entries(components)) {
    const resolvedTypes = resolveComponentTypes(comp);
    if (resolvedTypes.length === 1) {
      schemas[id] = {
        type: resolvedTypes[0]!,
        description: comp.description ?? `Model field: ${id}`,
      };
    } else if (resolvedTypes.length > 1) {
      schemas[id] = {
        oneOf: resolvedTypes.map((t) => ({ type: t })),
        description: comp.description ?? `Model field: ${id}`,
      };
    } else {
      schemas[id] = {
        description: comp.description ?? `Model field: ${id}`,
      };
    }
  }

  return schemas;
}

/**
 * Build object schemas for domain models by grouping shared field components
 * using "<Model>.<Field>" naming.
 */
export function buildModelSchemas(
  components: SharedComponents,
): Record<string, JsonSchema> {
  const fieldSchemas = buildComponentSchemas(components);
  const grouped = new Map<string, string[]>();

  for (const fieldId of Object.keys(fieldSchemas)) {
    const parsed = parseModelFieldId(fieldId);
    if (!parsed) continue;
    const existing = grouped.get(parsed.modelName) ?? [];
    existing.push(parsed.fieldName);
    grouped.set(parsed.modelName, existing);
  }

  const out: Record<string, JsonSchema> = {};
  for (const [modelName, fields] of grouped.entries()) {
    const properties: Record<string, JsonSchema> = {};
    for (const fieldName of fields.sort((a, b) => a.localeCompare(b))) {
      const fieldId = `${modelName}.${fieldName}`;
      const fieldSchema = fieldSchemas[fieldId];
      if (!fieldSchema) continue;
      properties[fieldName] = fieldSchema;
    }

    out[modelName] = {
      type: 'object',
      properties,
      description: `Model: ${modelName}`,
    };
  }

  return out;
}

function parseModelFieldId(value: string): { modelName: string; fieldName: string } | null {
  const lastDot = value.lastIndexOf('.');
  if (lastDot <= 0 || lastDot >= value.length - 1) return null;
  const modelName = value.slice(0, lastDot).trim();
  const fieldName = value.slice(lastDot + 1).trim();
  if (!modelName || !fieldName) return null;
  return { modelName, fieldName };
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

  const types: string[] = [];
  if (hasString) types.push('string');
  if (hasNumber) types.push(hasInteger ? 'integer' : 'number');
  if (hasBoolean) types.push('boolean');
  return types;
}
