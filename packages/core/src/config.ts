/**
 * The one and only module that reads `process.env`.
 *
 * No Lambda, adapter, supervisor, or web route resolves configuration for itself — every
 * value comes through here, so the complete set of required configuration is knowable by
 * reading one file (plan.md, "The placeholder and config system"). A contract test in
 * tests/gate-1/contract enforces that no other source file mentions `process.env`.
 *
 * Two access modes, deliberately different:
 *
 *   config.get(KEY)  — fails loudly. Throws ConfigurationError naming the variable and
 *                      pointing at docs/CONFIGURATION.md if the value is absent or still
 *                      REPLACE_ME. A placeholder must never reach an AWS or database call
 *                      and surface as a confusing downstream error.
 *   config.audit()   — never throws. Reports what is still outstanding, which is what
 *                      `pnpm check:config` and the doctor's config check print.
 */

import { ConfigurationError } from './errors.ts';
import {
  CONFIG_MANIFEST,
  PLACEHOLDER,
  findSpec,
  type ConfigVarSpec,
} from './manifest.ts';

export { PLACEHOLDER, CONFIG_MANIFEST } from './manifest.ts';
export type { ConfigVarSpec, ConfigGroup } from './manifest.ts';
export { ConfigurationError } from './errors.ts';

export type EnvSource = Record<string, string | undefined>;

export type OutstandingReason = 'missing' | 'placeholder';

export interface OutstandingVar {
  readonly key: string;
  readonly reason: OutstandingReason;
  readonly gate: number;
  readonly description: string;
  readonly source: string;
}

export interface ConfigAudit {
  /** Variables with no usable value, ordered by the gate that first needs them. */
  readonly outstanding: readonly OutstandingVar[];
  /** Keys that resolved to a real value (including via defaultValue). */
  readonly satisfied: readonly string[];
  /** Optional keys deliberately left unset. */
  readonly skipped: readonly string[];
}

export interface AppConfig {
  /** Resolve a manifest key, throwing ConfigurationError if it is unusable. */
  get(key: string): string;
  /** Resolve an optional key. Returns undefined when unset; still throws on REPLACE_ME. */
  getOptional(key: string): string | undefined;
  /** Resolve a key as an integer. Throws if unusable or not an integer. */
  getInt(key: string): number;
  /** True when the key has a real, non-placeholder value. Never throws. */
  has(key: string): boolean;
  /** What is still outstanding. Never throws. Pass a gate to audit only that far. */
  audit(upToGate?: number): ConfigAudit;

  // Typed accessors — the surface the rest of the system uses.
  readonly awsRegion: () => string;
  readonly awsAccountId: () => string;
  readonly awsProfile: () => string | undefined;
  readonly supervisorModelId: () => string;
  readonly embeddingModelId: () => string;
  readonly embeddingDim: () => number;
  readonly agentCoreRuntimeArn: () => string;
  readonly agentCoreMemoryId: () => string;
  readonly agentCoreGatewayUrl: () => string;
  readonly agentCoreGatewayAuthMode: () => string;
  readonly agentCoreGatewayAuthToken: () => string | undefined;
  readonly cockroachDatabaseUrl: () => string;
  readonly cockroachSslRootCert: () => string;
  readonly dbAccessMode: () => 'sql' | 'mcp';
  readonly cockroachMcpEndpoint: () => string;
  readonly cockroachMcpApiKey: () => string;
  readonly s3PolicyBucket: () => string;
  readonly s3DoctorProbeKey: () => string;
  readonly s3RefundPolicyKey: () => string;
  readonly s3DisputePolicyKey: () => string;
  readonly s3GenericPolicyKey: () => string;
  readonly policyCacheTtlSeconds: () => number;
  readonly ticketHandlerFunctionUrl: () => string;
  readonly webQueuePassword: () => string;
  readonly logLevel: () => string;
}

const MANIFEST_DOC = 'docs/CONFIGURATION.md';

function unknownKey(key: string): never {
  throw new ConfigurationError(
    key,
    `'${key}' is not in the configuration manifest. Add it to ` +
      `packages/core/src/manifest.ts, .env.example, and ${MANIFEST_DOC} before using it.`,
  );
}

/** Raw lookup: env value, else the spec default, else undefined. Placeholders survive. */
function rawValue(env: EnvSource, spec: ConfigVarSpec): string | undefined {
  const fromEnv = env[spec.key];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  return spec.defaultValue;
}

function placeholderError(spec: ConfigVarSpec): ConfigurationError {
  return new ConfigurationError(
    spec.key,
    `Configuration variable ${spec.key} is still set to the placeholder ${PLACEHOLDER}. ` +
      `${spec.description} Obtain the real value: ${spec.source} ` +
      `Required from Gate ${spec.gate}. See ${MANIFEST_DOC}.`,
  );
}

function missingError(spec: ConfigVarSpec): ConfigurationError {
  return new ConfigurationError(
    spec.key,
    `Configuration variable ${spec.key} is not set and has no default. ` +
      `${spec.description} Obtain the real value: ${spec.source} ` +
      `Required from Gate ${spec.gate}. See ${MANIFEST_DOC}.`,
  );
}

export function createConfig(env: EnvSource = process.env): AppConfig {
  function get(key: string): string {
    const spec = findSpec(key) ?? unknownKey(key);
    const value = rawValue(env, spec);
    if (value === undefined) throw missingError(spec);
    if (value === PLACEHOLDER) throw placeholderError(spec);
    return value;
  }

  function getOptional(key: string): string | undefined {
    const spec = findSpec(key) ?? unknownKey(key);
    const value = rawValue(env, spec);
    if (value === undefined) return undefined;
    // A placeholder is an error even on an optional variable: it means "not yet filled in",
    // which is different from "deliberately unset".
    if (value === PLACEHOLDER) throw placeholderError(spec);
    return value;
  }

  function getInt(key: string): number {
    const value = get(key);
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new ConfigurationError(
        key,
        `Configuration variable ${key} must be an integer, got '${value}'. See ${MANIFEST_DOC}.`,
      );
    }
    return parsed;
  }

  function has(key: string): boolean {
    const spec = findSpec(key);
    if (!spec) return false;
    const value = rawValue(env, spec);
    return value !== undefined && value !== PLACEHOLDER;
  }

  function audit(upToGate?: number): ConfigAudit {
    const outstanding: OutstandingVar[] = [];
    const satisfied: string[] = [];
    const skipped: string[] = [];

    for (const spec of CONFIG_MANIFEST) {
      if (upToGate !== undefined && spec.gate > upToGate) continue;
      const value = rawValue(env, spec);
      if (value === PLACEHOLDER) {
        outstanding.push({
          key: spec.key,
          reason: 'placeholder',
          gate: spec.gate,
          description: spec.description,
          source: spec.source,
        });
      } else if (value === undefined) {
        if (spec.optional) {
          skipped.push(spec.key);
        } else {
          outstanding.push({
            key: spec.key,
            reason: 'missing',
            gate: spec.gate,
            description: spec.description,
            source: spec.source,
          });
        }
      } else {
        satisfied.push(spec.key);
      }
    }

    outstanding.sort((a, b) => a.gate - b.gate || a.key.localeCompare(b.key));
    return { outstanding, satisfied, skipped };
  }

  function dbAccessMode(): 'sql' | 'mcp' {
    const value = get('DB_ACCESS_MODE');
    if (value !== 'sql' && value !== 'mcp') {
      throw new ConfigurationError(
        'DB_ACCESS_MODE',
        `Configuration variable DB_ACCESS_MODE must be 'sql' or 'mcp', got '${value}'. ` +
          `See ${MANIFEST_DOC}.`,
      );
    }
    return value;
  }

  return {
    get,
    getOptional,
    getInt,
    has,
    audit,
    awsRegion: () => get('AWS_REGION'),
    awsAccountId: () => get('AWS_ACCOUNT_ID'),
    awsProfile: () => getOptional('AWS_PROFILE'),
    supervisorModelId: () => get('BEDROCK_SUPERVISOR_MODEL_ID'),
    embeddingModelId: () => get('EMBEDDING_MODEL_ID'),
    embeddingDim: () => getInt('EMBEDDING_DIM'),
    agentCoreRuntimeArn: () => get('AGENTCORE_RUNTIME_ARN'),
    agentCoreMemoryId: () => get('AGENTCORE_MEMORY_ID'),
    agentCoreGatewayUrl: () => get('AGENTCORE_GATEWAY_URL'),
    agentCoreGatewayAuthMode: () => get('AGENTCORE_GATEWAY_AUTH_MODE'),
    agentCoreGatewayAuthToken: () => getOptional('AGENTCORE_GATEWAY_AUTH_TOKEN'),
    cockroachDatabaseUrl: () => get('COCKROACH_DATABASE_URL'),
    cockroachSslRootCert: () => get('COCKROACH_SSL_ROOT_CERT'),
    dbAccessMode,
    cockroachMcpEndpoint: () => get('COCKROACH_MCP_ENDPOINT'),
    cockroachMcpApiKey: () => get('COCKROACH_MCP_API_KEY'),
    s3PolicyBucket: () => get('S3_POLICY_BUCKET'),
    s3DoctorProbeKey: () => get('S3_DOCTOR_PROBE_KEY'),
    s3RefundPolicyKey: () => get('S3_REFUND_POLICY_KEY'),
    s3DisputePolicyKey: () => get('S3_DISPUTE_POLICY_KEY'),
    s3GenericPolicyKey: () => get('S3_GENERIC_POLICY_KEY'),
    policyCacheTtlSeconds: () => getInt('POLICY_CACHE_TTL_SECONDS'),
    ticketHandlerFunctionUrl: () => get('TICKET_HANDLER_FUNCTION_URL'),
    webQueuePassword: () => get('WEB_QUEUE_PASSWORD'),
    logLevel: () => get('LOG_LEVEL'),
  };
}

let cached: AppConfig | undefined;

/** Process-wide config bound to process.env. Resolved once, lazily. */
export function config(): AppConfig {
  cached ??= createConfig(process.env);
  return cached;
}

/** Test seam: drop the cached process-wide config. */
export function resetConfigCache(): void {
  cached = undefined;
}
