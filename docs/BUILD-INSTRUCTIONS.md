# BUILD-INSTRUCTIONS.md — conventions, gate order, definition of done

The *what and why* is [ARCHITECTURE.md](../architecture.md); the *order* is
[plan.md](../plan.md). This is the *how*.

## Getting started

```bash
npm install -g pnpm     # or: corepack enable pnpm (needs an elevated shell on Windows)
pnpm install
cp .env.example .env
pnpm check:config       # what is outstanding, and where to get each value
pnpm doctor             # live infrastructure verification
pnpm test               # offline; must be green before you write anything
```

Requires Node ≥ 20.11. Internal packages have **no build step** — they export TypeScript
directly and `tsx`/`vitest` transpile on the fly. `pnpm typecheck` runs `tsc --noEmit` across
the workspace.

## Layout

```
packages/core/       config.ts (the only reader of process.env), logging, domain types,
                     the embedding-dimension resolver
packages/policy/     evaluateRefund / evaluateDispute — pure, zero deps, zero I/O   [Gate 4/5]
packages/db/         TicketDataPort + SqlAdapter + McpAdapter, migrations, seed     [Gate 3+]
packages/agents/     Bedrock model + AgentCore runtime/memory/gateway clients behind
                     interfaces, retrieval, MCP tool contracts, TraceSink
supervisor/          host-agnostic supervisor + AgentCore Runtime bundle            [Gate 2]
lambdas/             ticket-handler, context, tracking, refund, dispute             [Gate 2+]
apps/web/            submit form, gated queue, ticket detail, accept / reject       [Gate 8]
tools/doctor/        pnpm doctor — diagnostics with per-failure remediation
fixtures/gate-N/     mock inputs/, expected/, and a README stating what the gate does NOT prove
tests/gate-N/        unit/, contract/, integration/ — runnable via pnpm run test:gate N
docs/                this file, CONFIGURATION, TESTING, PROGRESS, PROVISIONING
```

There is deliberately **no `infra/`** — provisioning is manual, from
[PROVISIONING.md](PROVISIONING.md).

## Working agreements

1. **One branch per gate**, named `gate-N-<slug>`, cut from `main`.
2. **Commit and push freely** to the gate branch — nothing is ever left at risk.
3. **Opening a pull request requires explicit user confirmation** that every pass criterion is
   met. Claude presents the evidence (test output, doctor report); the user confirms.
4. **Never merge to `main`** unless the user explicitly asks.
5. **Modularity is a hard requirement.** Every component sits behind an interface with a mock.
   **No gate edits an earlier gate's module to make itself work** — if that seems necessary,
   stop and raise it as a design smell rather than quietly patching across boundaries.
6. **`pnpm doctor` is advisory, never self-healing.** It diagnoses and prescribes; the user
   performs every account and console action. It verifies but never creates.
7. **Stop and ask — never assume — on the decisions below.**

### Decisions where guessing is silent and expensive

| Decision | Gate | Why guessing costs more than asking |
|---|---|---|
| **Embedding model ID + output dimension** | **6** | Every stored vector comes from one model. Vectors from different models are not comparable, so a later change **corrupts similarity search without raising an error** — it just looks like "retrieval got worse". Only remedy is re-embedding every row |
| Supervisor foundation model ID | 2 | Affects planning quality, latency, and cost. Resolve from the live service, never from memory |
| Any policy threshold or window | 4, 5 | These are financial rules. They live in the S3 policy documents and are never invented in code |
| A schema change a gate seems to need | any | The per-gate schema minimum is deliberate; needing more usually means a boundary is wrong |
| Editing an earlier gate's module | any | Raise it as a design smell rather than patching across boundaries (rule 5) |

## Conventions

**Configuration.** Nothing reads `process.env` except `packages/core/src/config.ts`. Add a
variable by following the four steps at the bottom of [CONFIGURATION.md](CONFIGURATION.md);
two of them are enforced by a contract test.

**Boundaries.** Anything that does I/O — a model, a runtime, a database, a bucket — is an
interface in `packages/agents/src/ports/` or `packages/db/src/ports/`, with a mock beside it.
Gate 1 built all nine. Later gates add *implementations*, not new seams.

**Determinism.** Policy engines are pure functions taking `now` as an argument. They never
read the clock, never do I/O, and never call an LLM. The LLM's only job is explaining a verdict
it did not decide.

**Guards are durable.** The two orchestration invariants read `orchestration_state` in
CockroachDB — never AgentCore Memory, never `agent_runs`. Prompt-only and session-memory-only
rules are untestable and non-durable; the Lambda guard is what makes them *true*.

**Logging.** Structured JSON via `createLogger`, keyed by `ticket_id` and `conversation_id`.
No free-text-only lines on the request path.

**Comments.** Explain *why*, not *what*. A comment restating the code is noise; a comment
recording why a boundary sits where it does is what stops the next gate from moving it.

## Per-gate structure

Every gate ships the same shape, so any gate can be picked up, debugged, or upgraded alone:

```
fixtures/gate-N/
  inputs/       mock inputs — tickets, tool payloads, policy documents, seed data
  expected/     expected outputs — verdicts, reason codes, plan shapes, tool envelopes
  README.md     what this gate proves, and what it deliberately does NOT prove
tests/gate-N/
  unit/         the module in isolation, every boundary mocked
  contract/     tool request/response envelope conformance
  integration/  against real infrastructure, where the gate requires it
```

## Definition of done, per gate

A gate is done when **all** of these hold:

- [ ] Every pass criterion in plan.md for that gate is met, with evidence.
- [ ] `pnpm run test:gate N` is green **offline** — zero credentials, zero network.
- [ ] `pnpm doctor` is green, for any gate that touches real infrastructure. Not just at
      Gate 1: it is the only drift detector there is.
- [ ] `pnpm typecheck` is clean.
- [ ] `fixtures/gate-N/README.md` states what the gate proves *and does not prove*.
- [ ] No earlier gate's module was edited to make this one work.
- [ ] The gate's schema additions are the minimum it needs — nothing borrowed from a later gate.
- [ ] [PROGRESS.md](PROGRESS.md) records the outcome, any deviation, and any finding.
- [ ] **The user has confirmed the gate passes.** Then, and only then, open a PR. Never merge
      to `main` unless asked.
