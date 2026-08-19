import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { InferenceClient } from '@huggingface/inference';
import { McpClient } from '@strands-agents/sdk';
import {
  CockroachCloudMcpClient,
  cockroachCloudMcpHeaders,
  COCKROACH_CLOUD_MCP_ENDPOINT,
} from '../src/infrastructure/mcp/managed-cockroach-mcp-client.js';
import {
  sqlString,
  sqlUuid,
  validateDatabaseName,
} from '../src/infrastructure/mcp/cockroach-sql.js';

const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const EMBEDDING_DIMENSION = 384;
const MCP_TIMEOUT_MS = 20_000;
const CATEGORY_PATTERN = 'delivery|returns|billing|account|product|other';

interface FaqEntry {
  resolutionId: string;
  title: string;
  category: string;
  question: string;
  answer: string;
}

function configuration(): {
  clusterId: string;
  apiKey: string;
  database: string;
  hfToken: string;
} {
  const environmentFile = process.env.CDK_ENV_FILE?.trim()
    ? resolve(process.env.CDK_ENV_FILE)
    : resolve(process.cwd(), '../../infrastructure/.env');
  const file = parseEnv(readFileSync(environmentFile, 'utf8'));
  const value = (name: string, allowFile = true): string => {
    const configured = process.env[name]?.trim() || (allowFile ? file[name]?.trim() : undefined);
    if (!configured) {
      throw new Error(
        allowFile
          ? `${name} must be configured in the shell or ${environmentFile}`
          : `${name} must be configured in the shell`,
      );
    }
    return configured;
  };

  return {
    clusterId: value('COCKROACH_CLOUD_CLUSTER_ID'),
    apiKey: value('COCKROACH_CLOUD_MCP_API_KEY'),
    database: validateDatabaseName(value('COCKROACH_CLOUD_DATABASE')),
    // Keep this secret out of the shared infrastructure .env until CDK explicitly supports it.
    hfToken: value('HF_TOKEN', false),
  };
}

export function parseFaq(source: string): FaqEntry[] {
  const sections = source.split(/^---\s*$/m);
  const entries = sections.flatMap((section) => {
    const match = section.match(
      new RegExp(
        `^##\\s+(.+?)\\r?\\n\\s*Resolution-ID:\\s*([0-9a-f-]{36})\\r?\\nCategory:\\s*(${CATEGORY_PATTERN})\\r?\\n\\s*Question:\\s*(.+?)\\r?\\n\\s*Answer:\\s*([\\s\\S]+?)\\s*$`,
        'im',
      ),
    );
    if (!match) return [];
    return [{
      title: match[1].trim(),
      resolutionId: match[2].toLowerCase(),
      category: match[3].toLowerCase(),
      question: match[4].trim(),
      answer: match[5].trim(),
    }];
  });

  if (!entries.length) throw new Error('No FAQ entries were found');
  const ids = new Set(entries.map((entry) => entry.resolutionId));
  if (ids.size !== entries.length) throw new Error('FAQ contains duplicate Resolution-ID values');
  return entries;
}

function canonicalText(entry: FaqEntry): string {
  return [
    `Title: ${entry.title}`,
    `Category: ${entry.category}`,
    `Question: ${entry.question}`,
    `Resolution: ${entry.answer}`,
  ].join('\n');
}

function vectorFromResult(result: unknown): number[] {
  const candidate =
    Array.isArray(result) && result.length === 1 && Array.isArray(result[0])
      ? result[0]
      : result;
  if (
    !Array.isArray(candidate) ||
    candidate.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new Error('Hugging Face returned an unexpected embedding shape');
  }
  if (candidate.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSION} embedding dimensions, received ${candidate.length}`,
    );
  }
  return candidate as number[];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      file: { type: 'string' },
    },
  });
  const faqPath = resolve(
    values.file ?? resolve(process.cwd(), '../../database/faq-resolutions.md'),
  );
  const entries = parseFaq(readFileSync(faqPath, 'utf8'));
  console.log(`Parsed ${entries.length} FAQ resolutions from ${faqPath}`);

  if (values['dry-run']) {
    console.log('Dry run complete; no embeddings were generated and no rows were written.');
    return;
  }

  const config = configuration();
  const hf = new InferenceClient(config.hfToken);
  const database = new CockroachCloudMcpClient(
    new McpClient({
      url: COCKROACH_CLOUD_MCP_ENDPOINT,
      headers: cockroachCloudMcpHeaders(config.clusterId, config.apiKey),
    }),
    config.database,
    MCP_TIMEOUT_MS,
  );

  try {
    for (const [index, entry] of entries.entries()) {
      const text = canonicalText(entry);
      const contentHash = createHash('sha256').update(text).digest('hex');
      const result = await hf.featureExtraction({
        provider: 'hf-inference',
        model: EMBEDDING_MODEL,
        inputs: text,
        normalize: true,
      });
      const embedding = vectorFromResult(result);
      const vectorLiteral = `[${embedding.join(',')}]`;

      await database.insert(`
        INSERT INTO public.resolution_articles (
          resolution_id, category, title, summary, active
        ) VALUES (
          ${sqlUuid(entry.resolutionId)}, ${sqlString(entry.category)},
          ${sqlString(entry.title)}, ${sqlString(entry.answer)}, true
        )
        ON CONFLICT (resolution_id) DO UPDATE SET
          category = excluded.category,
          title = excluded.title,
          summary = excluded.summary,
          active = true,
          updated_at = now()`);

      await database.insert(`
        INSERT INTO public.resolution_embeddings (
          resolution_id, embedding, embedding_model, content_hash, embedded_at
        ) VALUES (
          ${sqlUuid(entry.resolutionId)}, ${sqlString(vectorLiteral)}::VECTOR(384),
          ${sqlString(EMBEDDING_MODEL)}, ${sqlString(contentHash)}, now()
        )
        ON CONFLICT (resolution_id) DO UPDATE SET
          embedding = excluded.embedding,
          embedding_model = excluded.embedding_model,
          content_hash = excluded.content_hash,
          embedded_at = now()`);

      console.log(`[${index + 1}/${entries.length}] Embedded ${entry.title}`);
    }
  } finally {
    await database.disconnect().catch(() => undefined);
  }

  console.log(`Upserted ${entries.length} FAQ embeddings using ${EMBEDDING_MODEL}.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown FAQ embedding error';
  console.error(`FAQ embedding import failed: ${message}`);
  process.exitCode = 1;
});

