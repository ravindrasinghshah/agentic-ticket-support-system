import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_BEDROCK_MODEL_ID = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
const DEFAULT_SUPERVISOR_RESERVED_CONCURRENCY = 0;
export const COCKROACH_CLOUD_MCP_ENDPOINT = 'https://cockroachlabs.cloud/mcp';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIG_KEYS = new Set([
  'cockroachCloudClusterId',
  'corsAllowedOrigin',
  'bedrockModelId',
  'supervisorReservedConcurrency',
]);

interface DeploymentConfigFile {
  readonly cockroachCloudClusterId?: unknown;
  readonly corsAllowedOrigin?: unknown;
  readonly bedrockModelId?: unknown;
  readonly supervisorReservedConcurrency?: unknown;
}

export interface DeploymentConfig {
  readonly stage: string;
  readonly cockroachCloudClusterId: string;
  readonly cockroachCloudMcpApiKey: string;
  readonly corsAllowedOrigin: string;
  readonly bedrockModelId: string;
  readonly supervisorReservedConcurrency: number;
}

export interface LoadDeploymentConfigOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly configDirectory?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredString(value: unknown, name: string): string {
  const parsed = nonEmptyString(value);
  if (!parsed) throw new Error(`${name} must be configured with a non-empty value`);
  return parsed;
}

function readConfigFile(configPath: string, required: boolean): DeploymentConfigFile {
  if (!fs.existsSync(configPath)) {
    if (required) throw new Error(`CDK_CONFIG_FILE does not exist: ${configPath}`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`Unable to read deployment config ${configPath}: ${reason}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Deployment config must contain a JSON object: ${configPath}`);
  }

  const unknownKeys = Object.keys(parsed).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown deployment config fields: ${unknownKeys.join(', ')}`);
  }
  return parsed as DeploymentConfigFile;
}

function validateCorsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CORS_ALLOWED_ORIGIN must be one exact HTTP(S) origin');
  }
  if (!['http:', 'https:'].includes(url.protocol) || value !== url.origin) {
    throw new Error('CORS_ALLOWED_ORIGIN must be one exact HTTP(S) origin');
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(nonEmptyString(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function loadDeploymentConfig(
  options: LoadDeploymentConfigOptions = {},
): DeploymentConfig {
  const environment = options.environment ?? process.env;
  const stage = nonEmptyString(environment.DEPLOYMENT_STAGE) ?? 'development';
  if (!/^[a-z][a-z0-9-]*$/.test(stage)) {
    throw new Error('DEPLOYMENT_STAGE must start with a lowercase letter and contain only a-z, 0-9, or -');
  }

  const explicitConfigFile = nonEmptyString(environment.CDK_CONFIG_FILE);
  const configDirectory = options.configDirectory ?? path.resolve(process.cwd(), 'config');
  const configPath = explicitConfigFile
    ? path.resolve(explicitConfigFile)
    : path.join(configDirectory, `${stage}.json`);
  const file = readConfigFile(configPath, Boolean(explicitConfigFile));

  const cockroachCloudClusterId = requiredString(
    environment.COCKROACH_CLOUD_CLUSTER_ID ?? file.cockroachCloudClusterId,
    'COCKROACH_CLOUD_CLUSTER_ID',
  );
  if (!UUID_PATTERN.test(cockroachCloudClusterId)) {
    throw new Error('COCKROACH_CLOUD_CLUSTER_ID must be a valid CockroachDB Cloud cluster UUID');
  }
  const cockroachCloudMcpApiKey = requiredString(
    environment.COCKROACH_CLOUD_MCP_API_KEY,
    'COCKROACH_CLOUD_MCP_API_KEY',
  );

  const corsAllowedOrigin = validateCorsOrigin(
    requiredString(
      environment.CORS_ALLOWED_ORIGIN ?? file.corsAllowedOrigin,
      'CORS_ALLOWED_ORIGIN',
    ),
  );
  const bedrockModelId = requiredString(
    environment.BEDROCK_MODEL_ID ?? file.bedrockModelId ?? DEFAULT_BEDROCK_MODEL_ID,
    'BEDROCK_MODEL_ID',
  );
  const supervisorReservedConcurrency = nonNegativeInteger(
    environment.SUPERVISOR_RESERVED_CONCURRENCY ??
      file.supervisorReservedConcurrency ??
      DEFAULT_SUPERVISOR_RESERVED_CONCURRENCY,
    'SUPERVISOR_RESERVED_CONCURRENCY',
  );

  return {
    stage,
    cockroachCloudClusterId,
    cockroachCloudMcpApiKey,
    corsAllowedOrigin,
    bedrockModelId,
    supervisorReservedConcurrency,
  };
}
