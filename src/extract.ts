/**
 * Extract + Normalize: Parse HAR, filter to POST /Routing/MakePostRequest,
 * normalize keys to PascalCase, strip leading slash from method names,
 * group by MethodName.
 */

import { readFile } from 'node:fs/promises';
import type { HarFile, MethodCorpus, Sample } from './types.js';

const GATEWAY_PATTERN = /\/Routing\/MakePostRequest/i;

// ── PascalCase helpers ─────────────────────────────────────────────

function toPascalCase(key: string): string {
  if (!key.length) return key;
  const noSnake = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return noSnake.charAt(0).toUpperCase() + noSnake.slice(1);
}

function keysToPascalCase(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(keysToPascalCase);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[toPascalCase(k)] = keysToPascalCase(v);
    }
    return out;
  }
  return value;
}

function normalizeMethodName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

// ── Extract + normalize ─────────────────────────────────────────────

export async function extractFromHar(harPath: string): Promise<MethodCorpus[]> {
  const raw = await readFile(harPath, 'utf-8');
  const har: HarFile = JSON.parse(raw);

  const grouped = new Map<string, Sample[]>();
  let counter = 0;

  for (const entry of har.log.entries) {
    if (entry.request.method !== 'POST') continue;
    if (!GATEWAY_PATTERN.test(entry.request.url)) continue;

    // ── Parse + normalize request body ──
    const reqText = entry.request.postData?.text;
    if (!reqText) continue;

    let reqRaw: Record<string, unknown>;
    try {
      reqRaw = JSON.parse(reqText);
    } catch {
      continue;
    }

    const reqBody = keysToPascalCase(reqRaw) as Record<string, unknown>;

    // ── Resolve MethodName (strip slash, PascalCase key) ──
    const methodKey = Object.keys(reqBody).find(
      (k) => k.toLowerCase() === 'methodname',
    );
    if (!methodKey || typeof reqBody[methodKey] !== 'string') continue;

    const methodName = normalizeMethodName(reqBody[methodKey] as string);

    // Ensure canonical key
    if (methodKey !== 'MethodName') {
      delete reqBody[methodKey];
    }
    reqBody['MethodName'] = methodName;

    // ── Parse + normalize response body ──
    let resText = entry.response.content?.text;
    if (!resText) continue;

    if (entry.response.content.encoding === 'base64') {
      resText = Buffer.from(resText, 'base64').toString('utf-8');
    }

    let resRaw: unknown;
    try {
      resRaw = JSON.parse(resText);
    } catch {
      continue;
    }

    const resBody = keysToPascalCase(resRaw);

    // ── Store sample ──
    const sample: Sample = {
      id: String(counter++),
      request: reqBody,
      response: resBody,
    };

    const existing = grouped.get(methodName);
    if (existing) {
      existing.push(sample);
    } else {
      grouped.set(methodName, [sample]);
    }
  }

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([methodName, samples]) => ({ methodName, samples }));
}
