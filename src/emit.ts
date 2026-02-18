/**
 * Emit multi-file OpenAPI 3.0 spec.
 *
 * Layout:
 *   openapi.yaml                        — root (info, servers, path $refs, component $refs)
 *   paths/<Method>.yaml                 — one per method
 *   schemas/<Method>/Request.yaml       — request schema
 *   schemas/<Method>/Response.yaml      — response schema
 *   schemas/shared/<ComponentId>.yaml   — shared enums and FK refs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { MethodSchema, JsonSchema, SharedComponents } from './types.js';
import { buildComponentSchemas } from './schema-transform.js';

function safeName(method: string): string {
  return method.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function dumpYaml(obj: unknown): string {
  return yaml.dump(obj, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

// ── Emit multi-file ─────────────────────────────────────────────────

export async function emitOpenApi(
  schemas: MethodSchema[],
  sharedComponents: SharedComponents,
  outputDir: string,
): Promise<{ rootPath: string; fileCount: number }> {
  const pathsDir = join(outputDir, 'paths');
  const schemasDir = join(outputDir, 'schemas');
  const sharedDir = join(schemasDir, 'shared');

  await mkdir(pathsDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  let fileCount = 0;

  // ── Shared component schemas ──
  const sharedSchemas = buildComponentSchemas(sharedComponents);
  for (const [id, schema] of Object.entries(sharedSchemas)) {
    await writeFile(join(sharedDir, `${id}.yaml`), dumpYaml(schema), 'utf-8');
    fileCount++;
  }

  // ── Per-method files ──
  const pathRefs: Record<string, unknown> = {};
  const componentRefs: Record<string, unknown> = {};

  for (const method of schemas) {
    const name = safeName(method.methodName);
    const methodSchemaDir = join(schemasDir, name);
    await mkdir(methodSchemaDir, { recursive: true });

    // Write request schema
    await writeFile(
      join(methodSchemaDir, 'Request.yaml'),
      dumpYaml(method.requestSchema),
      'utf-8',
    );
    fileCount++;

    // Write response schema
    await writeFile(
      join(methodSchemaDir, 'Response.yaml'),
      dumpYaml(method.responseSchema),
      'utf-8',
    );
    fileCount++;

    // Write path operation
    const pathOp = {
      post: {
        operationId: name,
        summary: `RPC: ${method.methodName}`,
        tags: ['rpc'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `../schemas/${name}/Request.yaml` },
            },
          },
        },
        responses: {
          '200': {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: { $ref: `../schemas/${name}/Response.yaml` },
              },
            },
          },
        },
      },
    };

    await writeFile(join(pathsDir, `${name}.yaml`), dumpYaml(pathOp), 'utf-8');
    fileCount++;

    // Root refs
    pathRefs[`/rpc/${name}`] = { $ref: `paths/${name}.yaml` };
    componentRefs[`${name}Request`] = { $ref: `schemas/${name}/Request.yaml` };
    componentRefs[`${name}Response`] = { $ref: `schemas/${name}/Response.yaml` };
  }

  // Add shared component refs to root
  for (const id of Object.keys(sharedSchemas)) {
    componentRefs[id] = { $ref: `schemas/shared/${id}.yaml` };
  }

  // ── Root document ──
  const root = {
    openapi: '3.0.3',
    info: {
      title: 'Sobranie.mk RPC API',
      version: '0.1.0',
      description:
        'Auto-generated OpenAPI spec from HAR traffic. ' +
        'Each path is a logical RPC method multiplexed through ' +
        'POST /Routing/MakePostRequest on the real server.',
    },
    servers: [
      {
        url: 'https://www.sobranie.mk',
        description: 'Production',
      },
    ],
    paths: pathRefs,
    components: {
      schemas: componentRefs,
    },
  };

  const rootPath = join(outputDir, 'openapi.yaml');
  await writeFile(rootPath, dumpYaml(root), 'utf-8');
  fileCount++;

  // Also emit a bundled single-file JSON for convenience
  const bundledDoc = buildBundledDocument(schemas, sharedComponents);
  const jsonPath = join(outputDir, 'openapi.bundled.json');
  await writeFile(jsonPath, JSON.stringify(bundledDoc, null, 2), 'utf-8');
  fileCount++;

  return { rootPath, fileCount };
}

// ── Bundled single-file (for tools that need it) ────────────────────

function buildBundledDocument(
  schemas: MethodSchema[],
  sharedComponents: SharedComponents,
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const componentSchemas: Record<string, JsonSchema> = {};

  for (const method of schemas) {
    const name = safeName(method.methodName);

    componentSchemas[`${name}Request`] = method.requestSchema;
    componentSchemas[`${name}Response`] = method.responseSchema;

    paths[`/rpc/${name}`] = {
      post: {
        operationId: name,
        summary: `RPC: ${method.methodName}`,
        tags: ['rpc'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${name}Request` },
            },
          },
        },
        responses: {
          '200': {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${name}Response` },
              },
            },
          },
        },
      },
    };
  }

  // Add shared components
  const shared = buildComponentSchemas(sharedComponents);
  for (const [id, schema] of Object.entries(shared)) {
    componentSchemas[id] = schema;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Sobranie.mk RPC API',
      version: '0.1.0',
      description:
        'Auto-generated OpenAPI spec from HAR traffic (bundled). ' +
        'Each path is a logical RPC method multiplexed through ' +
        'POST /Routing/MakePostRequest on the real server.',
    },
    servers: [
      {
        url: 'https://www.sobranie.mk',
        description: 'Production',
      },
    ],
    paths,
    components: { schemas: componentSchemas },
  };
}
