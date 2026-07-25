# Plan of Record: Agentic Ticket Support System

This is the **why and in what order** document for building this system. It records the confirmed
decisions, the refinements made to the original whiteboard design, and the checkpoint sequence.

It deliberately does **not** restate the detailed specs — those live in the documents it links to,
and duplicating them here would only create drift. Live day-to-day status belongs in
[docs/PROGRESS.md](docs/PROGRESS.md), not in this file.

| Document | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Authoritative technical spec — the source of truth |
| [docs/BUILD-INSTRUCTIONS.md](docs/BUILD-INSTRUCTIONS.md) | How to build it: conventions, phase order, definition of done |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every config placeholder and where to obtain its real value |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy and how to run each tier |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Living checkpoint tracker, build log, and deviations |
| [agentic-ticket-system.png](agentic-ticket-system.png) | The original design diagram (visual companion) |

---

## Context

This is a hackathon entry for **CockroachDB × AWS — "Build the Future of Agentic Memory."** The
entire original design is a hand-drawn whiteboard diagram,
[agentic-ticket-system.png](agentic-ticket-system.png): a supervisor/specialist agent system on
Amazon Bedrock, using CockroachDB as long-term agent memory via distributed vector indexing.

The diagram is a sound design, but it is not directly executable. It has blank sections, omits the
embedding model and the deployment story, and — most importantly — **specifies business rules its
own schema cannot express** and **invariants its chosen runtime cannot enforce**. Building straight
from it would produce a plausible-looking system that silently violates its own design. The
refinements below close those gaps.

> **Note on history:** an earlier `architecture.md` was deleted from this repo. It survives in git
> history but describes a *different, superseded* agent decomposition (Intent/Memory/Resolution/
> Tool/Response agents). It must not be used. [ARCHITECTURE.md](ARCHITECTURE.md) supersedes it.

**Nothing is provisioned yet** — no AWS account, no Bedrock model access, no CockroachDB cluster —
and the hackathon deadline is weeks out. The build is therefore deliberately *not* sequenced behind
provisioning. Instead it splits in two:

- **Phase A — offline build.** All code written and unit-tested with zero credentials. Every
  Bedrock and CockroachDB configuration value is a loud, greppable placeholder.
- **Phase B — activation.** Placeholders filled, infrastructure deployed, integration tests
  enabled, end-to-end runs verified.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Orchestrator | Managed **Amazon Bedrock Agent** + action groups (one Lambda per specialist) |
| IaC | **AWS CDK in TypeScript** |
| Language | **TypeScript** throughout (per diagram note 2) |
| UI | Minimal web app: public submit form + gated human queue |
| Testing | Unit + integration (no LLM-judge eval harness) |
| Customer turn model | **One-shot**, then accept → `resolved`, or reject **with comments** → `unresolved` |
| Ticket identity | Submit form takes **email**, matched to a seeded `Customers` row; the form then lists that customer's orders so they pick the one the ticket concerns → populates `Tickets.order_id`. Unknown email creates a customer with no orders (order-specific questions then escalate) |
| Reply delivery | Customer **waits on the page** while the agent chain runs, then sees the reply with accept / reject-with-comments inline. A **per-ticket secret token** issued at submit gates view/accept/reject — the same link works for returning later (e.g. after a human answers an escalated ticket) |
| Web write path | **Next.js server routes** handle accept, reject-with-comments, and human reply directly — SQL writes via `packages/db`, embedding via `packages/agents`. No extra Lambda. Web app runs locally for the demo; hosted deploy is a CP10-tier stretch |
| Environment | Nothing provisioned — all code written against placeholders; provisioning is its own phase |
| Timeline | Hackathon, weeks away — Phase A and activation are must-have; UI polish and observability have cut lines |

## Architecture refinements

These are the substantive deviations from the diagram. Everything else in it is preserved verbatim.
The full list also appears in [ARCHITECTURE.md](ARCHITECTURE.md) under *Refinements & rationale*,
so it can be reviewed in one place and any item vetoed.

### 1. Invariants enforced in the Lambda layer, not the agent prompt

A managed Bedrock Agent can only be *asked* via its instruction prompt to "always call context
first" (note 4) and "escalate after 3 cycles" (note 10) — it cannot be forced, and prompt-only
rules are untestable.

**Fix:** an `OrchestrationState` row per `(ticket_id, conversation_id)` tracks `context_called_at`
and `cycle_count`. Every specialist Lambda checks it before doing any work:

- context not yet called → return a structured refusal telling the agent to call context first
- `cycle_count >= 3` → return a directive to escalate, and flip the ticket to `escalated`

The instruction prompt still states both rules, so the agent usually complies unaided. The guard is
the backstop that makes them *true* — and unit-testable.

### 2. Policy thresholds are deterministic TypeScript, never LLM judgment

Diagram notes 17–18 are precise financial rules: $300 boundaries, 7-day and 30-day windows,
specific order statuses. An LLM asked to apply these will get boundary cases wrong.

**Fix:** pure functions `evaluateRefund(order, request, now, params)` and
`evaluateDispute(dispute, now, params)` return a verdict; the LLM's only job is to *explain* that
verdict in friendly prose. And because the thresholds live in the **editable S3 policy documents**,
not in code, each document pairs its prose with a machine-readable `params` block: the Lambda loads
it (TTL + ETag cached), feeds `params` to the engine and `prose` to the LLM — so editing a policy
document changes verdicts and explanations atomically, with no redeploy and no Bedrock Agent
re-preparation (the baked agent prompt deliberately contains no policy values). Every verdict
records the policy version that produced it. This is the highest-value correctness decision in the
build, and the engines themselves need no configuration — fully buildable and provable on day one
against v1 default params.

### 3. `OrderHistory` needs columns the diagram omits

The diagram gives `id, customer_id, status, created_at`. But its own refund rules need order value
("< $300"), ship state, and days-since-received ("within 30 days of order received") — all
unanswerable from those four columns.

**Fix:** add `order_value_cents`, `shipped_at`, `received_at`, plus a `Tickets.order_id` FK so a
ticket can be tied to the order under dispute.

### Supporting refinements

- **Status enum** → `open | awaiting_customer | resolved | unresolved | escalated`. The diagram
  lists three, but note 12 requires an `unresolved` outcome. The human queue is
  `status IN ('escalated','unresolved')`.
- **A `Resolutions` table** materializes the diagram's "Resolution embeddings" box, carrying
  `outcome`, `source ('agent'|'human')`, `rejection_comments`, and the vector column. Per note 13,
  *both* resolved and unresolved tickets are embedded — a rejection together with the customer's
  stated reason is the richest learning signal in the system.
- **DB access behind an adapter, not a spike.** Note 15 says agent tools reach CockroachDB via MCP,
  but whether a Lambda can authenticate to the managed MCP server is unverified — and it was the
  project's largest technical unknown. Rather than block the build on it: define one
  `TicketDataPort` interface with **two implementations**, `SqlAdapter` (default) and `McpAdapter`,
  selected by `DB_ACCESS_MODE`. The unknown becomes a config flip during activation instead of a
  gate. Either way, the web app's list/detail reads use direct pooled SQL — MCP is the agent's tool
  surface, not a CRUD API.
- **"Cycle" made enforceable.** Diagram note 10 caps the orchestrator at three "plan call evaluate"
  cycles, but a Lambda guard cannot observe the agent's internal planning — only its calls. So:
  `cycle_count` = number of specialist (non-context) action-group invocations for the ticket,
  capped at 3. The closest observable proxy for the diagram's intent, and unit-testable.
- **Per-ticket access token.** `Tickets.access_token` (generated at submit, returned in the ticket
  URL) gates the customer's view/accept/reject routes, since they are public and unauthenticated.
  Not in the diagram, but without it anyone could act on anyone's ticket.
- **One embedding model, one dimension.** Amazon Titan Text Embeddings V2. The dimension is a
  single exported constant consumed by both the DDL and the embedding client, and asserted at
  runtime against the actual returned vector length — so a model swap fails fast instead of
  silently corrupting the table. Exact Bedrock model IDs are placeholders resolved during
  activation via `aws bedrock list-foundation-models`, never hardcoded from memory.

## The placeholder system

This is what makes offline development possible, so it is a first-class deliverable rather than a
convention buried in a README. Full manifest in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

- **One typed config module**, `packages/core/src/config.ts`. No Lambda, adapter, or CDK stack reads
  `process.env` directly — everything resolves through it, so the complete set of required
  configuration is knowable by reading one file.
- **Sentinel value `REPLACE_ME`** in `.env.example` and `cdk.context.template.json`. Greppable, and
  impossible to mistake for a real value.
- **Fail loudly, never silently.** Config resolution throws at startup if a value is still
  `REPLACE_ME`, naming the variable and pointing at the manifest. A placeholder must never reach an
  AWS or database call and surface as a confusing downstream error.
- **`pnpm check:config`** scans for unreplaced placeholders and prints what is outstanding and where
  to get each one. The activation checklist, executable.
- **Every external boundary is an interface with a mock** — Bedrock runtime, Bedrock agent runtime,
  embeddings, S3 policy documents, and the data port. Unit tests bind mocks, so `pnpm test` is
  fully green with zero credentials and zero network access.

Placeholders group into: **Bedrock** (region, orchestrator model ID, embedding model ID, embedding
dimensions, agent ID, agent alias ID — the last two only exist post-deploy); **CockroachDB**
(database URL, SSL root cert, `DB_ACCESS_MODE`, MCP endpoint, MCP API key); **other AWS** (account
ID, S3 policy bucket, policy document keys, ticket-handler Function URL, web app shared password).
Note the web app's server routes need the database URL and Bedrock credentials in their environment
at activation — they write status changes and call the embedding model directly.

## Repository layout

```
packages/core/       config.ts (placeholders), logging, domain types, embedding-dimension constant
packages/policy/     evaluateRefund / evaluateDispute — pure, zero deps, zero config
packages/db/         migrations/, pooled connection, TicketDataPort + SqlAdapter + McpAdapter, seed
packages/agents/     Bedrock + embedding clients behind interfaces, retrieval, action-group envelopes
lambdas/             ticket-handler, context, tracking, refund, dispute
apps/web/            submit form, gated queue, ticket detail, accept / reject-with-comments
infra/cdk/           Agent + action groups + Lambdas + S3 + IAM, driven by cdk.context.json
docs/                BUILD-INSTRUCTIONS, CONFIGURATION, TESTING, PROGRESS
```

## Checkpoints

Track live status in [docs/PROGRESS.md](docs/PROGRESS.md). Each checkpoint's full Definition of Done
is in [docs/BUILD-INSTRUCTIONS.md](docs/BUILD-INSTRUCTIONS.md).

### Phase A — offline build

No AWS account, cluster, or credential required. `pnpm test` stays green at every checkpoint.
Ordered so the zero-config, highest-value work lands first.

| CP | Scope | Verified by |
|---|---|---|
| **CP0** | All docs. Monorepo scaffold, TS, Vitest, `config.ts` with the full placeholder set, `.env.example`, `pnpm check:config`. | `pnpm test` green on an empty suite; `check:config` lists every outstanding placeholder |
| **CP1** | `packages/policy` — refund + dispute engines, parameterized by `PolicyParams`; the `params`-block schema and v1 default policy documents (prose + params JSON). | Exhaustive boundary tests: $299/$300/$301, day 6/7/8, day 29/30/31, every order status — plus tests proving changed params change verdicts. Zero LLM calls, zero I/O in the package |
| **CP2** | `packages/db` — migration SQL for all tables + vector index, pooled connection module, `TicketDataPort`, `SqlAdapter`, `McpAdapter`, seed script covering every policy boundary. Written, not yet run live. | Unit tests against a mocked port; migrations parse; seed idempotent by construction |
| **CP3** | `packages/agents` — Bedrock + Titan clients behind interfaces, embedding write path, similarity search with type filter, ordering and `LIMIT`, dimension assertion. | Unit tests with mocked Bedrock; a fake-embedding retrieval test proves ranking logic |
| **CP4** | Four specialist Lambdas with action-group envelopes, the **context-first guard**, the **cycle counter**, and the policy-document loader (S3 behind an interface, TTL + ETag cache, zod-validated params, last-known-good fallback). | Per-handler unit tests with mocks; guard tests prove refusal and forced escalation at cycle 3; loader tests prove refresh-on-edit and loud failure on malformed params |
| **CP5** | `ticket-handler` Lambda (`InvokeAgent` behind an interface) + the post-hoc safety net (empty/unresolved response → escalate). Learning-loop write path as shared package functions — accept, reject-with-comments, and human reply all persist + embed — consumed later by the web app's server routes. | Unit tests drive a fully mocked ticket through resolve, reject, and escalate paths |
| **CP6** | `infra/cdk` — Agent resource, instruction prompt encoding plan→evaluate→escalate, action groups with OpenAPI schemas, Lambdas, S3, IAM. Placeholder context values. | `cdk synth` succeeds against `cdk.context.template.json` and emits a valid template — no deploy, no account needed |
| **CP7** | `apps/web` (Next.js) — submit form with email match + order picker, wait-on-page reply view, token-gated customer routes, gated human queue (`escalated`/`unresolved`), detail view. Server routes wire accept / reject-with-comments / human reply to the CP5 package functions. Against a mocked backend. | Builds; component tests cover accept and reject-with-comment submission; a route test proves a wrong token is refused |

### Phase B — activation

The first point real credentials are needed.

| CP | Scope | Verified by |
|---|---|---|
| **CP8** | **Repo owner (human):** AWS account, Bedrock model access, CockroachDB Cloud cluster. Then resolve real model IDs, fill every placeholder, run migrations + seed, and settle `DB_ACCESS_MODE` by trying `McpAdapter` and falling back to SQL. | `pnpm check:config` clean; `pnpm test:integration` green against the real cluster, including a paraphrase retrieving a seeded resolution top-1 |
| **CP9** | `cdk deploy`. Wire the Function URL into the web app. End-to-end runs. | `curl` a tracking question → resolved; an out-of-policy refund → escalated; resolve ticket A then submit similar ticket B and assert context retrieved A; manual pass of submit → reject with comment → queue → human reply → resolved |
| **CP10** | *(cut line)* CloudWatch structured logs with correlation IDs, latency/cost notes, demo runbook, `cdk destroy` teardown. | Runbook executes start-to-finish; teardown leaves no billable resources |

**Cut lines.** If time runs short: CP10 degrades to structured logging plus a written runbook, and
CP7 degrades to submit-form-only with the human queue driven by script. **CP0–CP6 and CP8–CP9 are
not negotiable** — they are the agentic-memory story the hackathon is judged on.

## Verification bars

**That the offline build is genuinely offline.** The acceptance bar for Phase A is that
`pnpm install && pnpm test && pnpm -w build && cdk synth` all succeed on a machine with no AWS
credentials and no database — proving no hidden dependency on unprovisioned infrastructure.

**That the docs are self-consistent.** Every table and column named in the instructions exists in
[ARCHITECTURE.md](ARCHITECTURE.md)'s data model; every checkpoint exit criterion names a runnable
command or a concrete manual step; no test depends on something no checkpoint builds; every
placeholder in `config.ts` appears in [docs/CONFIGURATION.md](docs/CONFIGURATION.md) with a stated
source.

**That the system works.** CP9's end-to-end paths: a ticket in, an agent resolution or an
escalation out, and the memory loop demonstrably closing when a similar second ticket retrieves the
first one's resolution.
