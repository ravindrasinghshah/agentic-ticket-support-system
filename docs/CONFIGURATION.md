# CONFIGURATION.md — every placeholder and where its real value comes from

Every value this system reads from its environment is listed here. The machine-readable
source of truth is [`packages/core/src/manifest.ts`](../packages/core/src/manifest.ts); a
contract test in `tests/gate-1/contract/config-consistency.test.ts` fails the build if this
document, `.env.example`, and that manifest ever drift apart.

**Why this document carries extra weight.** Provisioning is manual — there is no IaC — so this
is the only inventory of what was created by hand. See
[PROVISIONING.md](PROVISIONING.md) for the ordered runbook that produces these values.

## How configuration behaves

- **One module reads `process.env`:** `packages/core/src/config.ts`. Nothing else — enforced by
  a test, not by convention. So the complete set of required configuration is knowable by
  reading one file.
- **`REPLACE_ME` is a sentinel, not a value.** Greppable, and impossible to mistake for a real
  setting.
- **Resolution fails loudly.** `config.get(KEY)` throws a `ConfigurationError` naming the
  variable, restating what it is, saying where to obtain it, and pointing here. A placeholder
  must never reach an AWS or database call and surface as a confusing downstream error.
- **The audit never throws.** `config.audit(gate)` reports what is outstanding. That is what
  `pnpm check:config` prints.
- **Gates scope what is required.** A variable is only demanded from the gate listed in its
  **Gate** column, so a Gate 6 decision never blocks Gate 1.

```bash
cp .env.example .env      # then fill in the REPLACE_ME values
pnpm check:config         # what is still outstanding, and where to get each one
pnpm doctor               # the same check plus live infrastructure verification
pnpm doctor --gate 6      # what will be required once you reach Gate 6
```

---

## AWS account and region

| Variable | Gate | What it is | Where the real value comes from |
|---|---|---|---|
| `AWS_REGION` | 1 | Region hosting Bedrock, AgentCore, Lambda, and the policy bucket. | Pick a region offering **both** Bedrock model access and AgentCore — AgentCore's regional availability is limited, which is why `pnpm doctor` checks it on day one. PROVISIONING step 1. |
| `AWS_ACCOUNT_ID` | 1 | 12-digit account ID. The doctor asserts your resolved caller matches it. | `aws sts get-caller-identity --query Account --output text` |
| `AWS_PROFILE` | 1 | *Optional.* Named credentials profile. Omit to use the default AWS credential chain. | The profile name you passed to `aws configure --profile <name>`. |

> If you use environment credentials instead of a profile, set `AWS_ACCESS_KEY_ID` /
> `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN` for temporary credentials) in your shell.
> Those are read by the AWS SDK's own credential chain, not by this system's config module,
> which is why they are not manifest entries.

## Bedrock and AgentCore

| Variable | Gate | What it is | Where the real value comes from |
|---|---|---|---|
| `BEDROCK_SUPERVISOR_MODEL_ID` | 1 | Foundation model the supervisor reasons with. | **Resolve from the live service, never from memory:** `aws bedrock list-foundation-models --region $AWS_REGION --query "modelSummaries[].modelId"`. Then grant access in Bedrock console → Model access. Some models are only invocable through an *inference profile* ID rather than the bare model ID — the doctor's Converse probe will tell you. |
| `EMBEDDING_MODEL_ID` | 6 | The model producing every vector in `resolutions`. | **A blocking user decision at Gate 6 — never defaulted.** See below. |
| `EMBEDDING_DIM` | 6 | That model's output dimension. Sets the `VECTOR(n)` column width. | Same decision. See below. |
| `AGENTCORE_RUNTIME_ARN` | 2 | Runtime hosting the TypeScript supervisor. | Bedrock console → AgentCore → Runtimes, after you create it. |
| `AGENTCORE_MEMORY_ID` | 2 | Memory resource holding session state keyed by `conversation_id`. | Bedrock console → AgentCore → Memory. |
| `AGENTCORE_GATEWAY_URL` | 3 | Gateway MCP endpoint publishing the specialist Lambdas as tools. | Bedrock console → AgentCore → Gateways. |
| `AGENTCORE_GATEWAY_AUTH_MODE` | 3 | How the supervisor authenticates to the Gateway. Defaults to `iam`. | Determined by the Gateway's inbound auth configuration, settled at Gate 3. |
| `AGENTCORE_GATEWAY_AUTH_TOKEN` | 3 | *Optional.* Bearer token or OAuth client secret when the mode is not `iam`. | The identity provider configured for the Gateway. |

### ⛔ The embedding model is user-specified — never assumed

`EMBEDDING_MODEL_ID` and `EMBEDDING_DIM` stay `REPLACE_ME` until Gate 6, when the user supplies
them. The doctor's embedding check reports **SKIPPED** until then and becomes a hard check
from Gate 6 onward, specifically so a guessed model can never become a de facto decision.

Why this one is blocking rather than default-and-revisit (ARCHITECTURE.md §9.2): every stored
vector comes from one model. Vectors from different models are not comparable, so a later
change **corrupts similarity search without raising an error** — the failure looks like
"retrieval got worse", not like a bug. The only remedy is re-embedding every row. Getting it
wrong is silent and expensive; asking costs one message.

Three things must be captured: the **model identifier** (resolved from the live service), its
**output dimension**, and — if the model offers several — **which dimension to use**.

## CockroachDB

| Variable | Gate | What it is | Where the real value comes from |
|---|---|---|---|
| `COCKROACH_DATABASE_URL` | 1 | `postgresql://` connection string. | CockroachDB Cloud console → cluster → **Connect** → General connection string. Note the port is **26257**, not 5432. |
| `COCKROACH_SSL_ROOT_CERT` | 1 | Absolute path to the cluster CA certificate, for `sslmode=verify-full`. | `cc-ca.crt`, downloaded from the same Connect dialog. Store it outside the repo, or under `certs/` which is gitignored. |
| `DB_ACCESS_MODE` | 1 | Which `TicketDataPort` implementation the agent side uses: `sql` or `mcp`. Defaults to `sql`. | A decision, not a credential. Keep `sql` unless Gate 1's `cockroachdb-mcp-connector` check proves MCP auth works from this environment. The web app always uses direct pooled SQL regardless. |
| `COCKROACH_MCP_ENDPOINT` | 1 | The managed MCP server endpoint backing `McpAdapter`. | CockroachDB Cloud console → cluster → MCP / integrations. This is the streamable-HTTP MCP URL, **not** the SQL connection string. |
| `COCKROACH_MCP_API_KEY` | 1 | API key the MCP connector authenticates with. | CockroachDB Cloud console → Access → API keys. Shown once at creation — store it immediately. |

## S3 policy documents

| Variable | Gate | What it is | Where the real value comes from |
|---|---|---|---|
| `S3_POLICY_BUCKET` | 1 | Read-only bucket holding the policy documents. | The bucket you create by hand. PROVISIONING step 4. |
| `S3_DOCTOR_PROBE_KEY` | 1 | Tiny object the doctor calls `GetObject` on. Defaults to `_doctor-probe.json`. | Uploaded during PROVISIONING step 4. It exists because no policy document exists until Gate 4, and `ListBucket` alone does not prove the Lambdas will be able to *read* an object. |
| `S3_REFUND_POLICY_KEY` | 4 | Object key of the refund policy document. Defaults to `refund-policy.json`. | Uploaded at Gate 4. |
| `S3_DISPUTE_POLICY_KEY` | 5 | Object key of the dispute policy document. Defaults to `dispute-policy.json`. | Uploaded at Gate 5. |
| `S3_GENERIC_POLICY_KEY` | 4 | Object key of the generic policy document. Defaults to `generic-policy.json`. | Uploaded at Gate 4. |
| `POLICY_CACHE_TTL_SECONDS` | 4 | Seconds a loaded policy document is cached before ETag revalidation. Defaults to `300`. | Tunable. |

**Policy thresholds are not configuration.** Dollar limits and day windows live in the `params`
block *inside* each policy document in S3, never in `.env` and never in code — so editing a
document changes verdicts and explanations atomically, with no redeploy (ARCHITECTURE.md §6.3).

## Entry point and web app

| Variable | Gate | What it is | Where the real value comes from |
|---|---|---|---|
| `TICKET_HANDLER_FUNCTION_URL` | 2 | Function URL the web app posts tickets to. | Lambda console → `ticket-handler` → Configuration → Function URL. |
| `WEB_QUEUE_PASSWORD` | 8 | Single shared password gating `/queue`. No RBAC by design (ARCHITECTURE.md §13). | Chosen by you. Any strong random string. |

> The web app's server routes write status changes and call the embedding model directly, so
> their environment needs `COCKROACH_DATABASE_URL` and AWS credentials too — not just these two.

## Runtime tunables

| Variable | Gate | What it is | Default |
|---|---|---|---|
| `LOG_LEVEL` | 1 | Minimum level the structured logger emits: `debug`, `info`, `warn`, `error`. | `info` |

## Test-only

| Variable | What it does |
|---|---|
| `RUN_INTEGRATION` | Set to `1` by `pnpm test:integration` — the single switch that lets a test touch the network. Never set it in `.env`. |

---

## Adding a new variable

1. Add a `ConfigVarSpec` to `packages/core/src/manifest.ts` with a real `description`,
   `source`, and `gate`.
2. Add a typed accessor to `AppConfig` in `config.ts`. Do not read it via `get()` from call
   sites — the typed surface is what makes the configuration knowable.
3. Add the key to `.env.example`, with `REPLACE_ME` unless it has a safe default.
4. Document it in the right table above.

Steps 3 and 4 are enforced by `tests/gate-1/contract/config-consistency.test.ts`, so skipping
them fails the build rather than rotting quietly.
