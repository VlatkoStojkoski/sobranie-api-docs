import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  listSessions,
  loadProgress,
  saveProgress,
  updateStep,
  harPath,
  copyHarToSession,
  findDevProxyHar,
  samplesDir,
  decisionsPath,
  openApiDir,
} from '../src/cli/session.js';

const FIXTURE_HAR = 'test/fixtures/sample.har';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'session-test-'));
  const sessionsRoot = join(base, 'sessions-root');
  const originalSessionsDir = process.env.SOBRANIE_SESSIONS_DIR;
  process.env.SOBRANIE_SESSIONS_DIR = sessionsRoot;

  try {
    const first = await createSession();
    await delay(5);
    const second = await createSession();

    for (const dir of [first, second]) {
      for (const sub of ['har', 'samples', 'openapi']) {
        const subStat = await stat(join(dir, sub));
        assert.equal(subStat.isDirectory(), true, `${sub} directory should exist`);
      }

      const progress = await loadProgress(dir);
      assert.equal(progress.step, 'recording');
      assert.deepEqual(progress.undoStack, []);
    }

    const sessions = await listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]!.name > sessions[1]!.name, true, 'sessions should be sorted newest first');

    await updateStep(first, 'inferred');
    const updated = await loadProgress(first);
    assert.equal(updated.step, 'inferred');

    updated.undoStack = ['Status'];
    updated.nextPromptIndex = 3;
    await saveProgress(first, updated);
    const reloaded = await loadProgress(first);
    assert.deepEqual(reloaded.undoStack, ['Status']);
    assert.equal(reloaded.nextPromptIndex, 3);

    await copyHarToSession(FIXTURE_HAR, first);
    const copiedHar = await stat(harPath(first));
    assert.ok(copiedHar.size > 0);

    const oldHar = join(first, 'devproxy-old.har');
    const newHar = join(first, 'devproxy-new.har');
    await writeFile(oldHar, '{}', 'utf-8');
    await writeFile(newHar, '{}', 'utf-8');
    await utimes(oldHar, new Date(1_000), new Date(1_000));
    await utimes(newHar, new Date(2_000), new Date(2_000));
    assert.equal(await findDevProxyHar(first), newHar, 'findDevProxyHar should return latest devproxy*.har');

    assert.ok(samplesDir(first).endsWith('/samples'));
    assert.ok(decisionsPath(first).endsWith('/decisions.json'));
    assert.ok(openApiDir(first).endsWith('/openapi'));

    await writeFile(join(first, 'progress.json'), '{broken', 'utf-8');
    const fallback = await loadProgress(first);
    assert.equal(fallback.step, 'recording', 'invalid progress json should fallback to default');

    const missingFallback = await loadProgress(join(base, 'does-not-exist'));
    assert.equal(missingFallback.step, 'recording', 'missing progress should fallback to default');

    const progressRaw = await readFile(join(second, 'progress.json'), 'utf-8');
    assert.ok(progressRaw.includes('recording'));

    console.log('PASS test-session.ts');
  } finally {
    if (originalSessionsDir === undefined) {
      delete process.env.SOBRANIE_SESSIONS_DIR;
    } else {
      process.env.SOBRANIE_SESSIONS_DIR = originalSessionsDir;
    }
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
