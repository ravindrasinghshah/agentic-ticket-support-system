import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';

const ALLOWED_KEYS = new Set([
  'DEPLOYMENT_STAGE',
  'CDK_CONFIG_FILE',
  'COCKROACH_CLOUD_CLUSTER_ID',
  'COCKROACH_CLOUD_MCP_API_KEY',
  'CORS_ALLOWED_ORIGIN',
  'BEDROCK_MODEL_ID',
  'SUPERVISOR_RESERVED_CONCURRENCY',
]);

export interface LoadEnvironmentFileOptions {
  readonly defaultFilePath: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Loads local deployment settings without replacing variables already supplied by the shell or CI.
 * The file is optional unless CDK_ENV_FILE explicitly selects it.
 */
export function loadEnvironmentFile(options: LoadEnvironmentFileOptions): string | undefined {
  const environment = options.environment ?? process.env;
  const explicitlyConfiguredPath = environment.CDK_ENV_FILE?.trim();
  const filePath = explicitlyConfiguredPath
    ? path.resolve(explicitlyConfiguredPath)
    : options.defaultFilePath;

  if (!fs.existsSync(filePath)) {
    if (explicitlyConfiguredPath) throw new Error(`CDK_ENV_FILE does not exist: ${filePath}`);
    return undefined;
  }

  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid environment file';
    throw new Error(`Unable to read deployment environment file ${filePath}: ${reason}`);
  }

  const unknownKeys = Object.keys(parsed).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown deployment environment fields: ${unknownKeys.join(', ')}`);
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && environment[key] === undefined) environment[key] = value;
  }
  return filePath;
}
