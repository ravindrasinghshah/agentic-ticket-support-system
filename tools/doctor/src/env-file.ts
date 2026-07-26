/**
 * A minimal `.env` parser.
 *
 * Deliberately returns a plain record rather than mutating `process.env`: the caller merges
 * it, which keeps `process.env` access confined to `config.ts` and the CLI entry point. No
 * dependency — the format we need is `KEY=value`, with `#` comments and optional quotes.
 *
 * Shell environment always wins over the file, so `AWS_PROFILE=other pnpm doctor` overrides
 * `.env` the way anyone would expect.
 */

import { readFileSync } from 'node:fs';

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing unquoted comment, but only when it is clearly separated, so a `#`
      // inside a password or connection string survives.
      value = value.replace(/\s+#.*$/, '');
    }

    values[key] = value;
  }

  return values;
}

/** Reads and parses a .env file. Returns {} when the file does not exist. */
export function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
