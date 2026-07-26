import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The package version, read from package.json at runtime.
 *
 * Read rather than hardcoded so a release bump cannot leave a stale constant
 * behind — `dist/` and `src/` both sit one directory below the manifest.
 */
export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
