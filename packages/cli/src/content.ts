import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Directory holding the skills/ and agents/ that modules materialize: `dist/content` in the
 * published bundle, `packages/content` when running from source (tests, tsx).
 * YANDECODE_CONTENT_DIR overrides it (custom content, tests).
 */
export function contentRoot(): string {
  const override = process.env.YANDECODE_CONTENT_DIR;
  if (override) return override;
  for (const candidate of ['./content', '../content', '../../content']) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(dir)) return dir;
  }
  throw new Error('yandecode content directory not found (broken installation?)');
}
