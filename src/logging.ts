import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function appendJsonLine(path: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(event) + '\n', 'utf-8');
}

export function timestampedEvent(
  event: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    event,
    ...payload,
  };
}
