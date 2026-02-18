/**
 * Recording: spawn Dev Proxy to capture HAR traffic.
 *
 * Dev Proxy writes devproxy-{timestamp}.har to its cwd.
 * We spawn it with cwd = session directory, then copy the result to har/input.har.
 */

import { spawn } from 'node:child_process';
import { copyHarToSession, findDevProxyHar } from './session.js';

/**
 * Check if devproxy is available on PATH.
 */
export async function checkDevProxy(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('devproxy', ['--version'], {
      stdio: 'pipe',
      shell: true,
    });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Start Dev Proxy recording in the session directory.
 * Returns a function to stop the recording.
 *
 * The user stops recording by pressing Ctrl+C in the proxy,
 * or by calling the returned stop function.
 */
export function startRecording(
  sessionDir: string,
): { process: ReturnType<typeof spawn>; stop: () => void } {
  const proc = spawn('devproxy', [], {
    cwd: sessionDir,
    stdio: 'inherit',
    shell: true,
  });

  const stop = () => {
    if (!proc.killed) {
      proc.kill('SIGINT');
    }
  };

  return { process: proc, stop };
}

/**
 * Wait for the Dev Proxy process to exit.
 */
export function waitForExit(proc: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => {
    proc.on('close', (code) => resolve(code));
    proc.on('error', () => resolve(null));
  });
}

/**
 * After recording stops, find the HAR and copy it to the session's har/ folder.
 */
export async function finalizeRecording(sessionDir: string): Promise<boolean> {
  const harFile = await findDevProxyHar(sessionDir);
  if (!harFile) return false;
  await copyHarToSession(harFile, sessionDir);
  return true;
}

export function devProxyInstallInstructions(): string {
  return `
Dev Proxy is required for recording but was not found on PATH.

Install Dev Proxy:
  macOS:   brew tap dotnet/dev-proxy && brew install dev-proxy
  Windows: winget install DevProxy.DevProxy --silent
  Linux:   bash -c "$(curl -sL https://aka.ms/devproxy/setup.sh)"

After installation, restart your terminal and try again.
`.trim();
}
