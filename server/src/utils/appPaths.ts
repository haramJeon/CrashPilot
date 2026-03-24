import os from 'os';
import path from 'path';

/**
 * When running as a pkg executable, process.pkg is truthy and
 * process.execPath points to the .exe itself.
 * In dev / compiled Node, use __dirname-relative paths.
 */
const isPkg = !!(process as any).pkg;

/**
 * Root directory of the application (executable location):
 * - pkg:  directory that contains the executable
 * - dev:  project root (3 levels up from server/src/utils/ or server/dist/utils/)
 */
export function getAppRoot(): string {
  if (isPkg) return path.dirname(process.execPath);
  return path.join(__dirname, '../../..');
}

/**
 * Root directory for user data (config, pipeline history, logs, etc.).
 * Kept separate from the install folder so data survives version upgrades.
 * - pkg + Windows:  C:\ProgramData\CrashPilot
 * - pkg + macOS:    /Library/Application Support/CrashPilot
 * - dev:            project root (same as getAppRoot — no change to dev workflow)
 */
export function getDataRoot(): string {
  if (isPkg) {
    if (os.platform() === 'win32') {
      return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'CrashPilot');
    }
    return path.join('/Library/Application Support', 'CrashPilot');
  }
  return path.join(__dirname, '../../..');
}
