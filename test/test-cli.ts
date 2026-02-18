import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('pnpm', ['-s', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'cli-test-'));
  const sessionsDir = join(base, 'sessions');

  try {
    const emptySessions = await runCli(['--sessions-dir', sessionsDir, 'sessions']);
    assert.equal(emptySessions.code, 0);
    assert.ok(emptySessions.stdout.includes('No sessions found.'));

    const newRun = await runCli([
      '--sessions-dir',
      sessionsDir,
      'new',
      '--har',
      'test/fixtures/sample.har',
      '--review-mode',
      'auto-scalar',
    ]);
    assert.equal(newRun.code, 0, `new command failed:\n${newRun.stdout}\n${newRun.stderr}`);
    assert.ok(newRun.stdout.includes('Status    : emitted'));

    const sessionNames = await readdir(sessionsDir);
    assert.equal(sessionNames.length, 1, 'new command should create one session');
    const firstSessionName = sessionNames[0]!;
    const firstSessionDir = join(sessionsDir, firstSessionName);

    const progress = JSON.parse(await readFile(join(firstSessionDir, 'progress.json'), 'utf-8')) as { step: string };
    assert.equal(progress.step, 'emitted', 'new command should complete pipeline in non-interactive mode');
    await stat(join(firstSessionDir, 'openapi', 'openapi.yaml'));

    const resumeRun = await runCli([
      '--sessions-dir',
      sessionsDir,
      'resume',
      firstSessionName,
      '--review-mode',
      'auto-scalar',
    ]);
    assert.equal(resumeRun.code, 0, `resume command failed:\n${resumeRun.stdout}\n${resumeRun.stderr}`);
    assert.ok(resumeRun.stdout.includes('Current step: emitted'));

    const startRun = await runCli([
      '--sessions-dir',
      sessionsDir,
      'start',
      '--action',
      'new',
      '--har',
      'test/fixtures/sample.har',
      '--review-mode',
      'auto-scalar',
    ]);
    assert.equal(startRun.code, 0, `start command failed:\n${startRun.stdout}\n${startRun.stderr}`);
    assert.ok(startRun.stdout.includes('Status    : emitted'));

    const sessionsAfterStart = await readdir(sessionsDir);
    assert.equal(sessionsAfterStart.length, 2, 'start --action new should create another session');

    const invalidHar = await runCli([
      '--sessions-dir',
      sessionsDir,
      'new',
      '--har',
      'test/fixtures/does-not-exist.har',
      '--review-mode',
      'auto-scalar',
    ]);
    assert.equal(invalidHar.code, 1, 'new with invalid HAR should fail');
    assert.ok(invalidHar.stderr.includes('HAR file not found'));

    console.log('PASS test-cli.ts');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
