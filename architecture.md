# ARCHITECTURE.md — Agentic Ticket Support System

> **Runtime override (2026-08-10):** The AgentCore hosting, memory, and gateway details below are
> superseded for the current v1 because the target AWS account cannot use Bedrock AgentCore. The
> active runtime is the asynchronous Lambda/SQS design using Strands with Groq, documented in `Backend/README.md`, and
> deployed by the TypeScript CDK app in `Backend/infrastructure`; orchestration state and tool results are durable in
> CockroachDB through typed MCP operations. The business rules and ticket lifecycle below remain
> the target product behavior.

**This is the authoritative technical specification.** If any other document (including the
original diagram) conflicts with this file, this file wins. The plan of record and build order
live in [plan.md](plan.md); the visual companion is
[agentic-ticket-system.png](agentic-ticket-system.png).

> An earlier `architecture.md` in this repo's git history describes a superseded design
> (Intent/Memory/Resolution/Tool/Response agents). It must not be used. This document replaces it.

---

## 1. System purpose

A multi-agent customer support platform for e-commerce-style tickets — order tracking, refunds,
disputes — built for the CockroachDB × AWS Hackathon, *"Build the Future of Agentic Memory."*

The differentiator is **continuously learning memory**: every ticket outcome — agent-resolved,
customer-rejected, or human-resolved — is embedded and written back to CockroachDB, so future
tickets retrieve and benefit from it. A rejection plus the customer's stated reason is treated as
learning signal, not discarded failure.

## 2. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript, everywhere (app, Lambdas, supervisor) |
| AI orchestration | **Amazon Bedrock AgentCore Runtime** hosting a TypeScript supervisor agent |
| Specialist execution | AWS Lambda specialist-agent modules, exposed to the supervisor as AgentCore Gateway/MCP tools |
| Entry point | Lambda **Function URL** (not API Gateway — avoids its 29 s integration timeout) |
| Active agent memory | **Amazon Bedrock AgentCore Memory** — session-scoped workflow state owned by the supervisor and supplied to specialist calls when needed |
| Durable memory & data | **CockroachDB Cloud** — operational system of record + distributed vector index |
| Embeddings | **Model to be specified by the user at Gate 6 — do not assume one.** Whichever is chosen: exactly one model, one dimension, enforced by a shared constant and a runtime length assertion |
| Policy documents | S3, read-only |
| Observability | CloudWatch structured logs |
| Web app | Next.js — public submit flow + gated human queue |
| Provisioning | **Manual** — AWS console / CLI, following a written runbook. No IaC (deliberate hackathon scope; see §13). Verified by `pnpm doctor`, never created by it |
| Monorepo | pnpm workspaces, Vitest |

## 3. Component map

```
 Customer                                        Human agent
    │                                                 │
    ▼                                                 ▼
 /submit (public)                          /queue (password-gated)
 email match + order picker                escalated + unresolved tickets
 /ticket/[id]?t=<token>                    /queue/[id] — reply form
    │        ▲                                        │
    ▼        │ reply, accept / reject      ───────────┘
 ┌──────────────────────────────────────────────────────────┐
 │  Next.js app                                             │
 │  server routes: submit, accept, reject, human-reply      │
 │  (SQL via packages/db, embeddings via packages/agents)   │
 └──────────────────────────────────────────────────────────┘
    │ POST ticket_id
    ▼
 ticket-handler Lambda (Function URL)
    │ InvokeAgentRuntime (sessionId = conversation_id)
    ▼
 Bedrock AgentCore Runtime — TypeScript Orchestrator / Supervisor
    │       │
    │       └── AgentCore Memory (conversation_id): active plan, tool outputs,
    │           context-loaded flag, cycle count, and hand-off state
    │
    └── AgentCore Gateway (MCP tools)
         ├── context specialist Lambda    ─┐
         ├── tracking specialist Lambda   ├─► TicketDataPort ──► CockroachDB
         ├── refund specialist Lambda     │      (SqlAdapter |      │
         └── dispute specialist Lambda    ─┘       McpAdapter)       │
                                        │                                         │
                                        ▼                                         ▼
                                   S3 (read-only                        vector index on
                                   policy documents)                    resolutions.embedding

 CloudWatch ◄── structured logs from the AgentCore supervisor and every Lambda, keyed by ticket_id + conversation_id
```

## 4. The agents and memory

The **TypeScript supervisor agent** runs in Amazon Bedrock AgentCore Runtime. It uses a Bedrock
foundation model for reasoning: it analyzes the ticket, forms a plan chasing the objective *"do I
have everything I need to respond to this ticket and achieve resolution?"*, calls specialists,
re-evaluates after every response, and either assembles a customer-friendly reply or escalates.

The supervisor uses **AgentCore Memory** for the active, session-scoped agent state keyed by
`conversation_id`: the request and plan, context-loaded status, bounded cycle count, specialist
outputs, and response hand-off. This is the working memory used while coordinating agents; it is
not the durable business or learning-memory system of record. Tickets, conversation history,
orchestration safety state, resolutions, and vectors remain in CockroachDB so they are queryable,
auditable, and retained independently of an AgentCore session.

The four specialists are Lambda-backed **agent modules**. AgentCore Gateway publishes them as MCP
tools; the supervisor invokes those tools. They are not separate AgentCore Runtime supervisors.

### 4.1 Context agent — mandatory first call

The supervisor must call this before any other specialist tool (enforcement in §5).

- **Tools:** ticket lookup, conversation history, resolution-embedding similarity search
- **Input:** `ticket_id`, `conversation_id`
- **Does:** stamps `orchestration_state.context_called_at`; loads the ticket, its customer, its
  linked order (if any); runs a similarity search over past resolutions (§8)
- **Returns:**

```json
{
  "ticket":  { "id": "…", "title": "…", "description": "…", "status": "open" },
  "customer": { "id": "…", "name": "…", "email": "…" },
  "order":   { "id": "…", "status": "shipped", "orderValueCents": 24999,
               "createdAt": "…", "shippedAt": "…", "receivedAt": null },
  "similarResolutions": [
    { "summary": "…", "outcome": "resolved", "source": "human", "similarity": 0.91 }
  ]
}
```

`order` is `null` when the ticket has no linked order — specialists must treat order-specific
questions as escalations in that case.

### 4.2 Tracking specialist

- **Tools:** order history, tracking status (via `TicketDataPort`)
- **Returns:** the order's current status and timeline in structured form. No policy decisions.

```json
{ "orderId": "…", "status": "shipped", "shippedAt": "…", "estimatedNarrative": "…" }
```

### 4.3 Refund specialist

- **Docs:** refund policy from S3 (read-only; prose + params, §6.3)
- **Does:** loads current `PolicyParams` (TTL-cached), calls
  `evaluateRefund(order, request, now, params)` from `packages/policy` (§6). The LLM never
  decides eligibility — it only explains the deterministic verdict, citing the current policy
  prose.
- **Returns:**

```json
{ "verdict": "auto_approve" | "escalate", "reasonCode": "WITHIN_7_DAYS_PRE_SHIPMENT",
  "policyCitation": "…", "explanation": "…" }
```

On `escalate`, the Lambda itself sets `tickets.status = 'escalated'` (deterministic side
effect, not left to the LLM).

### 4.4 Dispute specialist

- **Docs:** dispute policy from S3 (read-only; prose + params, §6.3)
- **Does:** loads current `PolicyParams`, calls `evaluateDispute(dispute, now, params)`. On
  `auto_resolve`, drafts a response informed by
  the similar past resolutions the context agent retrieved. On `escalate`, sets
  `tickets.status = 'escalated'` directly.
- **Returns:**

```json
{ "verdict": "auto_resolve" | "escalate", "reasonCode": "UNDER_300_THRESHOLD",
  "draftResponse": "…", "informedBy": ["resolution-id-1", "resolution-id-2"] }
```

## 5. Orchestration contract — invariants and their enforcement

The supervisor instruction prompt and AgentCore Memory state record all three rules below so the
agent usually complies unaided. But
prompts are requests, not guarantees — so each invariant also has a code-level backstop. The
backstops are what get unit-tested.

**State:** one `orchestration_state` row per `(ticket_id, conversation_id)`:
`context_called_at TIMESTAMPTZ NULL`, `cycle_count INT NOT NULL DEFAULT 0`.

| # | Invariant (diagram note) | Enforcement |
|---|---|---|
| 1 | Context agent is always called first (note 4) | Supervisor reads/writes `contextLoaded` in AgentCore Memory and is instructed to call Context first. Every specialist Lambda's first step is the durable backstop: if `context_called_at IS NULL`, return `{ "error": "CONTEXT_REQUIRED", "instruction": "Call the context specialist first." }` and do no work. The context Lambda stamps the timestamp. |
| 2 | At most 3 plan→call→evaluate cycles before escalating (note 10) | `cycle_count` increments on **every specialist (non-context) invocation**. A specialist invoked when `cycle_count >= 3` performs no work, sets `tickets.status = 'escalated'`, and returns `{ "error": "CYCLE_LIMIT", "instruction": "Escalate to a human and inform the customer." }`. *"Cycle" is defined as specialist invocations because that is the only thing a Lambda can observe — the closest enforceable proxy for the diagram's "plan call evaluate cycle."* |
| 3 | Never force a resolution the system doesn't have (note 7) | Post-hoc safety net in `ticket-handler`: if the AgentCore runtime returns an empty/blank response, or finishes with the ticket still `open` and no verdict recorded, the handler sets `status = 'escalated'` and substitutes a "your ticket has been escalated to a human" reply. |

The entry Lambda invokes the AgentCore runtime with `sessionId = conversation_id`. AgentCore
Memory retrieves and persists the active coordination state for that session; relevant state is
passed to specialists only when needed. Specialist Lambdas remain independently stateless between
invocations and must rely on CockroachDB for durable safety and business state.

## 6. Deterministic policy rules

Implemented as pure functions in `packages/policy` — zero I/O, zero LLM. The LLM's only role is
explaining the verdict. Source: diagram notes 17–18, with boundary semantics pinned down here.

**The thresholds are not hardcoded.** Policy values (dollar limits, day windows) live in the S3
policy documents — which get edited over time — so the engines take them as an explicit
`PolicyParams` argument: `evaluateRefund(order, request, now, params)`. The tables below show
the **v1 defaults**; the loading and refresh mechanism is §6.3. The functions themselves stay
pure: all I/O (loading params) happens in the calling Lambda, never inside the engine.

**Boundary semantics (normative):**
- *"within N days of X"* means `now − X ≤ N × 24h`, **inclusive** — exactly N days still
  qualifies.
- *"< $300"* is **strictly less than** 30 000 cents — exactly $300.00 does **not** qualify.
- All comparisons in UTC; `now` is injected into the function (never read from the clock inside)
  so tests are deterministic.

### 6.1 `evaluateRefund(order, request, now)`

Rules evaluated in order; first match wins.

| # | Order status | Order value | Time condition | Verdict | Reason code |
|---|---|---|---|---|---|
| R1 | not yet shipped (`processing`) | any | `now − order.created_at ≤ 7 days` | `auto_approve` | `WITHIN_7_DAYS_PRE_SHIPMENT` |
| R2 | `shipped_back_to_sender` | `< $300` | `now − order.received_at ≤ 30 days` | `auto_approve` | `RETURNED_UNDER_300_WITHIN_30_DAYS` |
| R3 | anything else (incl. no linked order, `received_at` null in R2) | — | — | `escalate` | `REFUND_POLICY_ESCALATION` |

Mandatory test boundaries: day 6 / **7** / 8 for R1; day 29 / **30** / 31 and $299.99 /
**$300.00** / $300.01 for R2; every `order_history.status` value through R3.

### 6.2 `evaluateDispute(dispute, now)`

| # | Dispute value | Verdict | Reason code |
|---|---|---|---|
| D1 | `< $300` | `auto_resolve` — respond, informed by similar past dispute resolutions | `UNDER_300_THRESHOLD` |
| D2 | `≥ $300` or no linked order | `escalate` | `OVER_300_THRESHOLD` |

Mandatory test boundaries: $299.99 / **$300.00** / $300.01.

### 6.3 Policy documents as single source of truth — loading and refresh

Each policy object in S3 is one JSON document pairing the human-editable prose with the
machine-readable parameters, so the two can never drift apart in separate files:

```json
{
  "version": 3,
  "updatedAt": "2026-07-25T00:00:00Z",
  "params": {
    "preShipmentRefundWindowDays": 7,
    "returnedRefundWindowDays": 30,
    "autoApprovalLimitCents": 30000
  },
  "prose": "## Refund Policy\n\nRefunds requested before shipment …"
}
```

- **One consumer, two uses.** The specialist Lambda loads the document once per (cached) fetch:
  `params` feeds the deterministic engine; `prose` is what the LLM quotes and explains from. An
  edited policy therefore changes *both* the verdicts and the explanations, atomically.
- **Refresh without redeploy.** The loader caches at module scope with a short TTL (default
  5 minutes) and revalidates by S3 ETag — editing a policy document takes effect within the TTL
  on every warm Lambda, and immediately on cold starts. No code deploy or supervisor-runtime
  change.
- **Validated on load, fail loudly.** `params` is schema-validated (zod); a missing or malformed
  field throws with the S3 key and field name rather than silently falling back to stale or
  default values. The last-known-good copy is kept in the module cache so a transient S3 failure
  degrades to slightly-stale policy, never to no policy.
- **Auditable verdicts.** Every verdict log line and every `resolutions` row records the policy
  `version` that produced it, so a decision can always be traced to the policy text in force at
  the time.
- **The supervisor prompt stays policy-free.** The AgentCore supervisor's instruction prompt contains
  routing behavior only — *never* thresholds, windows, or amounts. All policy content reaches
  the LLM at request time through the specialist's response (verdict + current prose). This is
  deliberate: changing policy must be a content-only operation, not a supervisor deployment, so
  nothing that changes with policy edits is allowed to live there.

## 7. Ticket lifecycle

```
                       submit (web)
                            │
                            ▼
                         ┌──────┐
        agent chain ────►│ open │
                         └──┬───┘
             ┌──────────────┼─────────────────────┐
             │ agent reply  │ escalate verdict /   │
             ▼              │ cycle guard /        │
   ┌───────────────────┐    │ safety net           │
   │ awaiting_customer │    └──────────►┌───────────┐
   └───┬───────────┬───┘                │ escalated │
       │ accept    │ reject + comments  └─────┬─────┘
       ▼           ▼                          │ human reply
 ┌──────────┐ ┌────────────┐                  │
 │ resolved │ │ unresolved │──── human reply ─┤
 │ (agent)  │ └────────────┘                  ▼
 └──────────┘                          ┌──────────┐
                                       │ resolved │
                                       │ (human)  │
                                       └──────────┘
```

- **`open`** — submitted; agent chain in progress.
- **`awaiting_customer`** — agent replied; customer must accept or reject. Set by
  `ticket-handler` after a successful (non-escalated) chain.
- **`resolved`** — terminal. `resolutions.source` records `'agent'` or `'human'`.
- **`unresolved`** — customer rejected the agent's answer, with mandatory comments. Appears in
  the human queue alongside `escalated`.
- **`escalated`** — the system chose not to answer (policy verdict, cycle guard, or safety net).

Human queue = `status IN ('escalated', 'unresolved')`. A human reply from the queue always
transitions to `resolved` with `source = 'human'`. Every terminal or queue-entering event
(accept, reject, human reply) writes a `resolutions` row and embeds it (§9).

## 8. Customer flow and access control

1. **Submit:** the public form takes email, title, description. The server route matches the
   email against `customers` (case-insensitive); on match it lists that customer's orders so the
   customer picks the one the ticket concerns → `tickets.order_id`. An unknown email creates a
   customer row with no orders — order-specific questions on such tickets escalate via R3/D2.
2. **Token:** submit generates `tickets.access_token` (cryptographically random, e.g. 32 bytes
   base64url). The ticket URL — `/ticket/[id]?t=<token>` — is the customer's only credential.
   Every customer-facing read/accept/reject route compares tokens with a constant-time check and
   returns 404 on mismatch (not 403 — don't confirm the ticket exists).
3. **Wait on page:** the browser holds the submit request while the chain runs (~30–90 s),
   showing progress, then renders the agent's reply with accept / reject-with-comments inline.
   *Known risk:* if real CP9 latency exceeds browser/Function-URL comfort, fall back to polling
   the tokenized ticket route — same token model, no schema change.
4. **Return visits:** the same tokenized link shows current status — including the human's reply
   once an escalated/unresolved ticket is answered.
5. **Human queue:** `/queue` is gated by a single shared password (env var). No RBAC; anyone
   past the gate can see and answer every queued ticket. Deliberate hackathon scope.

## 9. Learning loop

Write path (shared functions in packages, consumed by both `ticket-handler` and the Next.js
server routes):

| Event | Writes |
|---|---|
| Agent replies | `conversation_history` row (`role='agent'`); ticket → `awaiting_customer` |
| Customer accepts | ticket → `resolved`; `resolutions` row: `outcome='resolved'`, `source='agent'` → **embed** |
| Customer rejects | ticket → `unresolved`; `resolutions` row: `outcome='unresolved'`, `source='agent'`, `rejection_comments` = customer's stated reason → **embed** |
| Human replies | ticket → `resolved`; `conversation_history` row (`role='human_agent'`); `resolutions` row: `outcome='resolved'`, `source='human'` → **embed** |

**Embed** = summarize the ticket + conversation + outcome into `resolutions.content`, generate an
embedding with the **user-specified embedding model** (§9.2), store it in `resolutions.embedding`. Both
good and bad outcomes are embedded (diagram note 13) — the rejection comments are the system's richest
learning signal.

**Retrieval** (context agent): cosine similarity via the CockroachDB vector index, always with a
`LIMIT` (default 5), ordered by similarity with recency as tiebreak. Optional filters on
`outcome`/`source` (e.g. the dispute specialist prefers `outcome='resolved'` precedents).
Unbounded or unfiltered scans of the embedding column are forbidden.

### 9.2 The embedding model is user-specified — never assumed

**The embedding model is an open decision, supplied by the user at Gate 6.** Do not select one, and do
not default to a familiar option. Until it is specified, the model identifier and the vector dimension
are **placeholders** (`REPLACE_ME`), and any dimension appearing in this document — including
`VECTOR(1024)` in §10 — is **illustrative only**.

What is fixed regardless of which model is chosen:

- **Exactly one model, one dimension, for the entire `resolutions` table.** Vectors from different
  models are not comparable; mixing them silently corrupts similarity search rather than erroring.
  There is no migration path short of re-embedding every row, so this is decided once.
- **`EMBEDDING_DIM` is a single exported constant** in `packages/core`, consumed by *both* the DDL and
  the embedding client — never written twice.
- **Runtime length assertion on every embed call**, comparing the actual returned vector length against
  `EMBEDDING_DIM`, so a model or dimension change fails fast instead of writing corrupt data.
- **CockroachDB stores and searches vectors; it does not generate them.** The chosen model — Bedrock-
  hosted or otherwise — produces them, behind an `EmbeddingClient` interface so the provider is swappable
  without touching retrieval logic.

Three things must be captured when the user specifies the model: its **identifier**, its **output
dimension**, and — if the model supports several dimensions — **which one to use**.

### 9.1 Two memory writes, deliberately separate

Closing a conversation writes **two different records**, and conflating them would break retrieval:

| | `resolutions` (the embedding) | `agent_runs` (the reasoning trace) |
|---|---|---|
| Answers | *What was the problem, and how was it solved?* | *How did the supervisor get there?* |
| Contents | Ticket + conversation + outcome summary, vectorized | Plan formed, specialists consulted in order, verdicts, reason codes, policy version, cycles used |
| Role in search | **Is** the search surface — what similarity matches against | Retrieved **alongside** a match; never part of matching |

The trace must **never** be folded into `resolutions.content` or `resolutions.embedding`. The
embedding's job is to represent the customer's problem; mixing in which internal tools happened to
be called would push two tickets with *identical problems but different tool paths* apart in vector
space, degrading the very retrieval the learning loop depends on.

Why keep the trace at all:

- **Human queue speed (primary).** A human picking up a rejected or escalated ticket sees
  *"consulted Tracking (shipped 9 days ago) → Refund → `REFUND_POLICY_ESCALATION` under policy v3,
  because 9 days exceeds the 7-day pre-shipment window"* instead of re-deriving it. No AI required.
- **Debuggability.** CloudWatch logs expire and can't be queried next to a ticket; this can.
- **Cycle efficiency (secondary).** Over time, evidence that a given ticket shape wastes a
  specialist call — which matters against a hard 3-cycle cap. A bonus, not the justification.

Two guardrails:

1. **The guards never read the trace.** `orchestration_state` remains the sole authority for
   context-first and cycle-cap enforcement (§5). `agent_runs` is write-only from the agent's
   perspective — an archive, not a source of truth. Reading it for control decisions would
   reintroduce the two-sources-of-truth problem the durable guards exist to prevent.
2. **Best-effort, off the critical path.** A failed trace insert must never invalidate a ticket
   outcome or block the customer's reply. Store a **structured summary, not raw tool blobs** — the
   underlying order and ticket records already live in their own tables.

## 10. Data model

CockroachDB. Columns marked **[added]** do not appear in the diagram — rationale in §12.

```sql
CREATE TABLE customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        STRING NOT NULL,
  email       STRING NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_history (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id),
  status             STRING NOT NULL,  -- 'processing' | 'shipped' | 'delivered' | 'shipped_back_to_sender'
  order_value_cents  INT8 NOT NULL,        -- [added] refund/dispute rules need order value
  shipped_at         TIMESTAMPTZ NULL,     -- [added] R1 needs pre-shipment state
  received_at        TIMESTAMPTZ NULL,     -- [added] R2 needs days-since-received
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  order_id      UUID NULL REFERENCES order_history(id),  -- [added] ties ticket to the order under discussion
  title         STRING NOT NULL,
  description   STRING NOT NULL,
  category      STRING NULL,   -- advisory, LLM-assigned; nothing branches on it
  priority      STRING NULL,   -- advisory, LLM-assigned; nothing branches on it
  status        STRING NOT NULL DEFAULT 'open',
                -- 'open' | 'awaiting_customer' | 'resolved' | 'unresolved' | 'escalated'
                -- [added: awaiting_customer, unresolved — diagram lists only three]
  assigned_to   STRING NULL,   -- null until a human picks up a queued ticket
  access_token  STRING NOT NULL,  -- [added] gates public customer routes
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID NOT NULL REFERENCES tickets(id),
  role       STRING NOT NULL,  -- 'customer' | 'agent' | 'human_agent' | 'system'
  message    STRING NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orchestration_state (            -- [added] invariant enforcement, §5
  ticket_id          UUID NOT NULL REFERENCES tickets(id),
  conversation_id    UUID NOT NULL,
  context_called_at  TIMESTAMPTZ NULL,
  cycle_count        INT NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, conversation_id)
);

CREATE TABLE agent_runs (                     -- [added] reasoning trace / audit archive, §9.1
  ticket_id        UUID NOT NULL REFERENCES tickets(id),
  conversation_id  UUID NOT NULL,            -- same key as orchestration_state
  plan_summary     STRING NOT NULL,          -- what the supervisor decided to do
  steps            JSONB NOT NULL,           -- [{ tool, reasonCode, policyVersion, ms }, ...]
  cycles_used      INT NOT NULL,
  outcome          STRING NOT NULL,          -- 'resolved' | 'unresolved' | 'escalated'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, conversation_id)
);
-- Write is BEST-EFFORT and off the critical path: a failed insert here must never
-- invalidate a ticket outcome. Never read by the §5 guards — archive only.

CREATE TABLE resolutions (                    -- materializes the diagram's "Resolution embeddings"
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id           UUID NOT NULL REFERENCES tickets(id),
  content             STRING NOT NULL,        -- summary of ticket + conversation + outcome
  outcome             STRING NOT NULL,        -- 'resolved' | 'unresolved'
  source              STRING NOT NULL,        -- 'agent' | 'human'
  rejection_comments  STRING NULL,            -- [added] customer's stated reason — key learning signal
  embedding           VECTOR(<EMBEDDING_DIM>) NOT NULL,
                      -- ILLUSTRATIVE dimension only. The embedding model is user-specified at
                      -- Gate 6 (§9.2); its output dimension sets EMBEDDING_DIM. One model,
                      -- one dimension, for every row — never mix.
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VECTOR INDEX resolutions_embedding_idx ON resolutions (embedding);
```

CockroachDB's vector index is **public preview** — fine to build on, not to present as GA.

## 11. Data access and storage layers

- **`TicketDataPort`** (in `packages/db`) is the single interface for all agent-side data
  access. Two implementations, selected by `DB_ACCESS_MODE`:
  - `SqlAdapter` (**default**) — pooled `pg` connection, **cached at module scope** and reused
    across warm Lambda invocations. Never open a connection per invocation.
  - `McpAdapter` — the CockroachDB managed MCP server, honoring diagram note 14. Whether a
    Lambda can authenticate to it is unverified; it is tried at activation and abandoned via
    config flip (not code change) if it can't.
  - The **web app's reads always use direct pooled SQL** regardless of mode — MCP is the agent's
    tool surface, not a CRUD API.
- **S3** — read-only policy documents (`refund-policy.json`, `dispute-policy.json`,
  `generic-policy.json`), each pairing prose with machine-readable params (§6.3), loaded behind
  an interface so unit tests mock them, TTL-cached at module scope. Lambdas get `s3:GetObject`
  on this bucket and nothing else. Editing a document in S3 is the supported way to change
  policy — no deploy involved.
- **CloudWatch** — the AgentCore supervisor and every Lambda emit structured JSON logs carrying
  `ticket_id`, `conversation_id`, specialist tool name, verdict/reason codes, and latency. No free-text-only
  log lines on the request path.

## 12. Refinements & rationale — every deviation from the diagram

Review this list to veto any refinement; everything not listed here follows the diagram
verbatim.

| # | Deviation | Why |
|---|---|---|
| 1 | Invariants (context-first, 3-cycle cap) enforced by Lambda guards over `orchestration_state`, not just the supervisor prompt or AgentCore Memory | The AgentCore supervisor can be instructed and keep active state, but that alone cannot enforce durable business invariants; prompt-only rules are untestable. §5 |
| 2 | Refund/dispute rules are pure TypeScript functions, **parameterized by values loaded from the S3 policy documents**; the LLM only explains verdicts | Notes 17–18 are precise financial rules; LLMs get boundary cases wrong. Parameterization keeps the editable documents as the single source of truth while keeping enforcement deterministic and exhaustively testable. §6, §6.3 |
| 3 | `order_history` gains `order_value_cents`, `shipped_at`, `received_at`; `tickets` gains `order_id` | The diagram's own refund rules reference order value, ship state, and days-since-received — unanswerable from its four columns. §10 |
| 4 | Status enum extended with `awaiting_customer` and `unresolved` | Note 12 requires an unresolved outcome; accept/reject needs an awaiting state. Human queue = `escalated ∪ unresolved`. §7 |
| 5 | `resolutions` table with `outcome`, `source`, `rejection_comments`, embedding column | Materializes the diagram's "Resolution embeddings" box; rejection comments captured as learning signal. §9–10 |
| 6 | `TicketDataPort` with `SqlAdapter` (default) + `McpAdapter`, chosen by `DB_ACCESS_MODE` | Lambda→managed-MCP auth is unverified; an adapter turns the unknown into a config flip instead of a build blocker. §11 |
| 7 | "Cycle" defined as specialist (non-context) invocations, capped at 3 | Note 10's "plan call evaluate cycle" is unobservable from outside the agent; specialist calls are the closest enforceable proxy. §5 |
| 8 | `tickets.access_token` gating public customer routes | Not in the diagram, but without it anyone could read or act on anyone's ticket. §8 |
| 9 | Submit flow: email match + order picker populates `tickets.order_id` | The diagram never says how a ticket ties to a customer/order; picking deterministically keeps order identification out of LLM judgment. §8 |
| 10 | Accept/reject/human-reply handled by Next.js server routes calling shared package functions | The diagram has no write path for these events; routes reuse the same tested code the Lambdas use, with no extra Lambda. §9 |
| 11 | Exactly one embedding model and one dimension, as a shared constant with a runtime length assertion — **the model itself is user-specified at Gate 6, never assumed** | The diagram names no embedding model, and picking one silently would bake an unreviewed decision into every stored vector. Mixing models or dimensions corrupts similarity search without erroring, and there is no fix short of re-embedding every row. §9.2 |
| 12 | `escalate` verdicts set `tickets.status` in the specialist Lambda itself | Status changes are deterministic side effects of deterministic verdicts — not left to the LLM to remember to do. §4 |
| 13 | Policy documents are JSON (prose + params) with TTL/ETag refresh; the supervisor prompt carries no policy values | Policy docs get edited over time; verdicts and explanations must track the current document without a deploy or supervisor-runtime code change. Every verdict records the policy version that produced it. §6.3 |
| 14 | Supervisor reasoning trace persisted to a dedicated `agent_runs` table — **never** folded into `resolutions.embedding` | AgentCore Memory is session-scoped, so *why* the agent acted is lost when a conversation ends. Keeping it: a human in the queue reads the escalation reason instead of re-deriving it (primary win); traces stay queryable next to a ticket after CloudWatch logs expire; and over time they expose wasted specialist calls against the 3-cycle cap. Kept **out** of the embedding because tool-path data in the similarity vector would separate tickets with identical customer problems, degrading retrieval. Guarded: `orchestration_state` remains the sole control authority, and the write is best-effort off the critical path. §9.1, §10 |

## 13. Out of scope — deliberately

- Multi-turn customer chat (one-shot + accept/reject-with-comments only)
- Email intake or outbound email
- RBAC (single shared password for the queue; per-ticket tokens for customers)
- Real payment/refund execution — verdicts are recorded and communicated, no money moves
- Additional AgentCore supervisor runtimes or peer-to-peer multi-agent collaboration (this design has one supervisor and Lambda specialist tools only)
- **Infrastructure as code.** Resources are provisioned **by hand** from a written runbook and
  *verified* by `pnpm doctor`. Accepted consequences: rebuilds are manual, environments can drift from
  the runbook, and teardown is a checklist rather than one command. `pnpm doctor` is the mitigation —
  it is the executable statement of what the infrastructure is supposed to look like, so drift is
  detected even though it isn't prevented
- Production hardening: multi-region, rate limiting, PII handling beyond the demo dataset
