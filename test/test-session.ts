/**
 * Test CLI session management: create, list, progress, HAR copy.
 */
import { rm, readFile, stat, copyFile } from 'node:fs/promises';
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

async function main() {
  console.log('=== Testing CLI session.ts ===\n');

  let issues = 0;

  // 1. Create session
  const sessionDir = await createSession();
  console.log(`  Created session: ${sessionDir}`);

  // Check directories exist
  for (const sub of ['har', 'samples', 'openapi']) {
    try {
      const s = await stat(join(sessionDir, sub));
      if (!s.isDirectory()) throw new Error('not dir');
    } catch {
      console.error(`  FAIL: ${sub}/ not created`);
      issues++;
    }
  }
  console.log('  Subdirectories exist');

  // Check progress.json
  const progress = await loadProgress(sessionDir);
  if (progress.step !== 'recording') {
    console.error(`  FAIL: expected step 'recording', got '${progress.step}'`);
    issues++;
  }
  console.log(`  Initial step: ${progress.step}`);

  // Check devproxyrc.json was copied
  try {
    await stat(join(sessionDir, 'devproxyrc.json'));
    console.log('  devproxyrc.json copied');
  } catch {
    console.log('  devproxyrc.json not copied (acceptable if not present)');
  }

  // 2. Update step
  await updateStep(sessionDir, 'extracted');
  const updated = await loadProgress(sessionDir);
  if (updated.step !== 'extracted') {
    console.error(`  FAIL: expected 'extracted', got '${updated.step}'`);
    issues++;
  }
  console.log('  Step updated to extracted');

  // 3. Save progress with undo stack
  updated.undoStack = ['StatusTitle', 'CommitteeId'];
  updated.nextPromptIndex = 5;
  await saveProgress(sessionDir, updated);
  const reloaded = await loadProgress(sessionDir);
  if (reloaded.undoStack.length !== 2) {
    console.error(`  FAIL: undo stack length ${reloaded.undoStack.length}`);
    issues++;
  }
  if (reloaded.nextPromptIndex !== 5) {
    console.error(`  FAIL: nextPromptIndex ${reloaded.nextPromptIndex}`);
    issues++;
  }
  console.log('  Progress persistence OK');

  // 4. Copy HAR to session
  const testHar = 'test/fixtures/sample.har';
  await copyHarToSession(testHar, sessionDir);
  try {
    const copied = await stat(harPath(sessionDir));
    if (copied.size === 0) throw new Error('empty');
    console.log('  HAR copied to session');
  } catch {
    console.error('  FAIL: HAR not copied');
    issues++;
  }

  // 5. List sessions (should find at least one)
  const sessions = await listSessions();
  if (sessions.length === 0) {
    console.error('  FAIL: no sessions found');
    issues++;
  } else {
    console.log(`  Sessions found: ${sessions.length}`);
    for (const s of sessions.slice(0, 3)) {
      console.log(`    ${s.name} [${s.step}]`);
    }
  }

  // 6. Helper paths
  if (!samplesDir(sessionDir).includes('samples')) {
    console.error('  FAIL: samplesDir wrong');
    issues++;
  }
  if (!decisionsPath(sessionDir).includes('decisions.json')) {
    console.error('  FAIL: decisionsPath wrong');
    issues++;
  }
  if (!openApiDir(sessionDir).includes('openapi')) {
    console.error('  FAIL: openApiDir wrong');
    issues++;
  }
  console.log('  Path helpers OK');

  // Cleanup
  await rm(sessionDir, { recursive: true });
  console.log('  Session cleaned up');

  console.log(`\nIssues: ${issues}`);
  console.log(`${issues === 0 ? 'PASS' : 'FAIL'}: CLI session.ts\n`);
}

main().catch(console.error);
