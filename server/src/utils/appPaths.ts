import path from 'path';

/**
 * When running as a pkg executable, process.pkg is truthy and
 * process.execPath points to the .exe itself.
 * In dev / compiled Node, use __dirname-relative paths.
 */
const isPkg = !!(process as any).pkg;

/**
 * Root directory of the application:
 * - pkg:  directory that contains the executable (config.json, data/, client/dist/ live here)
 * - dev:  project root (3 levels up from server/src/utils/ or server/dist/utils/)
 */
export function getAppRoot(): string {
  if (isPkg) return path.dirname(process.execPath);
  // __dirname is either server/src/utils (tsx) or server/dist/utils (node)
  // ../../../ → project root in both cases
  return path.join(__dirname, '../../..');
}
