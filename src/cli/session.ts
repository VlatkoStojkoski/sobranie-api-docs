/**
 * Session management: create, list, load, save sessions.
 * Each session is a timestamped folder under sessions/.
 */

import { mkdir, readdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SessionProgress, SessionStep } from '../types.js';

const SESSIONS_DIR = 'sessions';
const DEVPROXY_CONFIG = 'devproxyrc.json';

// ── Create ──────────────────────────────────────────────────────────

export async function createSession(): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionDir = resolve(SESSIONS_DIR, timestamp);

  await mkdir(join(sessionDir, 'har'), { recursive: true });
  await mkdir(join(sessionDir, 'samples'), { recursive: true });
  await mkdir(join(sessionDir, 'openapi'), { recursive: true });

  // Copy devproxyrc.json so Dev Proxy can run from the session directory
  try {
    await copyFile(resolve(DEVPROXY_CONFIG), join(sessionDir, DEVPROXY_CONFIG));
  } catch {
    // Config may not exist; Dev Proxy will use defaults
  }

  const progress: SessionProgress = {
    step: 'recording',
    undoStack: [],
  };
  await saveProgress(sessionDir, progress);

  return sessionDir;
}

// ── List ────────────────────────────────────────────────────────────

export interface SessionInfo {
  name: string;
  path: string;
  step: SessionStep;
}

export async function listSessions(): Promise<SessionInfo[]> {
  try {
    const entries = await readdir(SESSIONS_DIR);
    const sessions: SessionInfo[] = [];

    for (const name of entries) {
      const sessionDir = resolve(SESSIONS_DIR, name);
      try {
        const s = await stat(sessionDir);
        if (!s.isDirectory()) continue;
        const progress = await loadProgress(sessionDir);
        sessions.push({ name, path: sessionDir, step: progress.step });
      } catch {
        continue;
      }
    }

    return sessions.sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

// ── Progress ────────────────────────────────────────────────────────

export async function loadProgress(sessionDir: string): Promise<SessionProgress> {
  try {
    const raw = await readFile(join(sessionDir, 'progress.json'), 'utf-8');
    return JSON.parse(raw) as SessionProgress;
  } catch {
    return { step: 'recording', undoStack: [] };
  }
}

export async function saveProgress(
  sessionDir: string,
  progress: SessionProgress,
): Promise<void> {
  await writeFile(
    join(sessionDir, 'progress.json'),
    JSON.stringify(progress, null, 2),
    'utf-8',
  );
}

export async function updateStep(
  sessionDir: string,
  step: SessionStep,
): Promise<SessionProgress> {
  const progress = await loadProgress(sessionDir);
  progress.step = step;
  await saveProgress(sessionDir, progress);
  return progress;
}

// ── HAR ─────────────────────────────────────────────────────────────

export function harPath(sessionDir: string): string {
  return join(sessionDir, 'har', 'input.har');
}

export async function copyHarToSession(
  sourcePath: string,
  sessionDir: string,
): Promise<void> {
  await copyFile(sourcePath, harPath(sessionDir));
}

/**
 * Find the latest devproxy-*.har file in the session directory.
 */
export async function findDevProxyHar(sessionDir: string): Promise<string | null> {
  try {
    const files = await readdir(sessionDir);
    const harFiles = files
      .filter((f) => f.startsWith('devproxy') && f.endsWith('.har'));

    if (harFiles.length === 0) return null;

    const withStats = await Promise.all(
      harFiles.map(async (f) => {
        const p = join(sessionDir, f);
        const s = await stat(p);
        return { path: p, mtime: s.mtimeMs };
      }),
    );
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats[0]!.path;
  } catch {
    return null;
  }
}

// ── Samples ─────────────────────────────────────────────────────────

export function samplesDir(sessionDir: string): string {
  return join(sessionDir, 'samples');
}

export function decisionsPath(sessionDir: string): string {
  return join(sessionDir, 'decisions.json');
}

export function openApiDir(sessionDir: string): string {
  return join(sessionDir, 'openapi');
}
