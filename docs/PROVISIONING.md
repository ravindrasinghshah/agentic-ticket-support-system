# PROVISIONING.md — the by-hand runbook

**There is no infrastructure as code.** Every AWS and CockroachDB resource in this system is
created by hand from this document, and `pnpm doctor` **verifies but never creates**
(ARCHITECTURE.md §13, plan.md "Provisioning: manual by design").

Accepted trade-offs, stated so they are not surprises later: rebuilding an environment is a
manual exercise, configuration can drift from this runbook, and teardown is a checklist rather
than one command. **`pnpm doctor` is the mitigation** — it is the executable statement of what
the infrastructure should look like, so drift is *detected* even though it is not *prevented*.

> **Treat a doctor failure as authoritative: fix the environment, don't loosen the check.**
> And this document must contain every resource actually created, or rebuilding is impossible.

## How to use this

Each gate opens with a *Provision first* list. Do those steps, then run `pnpm doctor` and fix
whatever it reports before writing code. The doctor's remediation text is the short form of
everything below; this document is the long form with the console paths.

```bash
cp .env.example .env
pnpm install
pnpm check:config    # what is outstanding right now
pnpm doctor          # the same, plus live verification
```

---

# Gate 1 — Infrastructure verification

Six steps. Nothing here creates schema; the cluster stays empty.

## Step 1 — Choose the region

The constraint is that **one** region must offer all three of:

- Bedrock, with access grantable to your chosen supervisor model
- **AgentCore** (Runtime, Memory, and Gateway) — availability is limited, and this is the
  binding constraint in practice
- CockroachDB Cloud connectivity (any region works; keep it geographically close)

Set `AWS_REGION` in `.env`. If AgentCore turns out to be unavailable there, `pnpm doctor`'s
`agentcore-available` check says so explicitly rather than letting you discover it at Gate 2.

→ yields **`AWS_REGION`**

## Step 2 — AWS credentials

Create or reuse an IAM principal with programmatic credentials.

```bash
aws configure --profile ats           # then set AWS_PROFILE=ats in .env
aws sts get-caller-identity --query Account --output text
```

→ yields **`AWS_ACCOUNT_ID`**, and optionally **`AWS_PROFILE`**

The doctor asserts the caller resolves to the account you configured. That check exists because
pointing at the wrong account is silent — every later check would pass or fail against the
wrong environment.

## Step 3 — Bedrock model access and IAM

**3a. Resolve the model ID from the live service.** Never use one recalled from memory:

```bash
aws bedrock list-foundation-models --region $AWS_REGION --query "modelSummaries[].modelId"
```

**3b. Grant access.** Bedrock console → **Model access** → *Modify model access* → select the
supervisor model → submit. Wait until it shows **Access granted** (usually instant).

**3c. Attach IAM permissions** to the principal from step 2:

| Action | Why |
|---|---|
| `bedrock:ListFoundationModels` | doctor's reachability check |
| `bedrock:InvokeModel` | the supervisor, and the doctor's access probe |
| `bedrock-agentcore:ListAgentRuntimes`, `ListMemories`, `ListGateways` | doctor's AgentCore check |
| `sts:GetCallerIdentity` | always allowed; listed for completeness |

→ yields **`BEDROCK_SUPERVISOR_MODEL_ID`**

> Listing a model does **not** mean you can invoke it. The doctor deliberately probes with a
> real one-token `Converse` call, because `ListFoundationModels` returns models the account has
> not been granted — that gap is the single most common day-one failure.

> **Not needed yet:** the embedding model. It is user-specified at Gate 6 and deliberately not
> chosen here (ARCHITECTURE.md §9.2). The doctor reports its check as SKIPPED until then.

## Step 4 — S3 policy bucket

```bash
aws s3 mb s3://<your-policy-bucket> --region $AWS_REGION

# The doctor probe object — no policy document exists until Gate 4, and ListBucket alone
# does not prove GetObject works. They are separate permissions.
echo '{"probe":true}' > _doctor-probe.json
aws s3 cp _doctor-probe.json s3://<your-policy-bucket>/_doctor-probe.json
rm _doctor-probe.json
```

Grant the principal `s3:ListBucket` on `arn:aws:s3:::<bucket>` and `s3:GetObject` on
`arn:aws:s3:::<bucket>/*`. Keep the bucket in the same region as everything else — every policy
load at Gates 4 and 5 pays cross-region latency otherwise.

→ yields **`S3_POLICY_BUCKET`** (and `S3_DOCTOR_PROBE_KEY`, whose default is fine)

## Step 5 — CockroachDB Cloud cluster

1. Create a cluster in the CockroachDB Cloud console. **Create no schema** — Gate 2 creates the
   first three tables, and each gate after that adds only what it needs.
2. Create a SQL user. **The password is shown once** — copy it immediately.
3. Cluster → **Connect** → *General connection string*. Copy it, and download the CA
   certificate (`cc-ca.crt`) offered in the same dialog. Save the certificate outside the repo,
   or under `certs/` which is gitignored.
4. Cluster → **Networking** → *IP allowlist*: add the address you will run from. A serverless
   cluster also sleeps when idle, so the first connection can take a few seconds.

→ yields **`COCKROACH_DATABASE_URL`**, **`COCKROACH_SSL_ROOT_CERT`**

The doctor connects with `rejectUnauthorized: true` against that CA, because that is the
connection the Lambdas will make. If verification fails, fix the certificate path — do not
disable verification to get past it.

**Vector support.** The doctor creates a uniquely-named scratch table with a `VECTOR(3)` column
plus a vector index, then drops it. Nothing is left behind. If either step fails, that must be
resolved before Gate 6 — CockroachDB's distributed vector index is the hackathon's central
claim, and it is in public preview, so it needs confirming on day one rather than five gates in.

## Step 6 — CockroachDB MCP connector

1. CockroachDB Cloud console → cluster → **MCP / integrations**. Copy the MCP server endpoint —
   the streamable-HTTP URL, **not** the SQL connection string.
2. Console → **Access** → *API keys* → create a key. Shown once.

→ yields **`COCKROACH_MCP_ENDPOINT`**, **`COCKROACH_MCP_API_KEY`**

**If this cannot be made to work, that is a finding, not a blocker.** Data access sits behind
`TicketDataPort` with two implementations precisely so this is a config flip
(ARCHITECTURE.md §11). Leave `DB_ACCESS_MODE=sql`, record the outcome in
[PROGRESS.md](PROGRESS.md), and continue — Gate 3 will then skip the `McpAdapter` integration
suite *explicitly*, with the Gate 1 finding cited, rather than silently.

## Gate 1 done when

```bash
pnpm doctor           # all-green
pnpm test:gate 1      # green, with zero credentials and zero network
```

Every gap you had to fix should have been surfaced *by the tool*, not discovered by hand. If
you fixed something the doctor did not catch, add a check for it before closing the gate.

---

# Gate 2 — Supervisor + Context Clerk

*Provision first:*

- **AgentCore Memory resource** — Bedrock console → AgentCore → Memory → create.
  → `AGENTCORE_MEMORY_ID`
- **AgentCore Runtime target** for the smoke deploy. → `AGENTCORE_RUNTIME_ARN`
- **Lambda execution role** with CockroachDB network access and `logs:CreateLogGroup`,
  `logs:CreateLogStream`, `logs:PutLogEvents`.
- **`ticket-handler` Lambda + Function URL.** → `TICKET_HANDLER_FUNCTION_URL`

# Gate 3 — Tracking specialist

*Provision first:* AgentCore **Gateway** (→ `AGENTCORE_GATEWAY_URL`), its inbound
authentication configuration (→ `AGENTCORE_GATEWAY_AUTH_MODE`, and
`AGENTCORE_GATEWAY_AUTH_TOKEN` if not IAM), and the tracking Lambda registered as a Gateway
target.

# Gate 4 — Refund specialist

*Provision first:* `refund-policy.json` uploaded to the policy bucket; refund Lambda registered
with the Gateway; `s3:GetObject` scoped to that bucket on the Lambda role.

# Gate 5 — Dispute specialist

*Provision first:* `dispute-policy.json` uploaded; dispute Lambda registered with the Gateway;
same `s3:GetObject` scope.

# Gate 6 — Full schema and the vector memory layer

*Provision first:* **access approved for the user-specified embedding model** in the target
region, and the doctor's embedding check flipped from SKIPPED to a hard check
(`pnpm doctor --gate 6`). If Gate 1's `VECTOR` check was skipped or failed, resolve it before
starting — everything in this gate depends on it.

# Gate 8 — UI

*Provision first:* the Function URL reachable from wherever the web app runs; the web app's
environment carrying `COCKROACH_DATABASE_URL` and AWS credentials (its server routes write
status changes and call the embedding model directly); and `WEB_QUEUE_PASSWORD` set.

---

# Teardown checklist

No `cdk destroy` — this is the accepted cost of manual provisioning. Delete in this order:

1. AgentCore Gateway targets, then the Gateway
2. AgentCore Runtime, then the Memory resource
3. Lambda functions (the Function URL goes with `ticket-handler`) and their log groups
4. The S3 policy bucket (empty it first: `aws s3 rm s3://<bucket> --recursive`)
5. The CockroachDB Cloud cluster
6. The IAM role/user and its policies
7. Any local `.env` and `certs/` — they hold live credentials

Confirm nothing billable remains in the AWS Billing console for the region.
