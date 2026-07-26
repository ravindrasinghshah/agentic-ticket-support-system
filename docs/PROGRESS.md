# PROGRESS.md — living checkpoint tracker, build log, and deviations

Day-to-day status lives here, not in [plan.md](../plan.md). Update it at the end of every gate:
what passed, what deviated, and what was found out.

## Gate status

| Gate | Branch | Status | Notes |
|---|---|---|---|
| 1 — Infrastructure verification | `gate-1-infrastructure` | **Code complete — awaiting live verification** | Offline suite green. `pnpm doctor` cannot be run all-green until the resources in PROVISIONING steps 1–6 exist |
| 2 — Supervisor + Context clerk | — | Not started | |
| 3 — Tracking specialist over MCP | — | Not started | |
| 4 — Refund specialist + policy ingestion | — | Not started | |
| 5 — Dispute specialist | — | Not started | |
| 6 — Full schema & vector memory | — | Not started | **Blocked on the user specifying the embedding model** |
| 7 — Multi-specialist plans | — | Not started | |
| 8 — UI & end-to-end wiring | — | Not started | |

---

## Gate 1 — build log

### Delivered

- **Monorepo scaffold** — pnpm workspaces, TypeScript 5.9.3, Vitest 4, `pnpm run test:gate N`
  wiring, opt-in integration tier.
- **`packages/core`** — the configuration manifest and typed `config.ts`; the
  `EMBEDDING_DIM` resolver and runtime length assertion; structured logger keyed by
  `ticket_id` + `conversation_id`; domain types and specialist envelopes transcribed from
  ARCHITECTURE.md §4, §7, and §10.
- **Nine external-boundary interfaces, each with a mock** — `ModelClient`,
  `AgentRuntimeClient`, `MemoryStore`, `GatewayToolClient`, `EmbeddingClient`,
  `PolicyDocumentSource`, `PrecedentSource`, `TraceSink`, `TicketDataPort`.
- **`tools/doctor`** — eleven independent checks, each returning a documented shape and
  carrying tailored remediation on every failure path.
- **Docs** — PROVISIONING (the by-hand runbook), CONFIGURATION (every placeholder and its
  source), TESTING, BUILD-INSTRUCTIONS, this file.
- **Fixtures** — `fixtures/gate-1/` fault catalogue and the report-shape example.

### Verification

| Pass criterion | Status |
|---|---|
| (b) `pnpm run test:gate 1` green, every boundary mocked, zero network | **Met** — 139 tests, 8 files. `pnpm typecheck` clean |
| (a) `pnpm doctor` all-green against real infrastructure | **Outstanding** — requires PROVISIONING steps 1–6 to be performed by the user. The tool itself is verified working end to end: it constructs real SDK clients, catches real service errors, and prints tailored remediation |

### Decisions taken during the build

| Decision | Why |
|---|---|
| **TypeScript 5.9.3, not 7.0.2** | 7.0.2 is the current `latest` (the native port), but the surrounding ecosystem — `@types/*`, and Next.js at Gate 8 — is uniformly tested against 5.x. A toolchain regression five gates from now would be an expensive surprise for no benefit at this stage. Revisit at Gate 8 if desired |
| **Boundary interfaces live where the plan's repo layout puts their implementations** | `TicketDataPort` in `packages/db`, the AgentCore/model/embedding clients in `packages/agents`. Gates 3 and 6 then *add* implementations rather than moving an interface, which would violate working agreement 5 |
| **`PolicyDocumentSource` placed in `packages/agents`** | The repo layout in plan.md does not assign the S3 policy-document boundary a home. `packages/policy` is specified as pure with zero I/O, so an I/O boundary cannot live there; `packages/agents` is the package for external clients behind interfaces. **Flagged for review** — if it belongs elsewhere, moving it now is cheap |
| **`EMBEDDING_DIM` is a resolver, not a literal constant** | plan.md calls for "a single constant consumed by both the DDL and the embedding client", but the value is a blocking Gate 6 user decision. A single resolver keeps the "written down exactly once" property while letting it be genuinely absent today |
| **`S3_DOCTOR_PROBE_KEY` added to the manifest** | The doctor must prove `s3:GetObject`, but no policy document exists until Gate 4, and `ListBucket` is a separate permission. A tiny probe object closes the gap without inventing a policy document early |
| **The doctor proves model access with a real one-token `Converse` call** | `ListFoundationModels` returns models the account has not been granted. Metadata cannot detect the gap this check exists to catch |
| **The `VECTOR` check creates and drops a scratch table** | `CREATE VECTOR INDEX` cannot be proven any other way. The table is uniquely named and dropped in a `finally`; an integration test asserts the cluster is left with no tables at all |
| **Credential-shaped errors are handled before every domain-specific error** | Found by smoke-testing the live probes with deliberately invalid keys (see below) |
| **`.env` is read by the doctor CLI, shell environment wins** | A hand-provisioned setup keeps its values in `.env`; requiring them to be exported would make the doctor awkward exactly where it is most needed. Parsed by a 30-line loader (`tools/doctor/src/env-file.ts`) rather than a dependency, and it returns a record instead of mutating `process.env`, so the "only config.ts reads process.env" rule still holds |

### Bug found and fixed during the build

The live probes were smoke-tested with deliberately invalid AWS keys and hostnames pointing at
nothing — no real infrastructure involved. This exercised `live-context.ts`, which the mocked
unit tests by definition cannot reach, and surfaced a real defect:

> Every AWS call fails with `UnrecognizedClientException` when credentials are bad. The
> AgentCore check folded that into its "no endpoint in this region" branch and reported
> **"AgentCore is not available in us-east-1 — this blocks the entire build"** for what was
> actually an `aws configure` problem. The Bedrock model-access check had the same shape and
> would have sent someone into the model-access console for the same non-reason.

A misdiagnosis is worse than no diagnosis — it is confidently wrong and costs an afternoon.
Credential-shaped errors are now detected first and get their own remediation, and nine
regression tests pin the behaviour, including one asserting a genuine `AccessDeniedException`
is *still* reported as an access problem so the new branch cannot swallow real failures.

### Findings

*(To be completed once `pnpm doctor` has been run against real infrastructure. Record here:
the region chosen and why; whether AgentCore was available there; whether CockroachDB
`VECTOR` and `CREATE VECTOR INDEX` are supported on the cluster version provisioned; and —
importantly — **whether the CockroachDB MCP connector authenticated**, since that determines
whether `McpAdapter` is viable at all and whether Gate 3's MCP integration suite runs or is
explicitly skipped.)*

### Deviations from plan.md

None substantive. The three judgement calls above (`PolicyDocumentSource` placement, the
`EMBEDDING_DIM` resolver, `S3_DOCTOR_PROBE_KEY`) are recorded for review rather than treated
as settled.

### Known documentation inconsistency

plan.md links to `ARCHITECTURE.md`; the file on disk is `architecture.md`. This resolves fine
on a case-insensitive filesystem but would break on a case-sensitive one. Left alone rather
than renamed unilaterally — worth settling before the repo is cloned on Linux.

---

## Open questions for the user

| # | Question | Needed by |
|---|---|---|
| 1 | **Which embedding model**, its **output dimension**, and — if it offers several — **which dimension to use**? | **Gate 6, blocking.** Do not start Gate 6 without it |
| 2 | Which **supervisor foundation model ID** (resolved from the live service in your account/region)? | Gate 1's doctor check; confirmed at Gate 2 |
| 3 | Is `packages/agents` the right home for `PolicyDocumentSource`? | Cheap to move now, expensive after Gate 4 |
