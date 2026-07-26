/**
 * The three artefacts that describe configuration must not drift apart.
 *
 * plan.md's verification bar: "every placeholder in config.ts appears in
 * docs/CONFIGURATION.md with a stated source". With manual provisioning, the manifest is the
 * only inventory of what was created by hand — a manifest that disagrees with .env.example or
 * the docs is worse than no manifest, because it is trusted.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_MANIFEST, PLACEHOLDER } from '@ats/core';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');

/** Keys declared in .env.example, including ones commented out as optional. */
function envExampleKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const line of source.split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

describe('.env.example matches the manifest exactly', () => {
  const declared = envExampleKeys(read('.env.example'));
  const manifest = new Set(CONFIG_MANIFEST.map((spec) => spec.key));

  it('declares every manifest key', () => {
    const missing = [...manifest].filter((key) => !declared.has(key));
    expect(missing, 'keys in the manifest but not in .env.example').toEqual([]);
  });

  it('declares nothing the manifest does not know about', () => {
    const extra = [...declared].filter((key) => !manifest.has(key));
    expect(extra, 'keys in .env.example that config.ts cannot resolve').toEqual([]);
  });

  it('uses REPLACE_ME for every value with no safe default', () => {
    const source = read('.env.example');
    for (const spec of CONFIG_MANIFEST) {
      if (spec.defaultValue !== undefined || spec.optional) continue;
      const line = source
        .split('\n')
        .find((candidate) => candidate.trim().startsWith(`${spec.key}=`));
      expect(line, `${spec.key} is missing from .env.example`).toBeDefined();
      expect(line?.trim(), `${spec.key} should be a placeholder, not a guessed value`).toBe(
        `${spec.key}=${PLACEHOLDER}`,
      );
    }
  });

  it('leaves the Gate 6 embedding decision unmade', () => {
    // The single most expensive thing to guess in this build: a wrong embedding model
    // corrupts similarity search without erroring.
    const source = read('.env.example');
    expect(source).toContain(`EMBEDDING_MODEL_ID=${PLACEHOLDER}`);
    expect(source).toContain(`EMBEDDING_DIM=${PLACEHOLDER}`);
  });
});

describe('docs/CONFIGURATION.md documents every variable', () => {
  const doc = read('docs/CONFIGURATION.md');

  it.each(CONFIG_MANIFEST.map((spec) => spec.key))('documents %s', (key) => {
    expect(doc).toContain(key);
  });

  it('documents nothing that no longer exists', () => {
    // Catches a variable being renamed in the manifest but left behind in the docs.
    const documented = [...doc.matchAll(/`([A-Z][A-Z0-9_]{4,})`/g)].map((match) => match[1]);
    const manifest = new Set(CONFIG_MANIFEST.map((spec) => spec.key));
    const known = new Set([
      ...manifest,
      // Terms that legitimately look like variables but are not manifest entries.
      'REPLACE_ME',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'RUN_INTEGRATION',
    ]);
    const stale = [...new Set(documented)].filter((key) => key && !known.has(key));
    expect(stale, 'documented variables that are not in the manifest').toEqual([]);
  });
});

describe('config.ts is the only module that reads process.env', () => {
  it('holds across every package and tool', () => {
    // plan.md: "No Lambda, adapter, supervisor, or web route reads process.env directly —
    // everything resolves through it, so the complete set of required configuration is
    // knowable by reading one file." Enforced, not merely intended.
    const allowed = new Set([
      join('packages', 'core', 'src', 'config.ts'),
      // The CLI hands process.env to createConfig; it resolves nothing itself.
      join('tools', 'doctor', 'src', 'cli.ts'),
    ]);

    const offenders: string[] = [];
    for (const dir of ['packages', 'tools', 'supervisor', 'lambdas', 'apps']) {
      for (const file of walk(join(repoRoot, dir))) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
        const relative = file.slice(repoRoot.length);
        if (allowed.has(relative)) continue;
        // Comments discussing the rule are not violations of it.
        if (/process\.env/.test(stripComments(readFileSync(file, 'utf8')))) {
          offenders.push(relative);
        }
      }
    }

    expect(offenders, 'these modules bypass packages/core/src/config.ts').toEqual([]);
  });
});

/**
 * Strips block and line comments. `//` preceded by `:` is left alone so a URL inside a string
 * literal is not mistaken for a comment, which could otherwise hide real code on that line.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Directory for a later gate that does not exist yet.
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}
