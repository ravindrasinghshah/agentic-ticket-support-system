/**
 * The configuration manifest — the single inventory of every value this system needs
 * from its environment.
 *
 * Because provisioning is manual (no IaC, see plan.md "Provisioning: manual by design"),
 * this file carries extra weight: it is the only machine-readable record of what was
 * created by hand and where each value came from. Three artefacts are checked against it
 * by tests/gate-1/contract:
 *
 *   - .env.example            must list exactly these keys
 *   - docs/CONFIGURATION.md   must document every key with its source
 *   - config.ts               resolves only these keys, and nothing else reads process.env
 *
 * `gate` is the gate from which a real value is *required*. Before that gate the value may
 * remain REPLACE_ME and `pnpm doctor` reports it as outstanding rather than failing.
 */

/** Sentinel written into .env.example. Greppable, impossible to mistake for a real value. */
export const PLACEHOLDER = 'REPLACE_ME';

export type ConfigGroup = 'bedrock-agentcore' | 'cockroachdb' | 'aws' | 'web' | 'runtime';

export interface ConfigVarSpec {
  /** Environment variable name. */
  readonly key: string;
  /** What the value is. */
  readonly description: string;
  /** Exactly where to obtain the real value — console path, CLI command, or runbook step. */
  readonly source: string;
  /** The gate from which a real value is required. */
  readonly gate: number;
  readonly group: ConfigGroup;
  /**
   * Value used when the variable is absent from the environment. A spec with a default is
   * never "outstanding" — it is a tunable, not a placeholder.
   */
  readonly defaultValue?: string;
  /** Optional variables may be absent with no default; accessors return undefined. */
  readonly optional?: boolean;
}

export const CONFIG_MANIFEST: readonly ConfigVarSpec[] = [
  // ── AWS account and region ────────────────────────────────────────────────────────
  {
    key: 'AWS_REGION',
    description: 'Region hosting Bedrock, AgentCore, Lambda, and the policy bucket.',
    source:
      'Choose a region where BOTH Bedrock model access and AgentCore are available; ' +
      'confirm with `pnpm doctor`. See docs/PROVISIONING.md step 1.',
    gate: 1,
    group: 'aws',
  },
  {
    key: 'AWS_ACCOUNT_ID',
    description: '12-digit AWS account ID. Doctor asserts the resolved caller matches it.',
    source: '`aws sts get-caller-identity --query Account --output text`',
    gate: 1,
    group: 'aws',
  },
  {
    key: 'AWS_PROFILE',
    description: 'Named credentials profile. Omit to use the default credential chain.',
    source: '`aws configure --profile <name>`; the profile name you chose.',
    gate: 1,
    group: 'aws',
    optional: true,
  },

  // ── Bedrock / AgentCore ───────────────────────────────────────────────────────────
  {
    key: 'BEDROCK_SUPERVISOR_MODEL_ID',
    description:
      'Foundation model ID the supervisor reasons with. Resolve from the live service — ' +
      'never recalled from memory (plan.md "Stop and ask", Gate 2).',
    source:
      '`aws bedrock list-foundation-models --region $AWS_REGION` and grant access in ' +
      'Bedrock console → Model access. See docs/PROVISIONING.md step 3.',
    gate: 1,
    group: 'bedrock-agentcore',
  },
  {
    key: 'EMBEDDING_MODEL_ID',
    description:
      'Embedding model that produces every vector in `resolutions`. USER-SPECIFIED AT GATE 6 — ' +
      'do not assume or default to a familiar one (ARCHITECTURE.md §9.2).',
    source: 'Supplied by the user at Gate 6, then confirmed against the live service.',
    gate: 6,
    group: 'bedrock-agentcore',
  },
  {
    key: 'EMBEDDING_DIM',
    description:
      'Output dimension of EMBEDDING_MODEL_ID. Sets the VECTOR(n) column width and is asserted ' +
      'against every returned vector. One model, one dimension, for every row — never mixed.',
    source: 'The chosen model\'s documented output dimension, supplied by the user at Gate 6.',
    gate: 6,
    group: 'bedrock-agentcore',
  },
  {
    key: 'AGENTCORE_RUNTIME_ARN',
    description: 'ARN of the AgentCore Runtime hosting the TypeScript supervisor.',
    source: 'Bedrock console → AgentCore → Runtimes, after creating it at Gate 2.',
    gate: 2,
    group: 'bedrock-agentcore',
  },
  {
    key: 'AGENTCORE_MEMORY_ID',
    description: 'AgentCore Memory resource holding session state keyed by conversation_id.',
    source: 'Bedrock console → AgentCore → Memory, after creating it at Gate 2.',
    gate: 2,
    group: 'bedrock-agentcore',
  },
  {
    key: 'AGENTCORE_GATEWAY_URL',
    description: 'AgentCore Gateway MCP endpoint publishing the specialist Lambdas as tools.',
    source: 'Bedrock console → AgentCore → Gateways, after creating it at Gate 3.',
    gate: 3,
    group: 'bedrock-agentcore',
  },
  {
    key: 'AGENTCORE_GATEWAY_AUTH_MODE',
    description: 'How the supervisor authenticates to the Gateway. Settled at Gate 3.',
    source: 'Determined by the Gateway inbound auth configuration chosen at Gate 3.',
    gate: 3,
    group: 'bedrock-agentcore',
    defaultValue: 'iam',
  },
  {
    key: 'AGENTCORE_GATEWAY_AUTH_TOKEN',
    description:
      'Bearer token or OAuth client secret for the Gateway when AGENTCORE_GATEWAY_AUTH_MODE ' +
      'is not `iam`. Unused under IAM auth.',
    source: 'The identity provider configured for the Gateway at Gate 3.',
    gate: 3,
    group: 'bedrock-agentcore',
    optional: true,
  },

  // ── CockroachDB ───────────────────────────────────────────────────────────────────
  {
    key: 'COCKROACH_DATABASE_URL',
    description: 'postgresql:// connection string for the CockroachDB Cloud cluster.',
    source:
      'CockroachDB Cloud console → cluster → Connect → General connection string. ' +
      'See docs/PROVISIONING.md step 5.',
    gate: 1,
    group: 'cockroachdb',
  },
  {
    key: 'COCKROACH_SSL_ROOT_CERT',
    description: 'Absolute path to the cluster CA certificate used for sslmode=verify-full.',
    source:
      'Downloaded from the same Connect dialog (`cc-ca.crt`). Store outside the repo or under ' +
      'certs/, which is gitignored.',
    gate: 1,
    group: 'cockroachdb',
  },
  {
    key: 'DB_ACCESS_MODE',
    description:
      'Which TicketDataPort implementation the agent side uses: `sql` (pooled pg) or `mcp` ' +
      '(CockroachDB MCP server). The web app always uses direct SQL regardless.',
    source: 'Decision, not a credential. Defaults to `sql`; flip to `mcp` once Gate 1 proves auth.',
    gate: 1,
    group: 'cockroachdb',
    defaultValue: 'sql',
  },
  {
    key: 'COCKROACH_MCP_ENDPOINT',
    description: 'CockroachDB managed MCP server endpoint backing McpAdapter.',
    source: 'CockroachDB Cloud console → cluster → MCP / integrations.',
    gate: 1,
    group: 'cockroachdb',
  },
  {
    key: 'COCKROACH_MCP_API_KEY',
    description: 'API key the MCP connector authenticates with.',
    source: 'CockroachDB Cloud console → Access → API keys. Shown once — store it immediately.',
    gate: 1,
    group: 'cockroachdb',
  },

  // ── S3 policy documents ───────────────────────────────────────────────────────────
  {
    key: 'S3_POLICY_BUCKET',
    description: 'Read-only bucket holding the refund, dispute, and generic policy documents.',
    source: 'The bucket you create by hand in docs/PROVISIONING.md step 4.',
    gate: 1,
    group: 'aws',
  },
  {
    key: 'S3_DOCTOR_PROBE_KEY',
    description:
      'Tiny object doctor calls GetObject on to prove read access, since no policy document ' +
      'exists until Gate 4.',
    source: 'Uploaded during docs/PROVISIONING.md step 4. Default `_doctor-probe.json`.',
    gate: 1,
    group: 'aws',
    defaultValue: '_doctor-probe.json',
  },
  {
    key: 'S3_REFUND_POLICY_KEY',
    description: 'Object key of the refund policy document (prose + params).',
    source: 'Uploaded at Gate 4. Default `refund-policy.json`.',
    gate: 4,
    group: 'aws',
    defaultValue: 'refund-policy.json',
  },
  {
    key: 'S3_DISPUTE_POLICY_KEY',
    description: 'Object key of the dispute policy document (prose + params).',
    source: 'Uploaded at Gate 5. Default `dispute-policy.json`.',
    gate: 5,
    group: 'aws',
    defaultValue: 'dispute-policy.json',
  },
  {
    key: 'S3_GENERIC_POLICY_KEY',
    description: 'Object key of the generic policy document.',
    source: 'Uploaded at Gate 4. Default `generic-policy.json`.',
    gate: 4,
    group: 'aws',
    defaultValue: 'generic-policy.json',
  },
  {
    key: 'POLICY_CACHE_TTL_SECONDS',
    description:
      'How long a loaded policy document is served from the module-scope cache before ETag ' +
      'revalidation (ARCHITECTURE.md §6.3).',
    source: 'Tunable. Default 300 (5 minutes).',
    gate: 4,
    group: 'runtime',
    defaultValue: '300',
  },

  // ── Entry point and web app ───────────────────────────────────────────────────────
  {
    key: 'TICKET_HANDLER_FUNCTION_URL',
    description: 'Function URL of the ticket-handler Lambda; the web app posts tickets to it.',
    source: 'Lambda console → ticket-handler → Configuration → Function URL, created at Gate 2.',
    gate: 2,
    group: 'web',
  },
  {
    key: 'WEB_QUEUE_PASSWORD',
    description: 'Single shared password gating /queue. No RBAC by design (ARCHITECTURE.md §13).',
    source: 'Chosen by you at Gate 8. Any strong random string.',
    gate: 8,
    group: 'web',
  },

  // ── Runtime tunables ──────────────────────────────────────────────────────────────
  {
    key: 'LOG_LEVEL',
    description: 'Minimum level emitted by the structured logger.',
    source: 'Tunable. One of debug | info | warn | error. Default `info`.',
    gate: 1,
    group: 'runtime',
    defaultValue: 'info',
  },
] as const;

const BY_KEY = new Map(CONFIG_MANIFEST.map((spec) => [spec.key, spec]));

export function findSpec(key: string): ConfigVarSpec | undefined {
  return BY_KEY.get(key);
}

export function specsForGate(gate: number): readonly ConfigVarSpec[] {
  return CONFIG_MANIFEST.filter((spec) => spec.gate <= gate);
}
