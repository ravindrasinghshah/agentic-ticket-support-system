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
Amazon Bedrock, using AgentCore for active agent-session memory and CockroachDB as long-term
agent memory via distributed vector indexing.

The diagram is a sound design, but it is not directly executable. It has blank sections, omits the
embedding model and the deployment story, and — most importantly — **specifies business rules its
own schema cannot express** and **invariants its chosen runtime cannot enforce**. Building straight
from it would produce a plausible-looking system that silently violates its own design. The
refinements below close those gaps.

> **Note on history:** an earlier `architecture.md` was deleted from this repo. It survives in git
> history but describes a *different, superseded* agent decomposition (Intent/Memory/Resolution/
> Tool/Response agents). It must not be used. [ARCHITECTURE.md](ARCHITECTURE.md) supersedes it.

**Nothing is provisioned yet** — no AWS account, no Bedrock model access, no CockroachDB cluster,
no schema — and the hackathon deadline is weeks out. The build is therefore **iterative and
stage-gated**: eight gates (see [Stage gates](#stage-gates)), each building one module, provable in
isolation, behind explicit pass criteria and human sign-off.

**Gate 1 proves the real infrastructure before anything is built on top of it.** The riskiest
unknowns — AgentCore regional availability, whether Bedrock model access is actually granted, whether
the CockroachDB MCP connector authenticates — surface on day one instead of at the end. Every
subsequent gate then adds exactly one specialist or capability, with only the schema it needs, so a
failure is always localized to the thing just built.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Orchestrator | TypeScript supervisor deployed to **Amazon Bedrock AgentCore Runtime**; it calls Lambda specialist-agent modules through AgentCore Gateway/MCP tools |
| Active agent memory | **Amazon Bedrock AgentCore Memory**, keyed by `conversation_id`, for the supervisor's plan, tool results, context status, cycle count, and response hand-off |
| Durable learning memory | **CockroachDB Cloud** is the system of record for tickets, conversation history, safety state, resolutions, and resolution embeddings; AgentCore Memory is not the durable database |
| Provisioning | **Manual throughout — no IaC.** AWS resources created by hand from a runbook; `pnpm doctor` verifies but never creates. Each gate lists the resources to provision before starting it |
| Supervisor hosting | Supervisor is a **host-agnostic module**: iterated locally against Bedrock for speed, with a **smoke deploy to AgentCore Runtime at Gate 2** proving the real hosting path |
| Entry point | `ticket-handler` Lambda + Function URL built at **Gate 2**, so all three §5 invariants — including the post-hoc safety net — are proven together |
| Language | **TypeScript** throughout (per diagram note 2) |
| UI | Minimal web app: public submit form + gated human queue |
| Testing | Unit + integration (no LLM-judge eval harness) |
| Customer turn model | **One-shot**, then accept → `resolved`, or reject **with comments** → `unresolved` |
| Ticket identity | Submit form takes **email**, matched to a seeded `Customers` row; the form then lists that customer's orders so they pick the one the ticket concerns → populates `Tickets.order_id`. Unknown email creates a customer with no orders (order-specific questions then escalate) |
| Reply delivery | Customer **waits on the page** while the agent chain runs, then sees the reply with accept / reject-with-comments inline. A **per-ticket secret token** issued at submit gates view/accept/reject — the same link works for returning later (e.g. after a human answers an escalated ticket) |
| Web write path | **Next.js server routes** handle accept, reject-with-comments, and human reply directly — SQL writes via `packages/db`, embedding via `packages/agents`. No extra Lambda. Web app runs locally for the demo; hosted deploy is a stretch |
| Reasoning trace | Supervisor plan and specialist path persisted to a dedicated **`agent_runs`** table — **never** folded into the resolution embedding. Best-effort write, off the critical path, never read by the §5 guards (ARCHITECTURE.md §9.1) |
| Build sequence | **8 stage gates**, one module each, real infrastructure proved first at Gate 1 |
| Database | **Real CockroachDB Cloud seeded with synthetic data**; in-memory fakes only for fast unit tests |
| Schema growth | Each gate creates **only the minimum schema it needs**; full schema built and fleshed out at **Gate 6** |
| Git discipline | Branch per gate; push freely; **PR requires explicit user confirmation of gate pass**; never merge to `main` unless asked |
| Timeline | Hackathon, weeks away — Gates 1–7 are must-have; UI polish and observability have cut lines |

## Architecture refinements

These are the substantive deviations from the diagram. Everything else in it is preserved verbatim.
The full list also appears in [ARCHITECTURE.md](ARCHITECTURE.md) under *Refinements & rationale*,
so it can be reviewed in one place and any item vetoed.

### 1. AgentCore is the supervisor runtime and active-memory layer

The application contains a TypeScript supervisor agent deployed to **Amazon Bedrock AgentCore
Runtime**, not a managed Bedrock Agent with action groups. The supervisor calls the Context,
Tracking, Refund, and Dispute Lambda modules through **AgentCore Gateway** as MCP tools. The Lambda
Function URL is only the UI/API entry point: it validates the request, invokes the AgentCore runtime
with `sessionId = conversation_id`, and returns the runtime's final response.

**AgentCore Memory** is the supervisor's working-memory service. It persists session-scoped state
between runtime interactions: request/plan, context-loaded status, specialist results, cycle count,
and hand-off information. It does not replace CockroachDB. CockroachDB remains the durable source
of truth and learning-memory store, including `orchestration_state`, tickets, messages,
resolutions, and embeddings. Lambda safeguards always read the durable state, not only AgentCore
Memory.

### 2. Invariants enforced in the Lambda layer, not the agent prompt

The AgentCore-hosted supervisor can be instructed, and can persist its plan in AgentCore Memory, to
"always call context first" (note 4) and "escalate after 3 cycles" (note 10). That still is not a
guarantee: prompt-only and session-memory-only rules are untestable and non-durable.

**Fix:** an `OrchestrationState` row per `(ticket_id, conversation_id)` tracks `context_called_at`
and `cycle_count`. Every specialist Lambda checks it before doing any work:

- context not yet called → return a structured refusal telling the agent to call context first
- `cycle_count >= 3` → return a directive to escalate, and flip the ticket to `escalated`

The instruction prompt still states both rules, so the agent usually complies unaided. The guard is
the backstop that makes them *true* — and unit-testable.

### 3. Policy thresholds are deterministic TypeScript, never LLM judgment

Diagram notes 17–18 are precise financial rules: $300 boundaries, 7-day and 30-day windows,
specific order statuses. An LLM asked to apply these will get boundary cases wrong.

**Fix:** pure functions `evaluateRefund(order, request, now, params)` and
`evaluateDispute(dispute, now, params)` return a verdict; the LLM's only job is to *explain* that
verdict in friendly prose. And because the thresholds live in the **editable S3 policy documents**,
not in code, each document pairs its prose with a machine-readable `params` block: the Lambda loads
it (TTL + ETag cached), feeds `params` to the engine and `prose` to the LLM — so editing a policy
document changes verdicts and explanations atomically, with no redeploy and no supervisor runtime
code change (the supervisor prompt deliberately contains no policy values). Every verdict
records the policy version that produced it. This is the highest-value correctness decision in the
build, and the engines themselves need no configuration — fully buildable and provable on day one
against v1 default params.

### 4. `OrderHistory` needs columns the diagram omits

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
- **"Cycle" made enforceable.** Diagram note 10 caps the supervisor at three "plan call evaluate"
  cycles, but a Lambda guard cannot observe the agent's internal planning — only its calls. So:
  `cycle_count` = number of specialist (non-context) tool invocations for the ticket,
  capped at 3. The closest observable proxy for the diagram's intent, and unit-testable.
- **Per-ticket access token.** `Tickets.access_token` (generated at submit, returned in the ticket
  URL) gates the customer's view/accept/reject routes, since they are public and unauthenticated.
  Not in the diagram, but without it anyone could act on anyone's ticket.
- **One embedding model, one dimension — and the model is specified by the user at Gate 6, never
  assumed.** Do not default to a familiar option; until it is given, both the model ID and the
  dimension are `REPLACE_ME`, and any dimension shown in the docs is illustrative. What is fixed
  regardless of the choice: exactly one model for the whole `resolutions` table (vectors from different
  models aren't comparable, and mixing them corrupts similarity search *without erroring* — the only
  fix is re-embedding every row), `EMBEDDING_DIM` as a single constant consumed by both the DDL and the
  embedding client, and a runtime assertion on the actual returned vector length. See ARCHITECTURE.md
  §9.2. Model IDs are always resolved from the live service, never recalled from memory.

## The placeholder and config system

A **Gate 1 deliverable**, and a first-class one rather than a convention buried in a README. Two jobs:
it keeps every credential and resource identifier in one auditable place, and it lets each gate's unit
tests run fast with zero credentials and zero network while that same gate's integration tests hit
real infrastructure. `pnpm check:config` is absorbed into `pnpm doctor`. Full manifest in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

- **One typed config module**, `packages/core/src/config.ts`. No Lambda, adapter, supervisor, or web
  route reads `process.env` directly — everything resolves through it, so the complete set of required
  configuration is knowable by reading one file. With manual provisioning this file carries extra
  weight: it is the only inventory of what was created by hand.
- **Sentinel value `REPLACE_ME`** in `.env.example`. Greppable, and impossible to mistake for a real
  value.
- **Fail loudly, never silently.** Config resolution throws at startup if a value is still
  `REPLACE_ME`, naming the variable and pointing at the manifest. A placeholder must never reach an
  AWS or database call and surface as a confusing downstream error.
- **`pnpm check:config`** scans for unreplaced placeholders and prints what is outstanding and where
  to get each one. The activation checklist, executable.
- **Every external boundary is an interface with a mock** — Bedrock model runtime, AgentCore runtime,
  AgentCore Memory/Gateway tool clients, embeddings, S3 policy documents, and the data port. Unit
  tests bind mocks, so `pnpm test` is
  fully green with zero credentials and zero network access.

Placeholders group into: **Bedrock/AgentCore** (region, supervisor model ID, embedding model ID,
embedding dimensions, AgentCore runtime ARN, AgentCore Memory resource ID, AgentCore Gateway URL,
and Gateway authentication configuration — created at deploy); **CockroachDB**
(database URL, SSL root cert, `DB_ACCESS_MODE`, MCP endpoint, MCP API key); **other AWS** (account
ID, S3 policy bucket, policy document keys, ticket-handler Function URL, web app shared password).
Note the web app's server routes need the database URL and Bedrock credentials in their environment
at activation — they write status changes and call the embedding model directly.

## Repository layout

Each directory is a module with its own interface and mock, so gates stay independently debuggable
and upgradable.

```
packages/core/       config.ts (placeholders), logging, domain types, embedding-dimension constant
packages/policy/     evaluateRefund / evaluateDispute — pure, zero deps, zero I/O
packages/db/         migrations/, pooled connection, TicketDataPort + SqlAdapter + McpAdapter, seed
packages/agents/     Bedrock model + AgentCore runtime/memory/gateway clients behind interfaces,
                     retrieval, MCP tool contracts, TraceSink
supervisor/          host-agnostic TypeScript supervisor + AgentCore Runtime deployment bundle
lambdas/             ticket-handler (Function URL), context, tracking, refund, dispute
apps/web/            submit form, gated queue, ticket detail, accept / reject-with-comments
tools/doctor/        pnpm doctor — infrastructure diagnostics with per-failure remediation advice
fixtures/gate-N/     per-gate mock inputs/, expected/, and a README stating what the gate does not prove
tests/gate-N/        per-gate unit/, contract/, integration/ — runnable via pnpm test:gate N
docs/                BUILD-INSTRUCTIONS, CONFIGURATION, TESTING, PROGRESS, PROVISIONING
```

**No `infra/` directory** — provisioning is manual (see [Provisioning](#provisioning-manual-by-design)).
`docs/PROVISIONING.md` is the runbook: the ordered list of resources to create by hand, per gate, with
the exact console/CLI steps and the values to copy back into `.env`.

## Stage gates

The build is **iterative, stage-gated, and modular**. Eight gates, each one building a single
module, provable in isolation, behind explicit pass criteria and human sign-off. Track live status in
[docs/PROGRESS.md](docs/PROGRESS.md).

Unlike an offline-first build, **Gate 1 proves real infrastructure before anything is built on it** —
the largest technical unknowns (AgentCore availability, Bedrock model access, the CockroachDB MCP
connector) surface on day one rather than at the end.

### Working agreements

1. **One branch per gate**, named `gate-N-<slug>`, cut from `main`.
2. **Commit and push freely** to the gate branch while working — nothing is ever left at risk.
3. **Opening a pull request requires explicit user confirmation** that every pass criterion for that
   gate is met. Claude presents the evidence (test output, doctor report); the user confirms.
4. **Never merge to `main`** unless the user explicitly asks.
5. **Modularity is a hard requirement.** Every component sits behind an interface with a mock
   implementation. **No gate edits an earlier gate's module to make itself work** — if that seems
   necessary, stop and raise it as a design smell rather than quietly patching across boundaries.
6. **Gate 1's doctor script is advisory, not self-healing** — it diagnoses and prescribes; the user
   performs account and console actions.
7. **Stop and ask — never assume — on the decisions below.** These are choices whose cost is *silent*:
   a wrong guess doesn't error, it degrades something subtly and expensively. Ask, wait, then build.

| Decision | Gate | Why guessing is expensive |
|---|---|---|
| **Embedding model ID + output dimension** | **6** | Every stored vector comes from one model. Vectors from different models aren't comparable, so a later change corrupts similarity search **without raising an error** — it just looks like "retrieval got worse." Only remedy is re-embedding every row |
| Supervisor foundation model ID | 2 | Affects planning quality, latency, and cost; resolve from the live service, never from memory |
| Any policy threshold or window | 4, 5 | These are financial rules. They live in the S3 policy documents and are never invented in code |
| A schema change a gate seems to need | any | The per-gate schema minimum is deliberate; needing more usually means a boundary is wrong |
| Editing an earlier gate's module | any | Raise it as a design smell rather than patching across boundaries (see rule 5) |

### Provisioning: manual by design

There is **no infrastructure as code**. Every AWS and CockroachDB resource is created **by hand**,
following `docs/PROVISIONING.md`, and `pnpm doctor` **verifies but never creates**. Each gate below
opens with a *Provision first* list — the resources that must exist before that gate's code can run.

Accepted trade-offs, stated so they are not surprises later: rebuilding an environment is a manual
exercise, configuration can drift from the runbook, and teardown is a checklist rather than one
command. **`pnpm doctor` is the mitigation** — it is the executable statement of what the
infrastructure should look like, so drift is *detected* even though it isn't *prevented*. Treat a
doctor failure as authoritative: fix the environment, don't loosen the check.

### Database and schema policy

CockroachDB starts with **no tables and no schema**. Each gate creates **only the minimum schema it
needs to pass**, using a **real CockroachDB Cloud instance seeded with synthetic (mock) data** —
in-memory fakes exist only for fast unit tests. The **complete schema is built and fleshed out at
Gate 6**, which also consolidates the incremental per-gate migrations.

### Per-gate structure (the modularity contract)

Every gate ships the same shape, so any gate can be picked up, debugged, or upgraded on its own:

```
fixtures/gate-N/
  inputs/       mock inputs — tickets, tool payloads, policy documents, DB seed data
  expected/     expected outputs — verdicts, reason codes, plan shapes, tool envelopes
  README.md     what this gate proves, and what it deliberately does NOT prove
tests/gate-N/
  unit/         the module in isolation, every boundary mocked
  contract/     tool request/response envelope conformance
  integration/  against real CockroachDB / AgentCore, where the gate requires it
```

`pnpm test:gate N` runs exactly one gate's suite, with no dependency on any other gate's tests.

### Two MCP surfaces — keep them distinct

Easily conflated, and they land at different gates:

- **CockroachDB MCP connector** — data access, backing `McpAdapter`. Verified in **Gate 1**.
- **AgentCore Gateway** — publishes specialist Lambdas to the supervisor as MCP tools. Stood up in
  **Gate 3**.

### Gate 1 — Infrastructure Verification · `gate-1-infrastructure`

Prove every external dependency works *before* anything is built on it, and stand up the scaffold
every later gate depends on.

*Provision first:* AWS account with programmatic credentials · **Bedrock model access approved for the
supervisor model** in the target region · AgentCore enabled in that region · CockroachDB Cloud cluster
(no schema) · CockroachDB MCP connector endpoint + credentials · S3 bucket for policy documents.

> **Not needed yet:** the embedding model. It is **user-specified at Gate 6** and deliberately not
> chosen here, so Gate 1 verifies supervisor-model access only. The doctor script carries an
> embedding-model check that reports **SKIPPED — model not yet specified** until the ID is configured,
> and becomes a hard check from Gate 6 onward.

**What gets built**

- **Monorepo scaffold** — pnpm workspaces, TypeScript, Vitest, `pnpm test:gate N` script wiring.
- **`packages/core`** — `config.ts` resolving every placeholder through one typed module (nothing reads
  `process.env` directly); `EMBEDDING_DIM` constant; structured logger keyed by `ticket_id` +
  `conversation_id`; shared domain types.
- **Mock implementations of every external boundary** — Bedrock model, AgentCore Runtime, AgentCore
  Memory, AgentCore Gateway tool client, embeddings, S3 policy documents, `TicketDataPort`, `TraceSink`,
  `PrecedentSource`. These are the seams every later gate tests against.
- **`tools/doctor` (`pnpm doctor`)** — the deliverable that matters most here. Each check is
  independent, reports PASS/FAIL, and **every failure prints the exact remediation step** rather than a
  stack trace. Because provisioning is manual, this is also the project's only drift detector.
- **`docs/PROVISIONING.md`** — the ordered by-hand runbook, and which `.env` value each step yields.

**Doctor checks** (each with its own remediation text)

| Check | Catches |
|---|---|
| AWS credentials + region resolve | wrong profile, unset region |
| Bedrock `ListFoundationModels` reachable | networking, IAM |
| **Supervisor model access actually granted** | the classic silent gap — API reachable but model not approved |
| Embedding model access — **SKIPPED until specified at Gate 6**, hard check thereafter | prevents a guessed model becoming a de facto decision |
| AgentCore Runtime / Memory / Gateway available in region + IAM present | AgentCore's limited regional availability |
| CockroachDB reachable over SSL; `SELECT 1` | connection string, cert path |
| `gen_random_uuid()` available | wrong CockroachDB version |
| **`VECTOR` type + `CREATE VECTOR INDEX` supported** | vector support unavailable (public preview) — must be known now, not at Gate 6 |
| CockroachDB MCP connector authenticates and lists tools | resolves whether `McpAdapter` is viable at all |
| S3 `GetObject` on the policy bucket | bucket name, IAM scope |

*Schema:* **none.** The cluster stays empty; only connectivity and capability are proven.

**Fixtures** — `fixtures/gate-1/`: `expected/doctor-report.json` (the report shape), plus fault
injections (expired credentials, denied model, missing bucket, `VECTOR` unsupported) so each
remediation path is exercised without breaking real infrastructure.

**Test cases** — `tests/gate-1/`
*Unit:* `config.ts` throws on an unreplaced `REPLACE_ME`, naming the variable and pointing at the
manifest · every mock boundary satisfies its interface · logger emits structured JSON with correlation
IDs.
*Contract:* each doctor check returns the documented report shape; a failing check always carries
non-empty remediation text (a check that fails silently is itself a test failure).
*Integration:* `pnpm doctor` against real infrastructure, all-green.

*Pass criteria:* **(a)** `pnpm doctor` all-green against real infrastructure, with every gap you had to
fix surfaced *by the tool* rather than discovered by hand; **(b)** `pnpm test:gate 1` green with every
boundary mocked and zero network access.

*Deliberately not proven here:* any agent behaviour · any schema · any AWS resource *creation* (doctor
diagnoses and prescribes; you provision).

### Gate 2 — Supervisor + Context Clerk (V1) · `gate-2-supervisor-context`

Build the reasoning core and the mandatory-first context clerk, plus the entry-point Lambda — so all
three §5 invariants exist and are proven together.

*Provision first:* AgentCore Memory resource · AgentCore Runtime target for the smoke deploy ·
Lambda execution role with CockroachDB network access and CloudWatch write.

**What gets built**

- **Host-agnostic supervisor** (`supervisor/`) — the planning loop as a plain TypeScript module taking
  its model client, memory store, tool client, and `TraceSink` by injection. It can therefore be
  driven locally (fast iteration) *and* deployed unchanged to AgentCore Runtime. It implements
  plan → call → evaluate → escalate, chasing the objective *"do I have everything I need to resolve
  this ticket?"*, and emits its **plan as a structured artifact** (not prose) so tests can assert on it.
- **One smoke deploy to AgentCore Runtime** — the same module invoked via `InvokeAgentRuntime` with
  `sessionId = conversation_id`, proving the real hosting path works. Day-to-day iteration stays local.
- **AgentCore Memory state contract** — the typed shape of session state (request, plan,
  `contextLoaded`, specialist outputs, cycle count, hand-off), with an explicit rule that it is
  *active* state only: **durable guards read `orchestration_state`, never AgentCore Memory.**
- **Context clerk Lambda** — reads real CockroachDB, stamps `orchestration_state.context_called_at`,
  returns the §4.1 payload. Its shape is complete from the start but **partially populated at this
  gate**: `order` is `null` (no `order_history` until Gate 3) and `similarResolutions` is empty via a
  fixture-backed `PrecedentSource` (no embeddings until Gate 6). Gates 3 and 6 fill these in *behind
  the same interfaces* — do not create those tables early.
- **`ticket-handler` Lambda + Function URL** — validates input, invokes the supervisor, and carries
  **invariant 3, the post-hoc safety net**: an empty/blank response, or a run finishing `open` with no
  verdict, forces `status = 'escalated'` and substitutes a hand-off reply.
- **Durable guards** over `orchestration_state`: `CONTEXT_REQUIRED` refusal when `context_called_at IS
  NULL`; `CYCLE_LIMIT` forced escalation at `cycle_count >= 3`.
- **Test harness** feeding the supervisor every input it needs to plan, with **hard-coded specialist
  responses** — no real specialists exist yet.
- **`TraceSink`** interface, in-memory implementation (real `agent_runs` at Gate 6).

*Schema:* `customers`, `tickets`, `orchestration_state` — the minimum for the context-first guard.

**Fixtures** — `fixtures/gate-2/`

```
inputs/
  tickets/          tracking-question · refund-request · dispute-request · ambiguous
  specialists/      hard-coded specialist responses the harness returns
  orchestration/    context-not-called · cycle_count=2 · cycle_count=3
  supervisor/       harness inputs, incl. a run that returns an empty response (safety-net trigger)
expected/
  plans.json        expected plan shape per ticket input
  context.json      expected context payload (order:null, similarResolutions:[])
  envelopes.json    CONTEXT_REQUIRED and CYCLE_LIMIT envelopes
  transitions.json  expected tickets.status after each path
```

**Test cases** — `tests/gate-2/`
*Unit:* supervisor produces a well-formed plan from harness inputs · plan is structured, not prose ·
supervisor re-evaluates after each specialist response · safety net converts empty/verdict-less runs to
escalation · memory contract round-trips.
*Contract:* context payload matches §4.1 exactly, with `order:null` and empty `similarResolutions`
tolerated by consumers · `CONTEXT_REQUIRED` and `CYCLE_LIMIT` envelope shapes.
*Integration (real CockroachDB + AgentCore):* context clerk reads real tables and stamps
`context_called_at` · a specialist call with `context_called_at IS NULL` is **refused with no work
done** · `cycle_count` increments per specialist call and **forces escalation at exactly 3** ·
escalation actually writes `status='escalated'` · the smoke deploy to AgentCore Runtime returns a
response for one ticket · a session's state survives across two runtime interactions in AgentCore
Memory while the guards still read `orchestration_state`.

*Pass criteria:* supervisor produces a well-formed plan from harness inputs · context clerk reads real
CockroachDB · the context-first guard **provably refuses** a specialist call when `context_called_at IS
NULL` · the cycle counter increments and **forces escalation at 3** · the safety net forces escalation
on an empty response · the AgentCore Runtime smoke deploy succeeds.

*Deliberately not proven here:* any real specialist (Gate 3+) · `order` or precedent population
(Gates 3 and 6) · plans with multiple specialists (Gate 7) · **no UI work at all** (Gate 8).

### Gate 3 — Tracking Specialist over MCP · `gate-3-tracking-specialist`

Stand up the tool-publishing surface and prove the first real supervisor → specialist → supervisor
round trip.

*Provision first:* AgentCore Gateway · Gateway authentication configuration · tracking Lambda target
registered with the Gateway.

**What gets built**

- **AgentCore Gateway** with the tracking specialist published as an **MCP tool** — the second of the
  two MCP surfaces (distinct from the CockroachDB MCP connector verified at Gate 1).
- **Tracking specialist Lambda** — reads order history and tracking status through `TicketDataPort`
  and returns the §4.2 structured payload `{ orderId, status, shippedAt, estimatedNarrative }`.
  **Makes no policy decisions** — it reports state; money rules belong to Gates 4 and 5.
- **`TicketDataPort` implementations** — `SqlAdapter` (default, pooled connection **cached at module
  scope** and reused across warm invocations) and `McpAdapter` against the CockroachDB MCP connector,
  selected by `DB_ACCESS_MODE`. Gate 1 already established whether `McpAdapter` is viable.
- **Seed script** — synthetic customers and orders spanning every status and every policy boundary
  Gates 4 and 5 will need, idempotent by construction.
- **Context clerk gains `order` population** now that `order_history` exists — behind the interface
  defined at Gate 2, with no change to its payload shape.

*Schema:* add **`order_history`** (`customer_id`, `status`, `order_value_cents`, `shipped_at`,
`received_at`, `created_at`) and the `tickets.order_id` FK.

**Fixtures** — `fixtures/gate-3/`

```
inputs/
  orders/         processing · shipped · delivered · shipped_back_to_sender · no-order ticket
  seed/           synthetic customers + orders covering every status and boundary date
  supervisor/     harness input for a plan containing exactly one tracking call
expected/
  tracking.json   expected payload per order input
  envelopes.json  MCP tool request/response shapes, incl. refusal and cycle-limit
  plan.json       expected single-tracking-call plan shape
```

**Test cases** — `tests/gate-3/`
*Unit:* payload correct for each order status · a ticket with no linked order returns a clean
"no order" result rather than throwing · no policy verdict ever appears in the output.
*Contract:* MCP tool envelope conformance · `CONTEXT_REQUIRED` refusal when context hasn't run ·
`CYCLE_LIMIT` at `cycle_count >= 3` · payload matches §4.2.
*Integration (real CockroachDB + real Gateway):* specialist reads real `order_history` via
`SqlAdapter` · the same suite passes via `McpAdapter` (or is explicitly skipped with the Gate 1
finding recorded, if MCP auth proved unviable) · pooled connection is reused across invocations rather
than reopened · seed script is idempotent across repeat runs.
*Supervisor integration:* supervisor forms a plan containing one tracking call; the tool receives the
job, completes it, returns to the supervisor; the supervisor incorporates the result and produces a
response; the trace records one tracking step.

*Pass criteria:* **(a)** the specialist calls CockroachDB, fulfils its task, and returns output;
**(b)** the supervisor builds a plan containing a call to the specialist, the specialist receives the
job, completes its work, and sends information back to the supervisor.

*Deliberately not proven here:* any policy verdict or escalation-by-rule (Gates 4, 5) · precedent
retrieval (Gate 6) · multi-specialist plans (Gate 7) · UI (Gate 8).

### Gate 4 — Refund Specialist + Policy Ingestion · `gate-4-refund-specialist`

Build the refund specialist end to end: the deterministic refund engine, its policy document and
loader, the Lambda module published as an AgentCore Gateway MCP tool, and its integration into a
single-specialist supervisor plan.

*Provision first:* `refund-policy.json` uploaded to the S3 policy bucket · refund Lambda target
registered with the AgentCore Gateway · `s3:GetObject` scoped to that bucket on the Lambda role.

**What gets built**

- **`evaluateRefund(order, request, now, params)`** in `packages/policy` — a pure function: no I/O, no
  LLM, no clock access. `now` is injected so tests are deterministic. Returns `{ verdict, reasonCode }`.
- **Decision table** (v1 defaults; values come from the policy document, never hardcoded). Rules
  evaluated in order, first match wins:

  | # | Order status | Order value | Time condition | Verdict | Reason code |
  |---|---|---|---|---|---|
  | R1 | not yet shipped (`processing`) | **any** | `now − created_at ≤ 7 days` | `auto_approve` | `WITHIN_7_DAYS_PRE_SHIPMENT` |
  | R2 | `shipped_back_to_sender` | `< $300` | `now − received_at ≤ 30 days` | `auto_approve` | `RETURNED_UNDER_300_WITHIN_30_DAYS` |
  | R3 | anything else — incl. no linked order, or `received_at` null in R2 | — | — | `escalate` | `REFUND_POLICY_ESCALATION` |

  Boundary semantics are normative: *"within N days"* is **inclusive** (exactly 7 or 30 days still
  qualifies); `< $300` is **strictly** under 30 000 cents. All comparisons in UTC.
- **`refund-policy.json` in S3** — `prose` (human-editable) + `params`
  (`preShipmentRefundWindowDays`, `returnedRefundWindowDays`, `autoApprovalLimitCents`) + `version`.
- **Policy loading** through the **shared document loader**: TTL (default 5 min) + ETag revalidation,
  zod-validated params, last-known-good fallback. See *Running gates in parallel* — the loader is
  generic and document-key-parameterized; if Gate 4 runs first it creates it with **no refund-specific
  logic inside**.
- **Refund specialist Lambda** as a Gateway MCP tool, returning
  `{ verdict, reasonCode, policyCitation, explanation }`. The LLM writes only `explanation`, citing the
  current policy prose — it **never** decides eligibility.
- **Deterministic side effect:** on `escalate` the Lambda itself sets `tickets.status = 'escalated'`.
- **Durable guards + `TraceSink`** consumed as built in Gate 2; the trace records `reasonCode` and
  `policyVersion`.

*Schema:* **no new tables.** Uses `customers`, `tickets`, `orchestration_state` (Gate 2) and
`order_history` (Gate 3).

**Fixtures** — `fixtures/gate-4/`

```
inputs/
  orders/         R1 boundaries (day 6/7/8 pre-shipment) · R2 boundaries (day 29/30/31 × $299.99/$300.00/$300.01)
                  every order_history.status value · no-linked-order · received_at-null
  policy/         refund-policy-v1.json · refund-policy-v2.json (windows widened, proves refresh)
                  refund-policy-malformed.json (missing params field)
  supervisor/     harness input for a plan containing exactly one refund call
  orchestration/  context-not-called · cycle_count=3
expected/
  verdicts.json     verdict + reasonCode per order input
  envelopes.json    MCP tool request/response shapes, incl. refusal and cycle-limit
  plan.json         expected single-refund-call plan shape
  transitions.json  expected tickets.status after each verdict
```

**Test cases** — `tests/gate-4/`
*Unit (`evaluateRefund`, all boundaries mandatory):* day 6 → `auto_approve`, **day 7 → `auto_approve`**
(inclusive), day 8 → `escalate` for R1 · R1 approves **irrespective of order value** (a $5,000
pre-shipment refund still auto-approves — the rule has no value condition) · day 29/**30**/31 for R2 ·
$299.99 → `auto_approve`, **$300.00 → `escalate`** (strict), $300.01 → `escalate` · every
`order_history.status` value routed correctly · no linked order → R3 · `received_at` null under R2 →
R3 · params widened in the document changes verdicts (proves values come from the document, not code) ·
two different injected `now` values with otherwise identical inputs agree (proves no clock access).
*Contract:* response conforms to the MCP tool envelope · `CONTEXT_REQUIRED` refusal with **no work
performed** when `context_called_at IS NULL` · `CYCLE_LIMIT` at `cycle_count >= 3` · `policyCitation`
present on every verdict.
*Integration (real S3 + real CockroachDB):* real `refund-policy-v1.json` params drive verdicts ·
malformed params fail loudly naming the S3 key and field, with no silent default · edit to v2, re-read
after TTL, new verdict with new `version` recorded · simulated S3 outage falls back to last-known-good
rather than no policy · an `escalate` verdict actually flips `tickets.status` to `escalated`.
*Supervisor integration:* supervisor forms a plan with exactly one refund call; the tool completes and
returns; the supervisor produces a customer response on `auto_approve` and an **escalation to a human**
on `escalate`; the trace records one refund step with its `policyVersion`.

*Pass criteria:* **(a)** refund specialist fully working with **mock input from the supervisor but real
policy input** from S3; **(b)** plugged into the full workflow — the supervisor builds a plan calling
the refund agent and the end-to-end flow works — **including escalation to a human** as an outcome.

*Deliberately not proven here:* plans calling multiple specialists (Gate 7) · precedent retrieval
(Gate 6) · UI (Gate 8).

### Gate 5 — Dispute Specialist · `gate-5-dispute-specialist`

Build the dispute specialist end to end: the deterministic dispute engine, its policy document and
loader, the Lambda module published as an AgentCore Gateway MCP tool, and its integration into a
single-specialist supervisor plan.

*Provision first:* `dispute-policy.json` uploaded to the S3 policy bucket · dispute Lambda target
registered with the AgentCore Gateway · `s3:GetObject` scoped to that bucket on the Lambda role.

**What gets built**

- **`evaluateDispute(dispute, now, params)`** in `packages/policy` — a pure function: no I/O, no LLM,
  no clock access. `now` is injected by the caller so tests are deterministic. Returns
  `{ verdict, reasonCode }`.
- **Dispute value derivation.** `dispute.valueCents` comes from the `order_value_cents` of the order
  referenced by `tickets.order_id`. A ticket with **no linked order** is not a special case to guess
  at — it escalates by rule (D2 below).
- **Decision table** (v1 defaults; values come from the policy document, never hardcoded):

  | # | Dispute value | Verdict | Reason code |
  |---|---|---|---|
  | D1 | `< $300` (strictly under 30 000 cents) | `auto_resolve` | `UNDER_300_THRESHOLD` |
  | D2 | `≥ $300`, **or no linked order** | `escalate` | `OVER_300_THRESHOLD` |

  Boundary semantics are normative: `< $300` is **strictly** less than 30 000 cents — exactly
  `$300.00` escalates. All comparisons in UTC.
- **`dispute-policy.json` in S3** — one document pairing human-editable `prose` with a
  machine-readable `params` block (`autoResolveLimitCents`, `precedentLimit`) and a `version`.
- **Policy loading** through the shared document loader: TTL (default 5 min) + ETag revalidation,
  zod-validated params, last-known-good fallback on transient S3 failure. See *Shared module* below.
- **Dispute specialist Lambda**, published as an AgentCore Gateway MCP tool. Returns
  `{ verdict, reasonCode, draftResponse, informedBy }`. The LLM's only job is writing
  `draftResponse` — it **never** decides the verdict, only explains it, citing the current policy prose.
- **Deterministic side effect:** on `escalate` the Lambda itself sets `tickets.status = 'escalated'`.
  Not left to the LLM to remember.
- **Durable guards** (built in Gate 2, consumed here): refuse with `CONTEXT_REQUIRED` if
  `orchestration_state.context_called_at IS NULL`; force escalation with `CYCLE_LIMIT` at
  `cycle_count >= 3`.
- **Trace:** the dispute step — tool name, `reasonCode`, `policyVersion`, duration — is written via
  `TraceSink` (in-memory at this gate; real `agent_runs` table at Gate 6).

**Precedents come from fixtures at this gate.** On `auto_resolve` the architecture has the dispute
specialist draft a response *informed by similar past dispute resolutions* (§4.4). But `resolutions`,
the embedding column, and the vector index do not exist until Gate 6. So this gate defines the
**`PrecedentSource` interface** and backs it with fixture precedents; Gate 6 swaps in real
embedding-based retrieval behind the same interface. `informedBy` returns the fixture precedent IDs.
This is the modularity contract working as intended — do **not** create `resolutions` early to satisfy
this, and do not block on Gate 6.

*Schema:* **no new tables.** Uses `customers`, `tickets`, `orchestration_state` (Gate 2) and
`order_history` (Gate 3).

**Fixtures** — `fixtures/gate-5/`

```
inputs/
  tickets/            dispute-under (299.99) · dispute-at (300.00) · dispute-over (450.00) · no-linked-order
  policy/             dispute-policy-v1.json · dispute-policy-v2.json (limit raised, proves refresh)
                      dispute-policy-malformed.json (missing params field)
  precedents/         fixture "similar past resolutions" fed through PrecedentSource
  supervisor/         harness input for a plan containing exactly one dispute call
  orchestration/      state rows: context-not-called · cycle_count=2 · cycle_count=3
expected/
  verdicts.json       verdict + reasonCode per ticket input
  envelopes.json      MCP tool request/response shapes, incl. refusal and cycle-limit envelopes
  plan.json           expected single-dispute plan shape
  transitions.json    expected tickets.status after each verdict
```

**Test cases** — `tests/gate-5/`

*Unit (`evaluateDispute`, all boundaries mandatory):* $299.99 → `auto_resolve`/`UNDER_300_THRESHOLD`
· **$300.00 → `escalate`** (proves strict comparison) · $300.01 → `escalate` · no linked order →
`escalate`/`OVER_300_THRESHOLD` · same inputs with `autoResolveLimitCents` raised to 50 000 → $400
now `auto_resolve` (proves values come from the document, not code) · identical inputs with two
different injected `now` values produce identical verdicts (proves no clock access).

*Contract:* response conforms to the MCP tool envelope · `CONTEXT_REQUIRED` refusal is returned and
**no work is performed** when `context_called_at IS NULL` · `CYCLE_LIMIT` directive at
`cycle_count >= 3` · `informedBy` populated from `PrecedentSource` on `auto_resolve`, absent on
`escalate`.

*Integration (real S3 + real CockroachDB):* loads `dispute-policy-v1.json` and its params drive the
verdict · malformed params fail loudly naming the S3 key and field, with no silent default ·
policy edited to v2 and re-read after TTL yields the new verdict with the new `version` recorded ·
simulated S3 outage falls back to last-known-good rather than no policy · an `escalate` verdict
actually flips `tickets.status` to `escalated` in CockroachDB · guard rows produce refusal and forced
escalation against real `orchestration_state`.

*Supervisor integration:* the supervisor forms a plan containing exactly one dispute call; the tool
receives the job, completes it, and returns to the supervisor; the supervisor assembles a customer
response on `auto_resolve` and an escalation message on `escalate`; the trace records one dispute step
with its `policyVersion`.

*Pass criteria:*
- **(a)** The dispute agent is **unit-tested standalone** — every boundary above green, with the
  supervisor, S3, and database all mocked.
- **(b)** The dispute agent is **plugged into the workflow and works within a supervisor plan that
  calls it**, end to end, with escalation to a human proven as an outcome.

*Deliberately not proven here:* plans calling **multiple** specialists (Gate 7) · real
embedding-based precedent retrieval (Gate 6 — fixtures only at this gate) · any UI (Gate 8).

### Gate 6 — Full Schema & the Vector Memory Layer · `gate-6-full-schema`

Complete the schema and build **the vector database** — the learning-memory layer that is the
hackathon's central claim. Everything before this gate deliberately used fixture precedents; this gate
makes memory real.

> ### ⛔ BLOCKING — ask the user which embedding model to use before writing any code
>
> **Do not assume an embedding model. Do not default to a familiar one.** This gate cannot start until
> the user supplies three things:
>
> 1. **Model identifier** — the exact ID as the provider expresses it (resolved from the live service,
>    never recalled from memory).
> 2. **Output dimension** — sets `EMBEDDING_DIM` and therefore the `VECTOR(n)` column width.
> 3. **Which dimension to use, if the model offers several** — some models emit configurable sizes.
>
> Until all three are given, `EMBEDDING_MODEL_ID` and `EMBEDDING_DIM` stay `REPLACE_ME`, the
> `resolutions` migration **cannot be written**, and any dimension shown in these documents is
> illustrative only. Ask, wait, then build.
>
> **Why this is blocking rather than a default-and-revisit.** Every stored vector is produced by one
> model. Vectors from different models are not comparable, so a later change corrupts similarity search
> **without raising an error** — the failure looks like "retrieval got worse," not like a bug. The only
> remedy is re-embedding every row. Getting it wrong is silent and expensive; asking costs one message.

**How the vector half actually splits.** CockroachDB provides vector **storage, indexing, and
similarity search** — the `VECTOR` data type and `CREATE VECTOR INDEX` (public preview; fine to build
on, not to present as GA). It does **not** generate embeddings: the **user-specified embedding model**
produces the vectors and CockroachDB stores and searches them. Both halves are built here and neither
is optional. The model sits behind an **`EmbeddingClient` interface**, so the provider is swappable
without touching retrieval logic — but the *stored dimension* is not swappable after the fact.

*Provision first:* Gate 1's doctor already confirmed CockroachDB `VECTOR` support. Now additionally:
**access approved for the user-specified embedding model** in the target region, with the doctor's
embedding check flipped from SKIPPED to a hard check. If Gate 1's `VECTOR` check was skipped or failed,
resolve it before starting — everything below depends on it.

**What gets built**

- **Remaining tables** — `conversation_history` (customer / agent / human_agent / system turns) and
  `resolutions` (`content`, `outcome`, `source`, `rejection_comments`,
  `embedding VECTOR(<EMBEDDING_DIM>)` — width set by the user-specified model's output dimension).
- **`agent_runs`** with a **real `TraceSink`** replacing Gate 2's in-memory stub — `plan_summary`,
  `steps JSONB`, `cycles_used`, `outcome`, keyed `(ticket_id, conversation_id)`. Per §9.1 the write is
  **best-effort and off the critical path**: a failed trace insert must never invalidate a ticket
  outcome, and the §5 guards must **never read it**.
- **Vector index** — `CREATE VECTOR INDEX resolutions_embedding_idx ON resolutions (embedding)`.
- **Embedding write path** — on accept, reject-with-comments, and human reply: summarize
  ticket + conversation + outcome into `resolutions.content`, embed via the user-specified model behind
  `EmbeddingClient`, store the vector.
  **Both resolved and unresolved outcomes are embedded** (diagram note 13) — the rejection comments are
  the richest learning signal in the system.
- **`EMBEDDING_DIM` runtime assertion** — the single constant is consumed by both the DDL and the
  embedding client, and the *actual returned vector length* is asserted on every embed call, so a model
  or dimension swap fails fast instead of silently corrupting the table.
- **Retrieval path** — cosine similarity through the vector index, **always with a `LIMIT`** (default
  5), ordered by similarity with recency as tiebreak, with optional `outcome`/`source` filters (the
  dispute specialist prefers `outcome='resolved'` precedents). **Unbounded or unfiltered scans of the
  embedding column are forbidden** and that prohibition is itself tested.
- **Real `PrecedentSource`** replacing the Gate 5 fixture implementation — same interface, so the
  dispute specialist needs no modification. This is the modularity contract paying off; if the
  specialist must change, the Gate 5 interface was wrong.
- **Consolidated migrations** — the incremental per-gate migrations folded into the final schema, with
  a single clean path from empty cluster to full schema.
- **Seed corpus** — enough synthetic resolved/unresolved resolutions (~20–30 across tracking, refund,
  and dispute themes) that similarity search is meaningfully discriminating rather than trivially
  matching one row.

*Schema:* the **complete** model — adds `conversation_history`, `resolutions`, `agent_runs`, and the
vector index on top of Gates 2–3's tables.

**Fixtures** — `fixtures/gate-6/`

```
inputs/
  corpus/          ~20-30 seed resolutions across themes, resolved and unresolved, with rejection comments
  queries/         paraphrase-of-seeded (must hit top-1) · same-theme-different-problem (must NOT
                   outrank it) · unrelated (must miss) · near-duplicate pair
  outcomes/        accept · reject-with-comments · human-reply events driving the write path
  traces/          agent_runs rows incl. an oversized steps payload and a deliberately failing insert
expected/
  retrieval.json   expected ranking per query, incl. required top-1 hits
  embeddings.json  expected vector length; wrong-dimension vector that must be rejected
  schema.json      full expected table + index inventory after consolidation
```

**Test cases** — `tests/gate-6/`
*Unit:* summarization produces stable `content` for a given ticket + conversation + outcome · the
retrieval query builder always emits a `LIMIT` and applies filters (a query without a `LIMIT` is a test
failure) · dimension assertion rejects a vector of the wrong length · trace serialization produces a
structured summary, **not raw tool blobs**.
*Contract:* `PrecedentSource` real implementation satisfies the same interface as the Gate 5 fixture —
**the dispute specialist is not modified** · `TraceSink` real implementation satisfies the Gate 2
interface unchanged.
*Integration (real CockroachDB + the real embedding model):* full migration runs from an empty cluster to the complete
schema · vector index is created and actually used by the retrieval query (verify via `EXPLAIN`, not by
assumption) · **a paraphrase of a seeded resolution retrieves it top-1** · a same-theme-but-different-
problem query does **not** outrank it · unresolved outcomes with rejection comments are embedded and
retrievable · embedding a wrong-dimension vector fails fast rather than writing · **a failing
`agent_runs` insert leaves the ticket outcome intact** (proves best-effort, off critical path) · a
`SELECT` proving the §5 guards read `orchestration_state` and never `agent_runs`.
*Cross-agent (the gate's headline criterion):* the **context** clerk retrieves real precedents through
the vector index; the **refund** specialist reads and writes real tables end to end; the **dispute**
specialist auto-resolves using **real retrieved precedents** rather than fixtures, with `informedBy`
carrying real resolution IDs.

*Pass criteria:* CockroachDB is fully developed with all components — complete schema, vector column,
vector index, embedding write and retrieval paths — and **all tests of it being called by the context,
refund, and dispute agents pass**. Plus: a paraphrase of a seeded resolution retrieves it top-1; the
trace archive is written without ever being read by the §5 guards; and swapping fixture
`PrecedentSource` for the real one required **no change to any specialist**.

*Deliberately not proven here:* plans calling multiple specialists (Gate 7) · UI (Gate 8).

### Gate 7 — Multi-Specialist Plans · `gate-7-multi-agent-plans`

Prove the supervisor can coordinate **more than one** specialist in a single run — re-planning between
calls — which is the first point the reasoning loop is exercised as designed rather than as a single
hop.

*Provision first:* nothing new. All specialists and the memory layer already exist.

**What gets built**

- **Multi-step planning** in the supervisor: form a plan naming 2–3 specialists, execute them,
  **re-evaluate the plan after every response**, and either continue or finalize. No new specialists.
- **Real precedents in the loop** — the context clerk's retrieved precedents (Gate 6) now inform how
  the supervisor sequences its calls.
- **Cross-call state** in AgentCore Memory: specialist outputs accumulate for the session while the
  durable guards continue reading `orchestration_state` only.
- **Trace across multiple steps** — `agent_runs.steps` records each specialist in order with its
  `reasonCode` and `policyVersion`; `cycles_used` reflects the true count.

*Schema:* no new tables.

**Required combinations** (all three must pass):

| Plan | Why this combination |
|---|---|
| `tracking + refund` | the realistic flow — establish where the order is, then decide the money question |
| `tracking + dispute` | same shape against the dispute engine and its precedent retrieval |
| `tracking + refund + dispute` | **three calls sits exactly at the cycle cap** — proves the boundary between "completes" and "forced escalation" |

`refund + dispute` on one ticket is deliberately excluded as contrived — a ticket is normally one or
the other.

**Fixtures** — `fixtures/gate-7/`

```
inputs/
  tickets/       shipped-order-refund-request (tracking→refund) · delivered-order-dispute
                 (tracking→dispute) · ambiguous-high-value (tracking→refund→dispute, 3 calls)
                 four-call-required (must force escalation at the cap)
  supervisor/    harness inputs for each plan shape
expected/
  plans.json     expected specialist sequence per ticket
  traces.json    expected steps[] order, cycles_used, and final outcome
  escalation.json expected forced-escalation point for the four-call ticket
```

**Test cases** — `tests/gate-7/`
*Unit:* the supervisor re-evaluates its plan after each specialist response rather than executing a
fixed list · a plan is revised when a specialist returns something unexpected · plan artifacts stay
structured across steps.
*Contract:* specialist envelopes are unchanged from single-call gates — **multi-call coordination
required no specialist modification** (if it did, the tool boundary was wrong).
*Integration:* each of the three required combinations completes end to end and produces a coherent
customer response · a ticket needing a **fourth** call is **forced to escalate at the cap** rather than
continuing · `cycle_count` in `orchestration_state` matches the number of specialist calls actually
made · `agent_runs.steps` records every step in the true order · state accumulates across calls in
AgentCore Memory while every guard decision still reads `orchestration_state`.

*Pass criteria:* all three required combinations complete end to end; the 3-cycle cap still forces
escalation on a ticket that would need a fourth call; AgentCore Memory carries active state across calls
while the durable guards continue to read `orchestration_state`; and no specialist needed modification
to participate in a multi-call plan.

*Deliberately not proven here:* UI (Gate 8).

### Gate 8 — UI & End-to-End Wiring · `gate-8-ui`

Put a human face on the system and close the loop from customer submission through human resolution
back into memory. This is the **only gate with an open-ended, feedback-driven pass criterion** — it is
not done when the tests pass, it is done when the user says so.

*Provision first:* the `ticket-handler` Function URL from Gate 2 reachable from wherever the web app
runs · web app environment carrying the database URL and Bedrock credentials (its server routes write
status changes and call the embedding model directly) · shared queue password set.

**What gets built**

- **`/submit`** (public) — email + title + description. The server route matches the email against
  `customers` case-insensitively, then **lists that customer's orders so they pick the one the ticket
  concerns**, populating `tickets.order_id`. An unknown email creates a customer with no orders, whose
  order-specific questions then escalate by rule (R3/D2) rather than erroring.
- **Per-ticket access token** — `tickets.access_token` generated at submit (cryptographically random,
  ~32 bytes base64url). `/ticket/[id]?t=<token>` is the customer's only credential. Every
  customer-facing route compares tokens with a **constant-time** check and returns **404 on mismatch**
  (not 403 — don't confirm the ticket exists).
- **Wait-on-page reply** — the browser holds the submit request while the agent chain runs (~30–90 s)
  showing progress, then renders the reply with **accept** and **reject-with-comments** inline.
  *Fallback already sanctioned by the architecture:* if real latency exceeds browser or Function-URL
  comfort, switch to polling the tokenized ticket route — same token model, no schema change.
- **Accept / reject-with-comments** — server routes calling the **shared learning-loop functions**, not
  reimplementations. Accept → `resolved`, `source='agent'`, embed. Reject → `unresolved`,
  `rejection_comments` recorded, embed. Rejection comments are **mandatory** on the reject path.
- **`/queue`** (shared-password gated) — lists `status IN ('escalated','unresolved')`, opens
  `/queue/[id]` with full detail, the agent's reply, **and the `agent_runs` reasoning trace** so the
  human sees why it escalated instead of re-deriving it (§9.1's primary payoff).
- **Human reply** → `resolved`, `source='human'`, `conversation_history` row with
  `role='human_agent'`, embedded like any other outcome.
- **No RBAC** — anyone past the queue password can act on any queued ticket. Deliberate scope (§13).

*Schema:* **no new tables.** Consumes the complete Gate 6 model.

**Fixtures** — `fixtures/gate-8/`

```
inputs/
  customers/    known-email-with-orders · known-email-no-orders · unknown-email
  tokens/       valid · wrong · malformed · missing
  outcomes/     accept · reject-with-comments (incl. empty comment, must be refused)
  queue/        escalated ticket · unresolved ticket · already-resolved (must not be actionable)
expected/
  routes.json     expected status codes per token case (404 on mismatch, never 403)
  transitions.json expected status + resolutions row per action
```

**Test cases** — `tests/gate-8/`
*Unit / component:* submit form validates and surfaces the order picker only when the customer has
orders · reject cannot be submitted with an empty comment · accept and reject call the shared
learning-loop functions rather than issuing their own SQL.
*Contract:* **a wrong, malformed, or missing token returns 404** on every customer-facing route ·
token comparison is constant-time · an already-`resolved` ticket exposes no action controls.
*Integration (full stack):* submit → agent chain via the real Function URL → reply rendered · accept →
`resolved` + `resolutions` row + embedding written · reject-with-comments → `unresolved` + comments
persisted + embedded · escalated ticket appears in `/queue` **with its reasoning trace** · human reply →
`resolved`, `source='human'`, embedded · unknown-email submission with an order question escalates
cleanly rather than erroring.
*End-to-end memory proof:* resolve ticket A, then submit a similar ticket B and confirm the context
clerk retrieves A's resolution — **the learning loop closing, visible in the UI.**

*Pass criteria:* **UI refinement iterates until all user feedback is incorporated and explicit user
permission to finalise is obtained.** The tests above are the floor, not the finish line: passing them
does not close this gate, and the gate stays open through as many feedback rounds as the user wants.

*Deliberately not proven here — and out of scope for the project* (ARCHITECTURE.md §13): multi-turn
customer chat · email intake or outbound email · RBAC beyond the queue password and per-ticket tokens ·
real payment execution (verdicts are recorded and communicated; no money moves) · hosted web deployment
(the app runs locally for the demo) · production hardening such as multi-region, rate limiting, or PII
handling beyond the demo dataset.

### Running gates in parallel

Gates may be run concurrently where they are genuinely independent — Gates 4 and 5 (refund and
dispute) are the natural pair. Three coordination rules make that safe.

**1. Branch from a base that already contains your prerequisites.** Because gates are not merged to
`main` without explicit approval (working agreement 4), a parallel gate must be cut from the branch of
its last prerequisite, not from a stale `main`. Gates 4 and 5 both depend on Gate 3 (`order_history`,
AgentCore Gateway), so both branch from `gate-3-tracking-specialist`.

**2. Shared modules get exactly one owner.** The **S3 policy document loader** (prose + params, TTL +
ETag revalidation, zod validation, last-known-good fallback) is needed by both the refund and dispute
specialists. It is generic and **parameterized by document key** — it must contain no refund- or
dispute-specific logic. When running these gates in parallel, build it **once** on a short-lived
`shared-policy-loader` branch cut from `gate-3-tracking-specialist`, merged into both gate branches
before either specialist is written. Whichever gate builds it inline instead forces the other to
rebase — the collision worth avoiding.

**3. Cross-gate criteria belong to whichever gate finishes last.** "Refund and dispute working
*alongside* each other" cannot be proven by either gate in isolation. It is verified by **whichever of
Gates 4 and 5 completes second**: that gate's integration suite must show the supervisor routing
correctly to each specialist in *separate* single-specialist plans, with neither specialist's policy
document or verdict leaking into the other. Plans that call both in a single run stay out of scope
until Gate 7.

Gates 6, 7 and 8 are **not** parallelizable against each other: Gate 7 needs Gate 6's memory layer to
retrieve real precedents, and Gate 8 wires up whatever Gate 7 produces.

### Superseded checkpoint structure

The former CP0–CP10 Phase A / Phase B plan is retained below for reference only. **The gates above
are authoritative.** Where the two disagree, follow the gates.

<details>
<summary>Former Phase A — offline build (superseded)</summary>

No AWS account, cluster, or credential required. `pnpm test` stays green at every checkpoint.
Ordered so the zero-config, highest-value work lands first.

| CP | Scope | Verified by |
|---|---|---|
| **CP0** | All docs. Monorepo scaffold, TS, Vitest, `config.ts` with the full placeholder set, `.env.example`, `pnpm check:config`. | `pnpm test` green on an empty suite; `check:config` lists every outstanding placeholder |
| **CP1** | `packages/policy` — refund + dispute engines, parameterized by `PolicyParams`; the `params`-block schema and v1 default policy documents (prose + params JSON). | Exhaustive boundary tests: $299/$300/$301, day 6/7/8, day 29/30/31, every order status — plus tests proving changed params change verdicts. Zero LLM calls, zero I/O in the package |
| **CP2** | `packages/db` — migration SQL for all tables + vector index, pooled connection module, `TicketDataPort`, `SqlAdapter`, `McpAdapter`, seed script covering every policy boundary. Written, not yet run live. | Unit tests against a mocked port; migrations parse; seed idempotent by construction |
| **CP3** | `packages/agents` — Bedrock model, AgentCore runtime/memory/gateway clients, and Titan clients behind interfaces; embedding write path, similarity search with type filter, ordering and `LIMIT`, dimension assertion. | Unit tests with mocked Bedrock/AgentCore clients; a fake-embedding retrieval test proves ranking logic |
| **CP4** | Four specialist Lambdas exposed as AgentCore Gateway/MCP tools, the **context-first guard**, the **cycle counter**, and the policy-document loader (S3 behind an interface, TTL + ETag cache, zod-validated params, last-known-good fallback). | Per-handler unit tests with mocks; tool-contract tests; guard tests prove refusal and forced escalation at cycle 3; loader tests prove refresh-on-edit and loud failure on malformed params |
| **CP5** | AgentCore TypeScript supervisor with a Bedrock model client, AgentCore Memory state contract, Gateway/MCP tool client, and plan→evaluate→escalate behavior. `ticket-handler` Function URL Lambda invokes the runtime (`InvokeAgentRuntime` behind an interface) and provides the post-hoc safety net (empty/unresolved response → escalate). Learning-loop write path as shared package functions — accept, reject-with-comments, and human reply all persist + embed — consumed later by the web app's server routes. | Unit tests drive a fully mocked ticket through context, specialist calls, resolve, reject, and escalate paths; tests prove AgentCore Memory is used for active state while durable guards use `orchestration_state` |
| **CP6** | `infra/cdk` + AgentCore deployment configuration — AgentCore Runtime supervisor, AgentCore Memory, AgentCore Gateway/MCP Lambda targets, Function URL Lambda, S3, and least-privilege IAM. Placeholder context values. | `cdk synth` and AgentCore configuration validation succeed against placeholder configuration — no deploy, no account needed |
| **CP7** | `apps/web` (Next.js) — submit form with email match + order picker, wait-on-page reply view, token-gated customer routes, gated human queue (`escalated`/`unresolved`), detail view. Server routes wire accept / reject-with-comments / human reply to the CP5 package functions. Against a mocked backend. | Builds; component tests cover accept and reject-with-comment submission; a route test proves a wrong token is refused |

</details>

<details>
<summary>Former Phase B — activation (superseded)</summary>

The first point real credentials are needed.

| CP | Scope | Verified by |
|---|---|---|
| **CP8** | **Repo owner (human):** AWS account, Bedrock model access, AgentCore service permissions, and CockroachDB Cloud cluster. Then resolve real model IDs, fill every placeholder, deploy the AgentCore supervisor/Memory/Gateway prerequisites, run migrations + seed, and settle `DB_ACCESS_MODE` by trying `McpAdapter` and falling back to SQL. | `pnpm check:config` clean; direct AgentCore CLI invocation succeeds; `pnpm test:integration` green against the real cluster, including a paraphrase retrieving a seeded resolution top-1 |
| **CP9** | Deploy the Function URL Lambda and remaining CDK resources. Wire the Function URL into the web app. End-to-end runs. | `curl` reaches the Function URL, which invokes AgentCore; a tracking question is resolved; an out-of-policy refund is escalated; resolve ticket A then submit similar ticket B and assert context retrieved A; manual pass of submit → reject with comment → queue → human reply → resolved |
| **CP10** | *(cut line)* CloudWatch structured logs with correlation IDs, latency/cost notes, demo runbook, `cdk destroy` teardown. | Runbook executes start-to-finish; teardown leaves no billable resources |

**Cut lines.** If time runs short: CP10 degrades to structured logging plus a written runbook, and
CP7 degrades to submit-form-only with the human queue driven by script.

</details>

## Verification bars

**That each gate is genuinely modular.** `pnpm test:gate N` passes without running any other gate's
suite, and every fixture that gate needs lives under `fixtures/gate-N/`. If a gate cannot be tested
without a later gate's code, the boundary is wrong.

**That interfaces held.** The clearest signal the modularity contract worked: Gate 6 swaps fixture
`PrecedentSource` and in-memory `TraceSink` for real implementations **without editing any specialist**,
and Gate 7 adds multi-call coordination **without editing any specialist**. If either forces changes
downstream, the earlier interface was wrong and that is worth raising rather than patching.

**That manual provisioning stays honest.** Since there is no IaC, `pnpm doctor` is the only check that
the environment matches intent. It must be run — and green — at the start of every gate that touches
real infrastructure, not just at Gate 1. `docs/PROVISIONING.md` must contain every resource actually
created, or rebuilding is impossible.

**That no gate reaches beyond its schema.** A gate's tests must not depend on tables a later gate
creates. Gates 2–5 use only the minimum schema listed for them; the full schema arrives at Gate 6.

**That the docs stay self-consistent.** Every table and column named in the gates exists in
[ARCHITECTURE.md](ARCHITECTURE.md) §10 — including `agent_runs`; every pass criterion names a
runnable command or a concrete manual check; every placeholder in `config.ts` appears in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) with a stated source.

**That gate pass is evidenced, not asserted.** Each gate ends with Claude presenting test output
plus, where the gate touches real infrastructure, the `pnpm doctor` report — then **waiting for
explicit user confirmation before opening any pull request**, and never merging to `main` unless asked.

**That the system works.** By Gate 7: a ticket in, an agent resolution or an escalation out, and the
memory loop demonstrably closing when a similar second ticket retrieves the first one's resolution.
