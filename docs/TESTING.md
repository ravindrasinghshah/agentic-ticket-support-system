# TESTING.md — test strategy and how to run each tier

Three tiers. The dividing line that matters: **unit and contract tests never touch the network
or read a credential; integration tests do, and are opt-in.**

| Tier | Location | Needs credentials? | What it proves |
|---|---|---|---|
| **Unit** | `tests/gate-N/unit/` | No | The module in isolation, every boundary mocked |
| **Contract** | `tests/gate-N/contract/` | No | Envelope and report-shape conformance across a boundary |
| **Integration** | `tests/gate-N/integration/` | **Yes** | Behaviour against real CockroachDB / Bedrock / AgentCore / S3 |

## Commands

```bash
pnpm test                    # every gate's unit + contract tests, offline
pnpm run test:gate 1         # exactly gate 1's suite, offline
pnpm run test:gate 1 --watch # …in watch mode
pnpm test:integration        # every gate's integration tests, against real infrastructure
pnpm test:integration 1      # only gate 1's
pnpm typecheck               # tsc --noEmit across the workspace
pnpm doctor                  # infrastructure diagnostics (not a test, but run it first)
```

> Use `pnpm run test:gate 1`, not `pnpm test:gate 1` — pnpm's shorthand does not forward the
> trailing argument to the script.

`RUN_INTEGRATION=1` is the single switch that lets a test touch the network. It is set only by
`scripts/test-integration.mjs`; `vitest.config.ts` excludes `tests/**/integration/**` without
it. Never put it in `.env`.

## Why the tiers are split this way

**Fast tests must stay credential-free.** Every external boundary — the Bedrock model, the
AgentCore Runtime/Memory/Gateway clients, embeddings, S3 policy documents, `TicketDataPort`,
`TraceSink`, `PrecedentSource` — is an interface with a mock built at Gate 1
(`packages/agents/src/mocks/`, `packages/db/src/mocks/`). Unit tests bind those mocks, so the
default run is green on a laptop with no AWS account.

**Real infrastructure is still the authority.** The mocks satisfy the interfaces; they do not
prove the real thing behaves the same way. Anything that depends on real behaviour —
`SqlAdapter` matching the in-memory port, the vector index actually being used, whether a
paraphrase retrieves its source top-1 — belongs in the integration tier and nowhere else.

**Retrieval quality is never proven by a mock.** `MockEmbeddingClient` produces deterministic
hash vectors. They prove ranking *logic*. Gate 6's "a paraphrase of a seeded resolution
retrieves it top-1" must run against the real model, or it proves nothing.

## Per-gate isolation

`pnpm run test:gate N` runs exactly one gate's suite with **no dependency on any other gate's
tests**, and every fixture that gate needs lives under `fixtures/gate-N/`. This is a hard
verification bar, not a nicety: if a gate cannot be tested without a later gate's code, the
boundary is wrong and that is worth raising rather than working around.

Each `fixtures/gate-N/README.md` states what the gate proves **and what it deliberately does
not** — so a later reader knows which guarantees they actually have.

## Fault injection instead of broken infrastructure

Gate 1's doctor checks are tested by injecting faults into probe interfaces, not by breaking
real resources: expired credentials, a denied model, a missing bucket, an unsupported `VECTOR`
type. The *real* check code runs and its *real* remediation text is asserted on — so the
advice is verified to name the actual fix, which "has some remediation text" would not catch.
The catalogue is `fixtures/gate-1/inputs/faults/faults.json`.

## Conventions

- **Assert on content, not just shape.** A remediation test that only checks the string is
  non-empty tests nothing worth testing.
- **Inject `now`.** Policy engines take `now` as an argument and never read the clock, so
  boundary tests are deterministic. Gates 4 and 5 assert that two different injected `now`
  values with otherwise identical inputs agree.
- **Prove that no work happened**, not just that a refusal was returned. The mock
  `TicketDataPort` records every call for exactly this — a `CONTEXT_REQUIRED` refusal that
  still hit the database has not honoured the guard.
- **A test that needs the network belongs in `integration/`.** No exceptions; the offline
  guarantee is load-bearing.
