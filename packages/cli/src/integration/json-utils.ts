import { existsSync, readFileSync } from 'node:fs';

/**
 * Reads and parses a JSON file, returning `fallback` if the file does not
 * exist, cannot be read, or contains malformed JSON. Never throws.
 */
export function readJsonSafe<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
