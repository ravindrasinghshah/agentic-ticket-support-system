# fixtures/gate-1

## What this gate proves

- **The config system is real.** `config.ts` resolves every value in the manifest, throws by
  name on an unreplaced `REPLACE_ME`, and `pnpm check:config` lists what is outstanding and
  where to get it.
- **Every external boundary has a working mock**, so `pnpm test:gate 1` is green with zero
  credentials and zero network access.
- **Every doctor check reports in one documented shape**, and every non-passing check carries
  non-empty remediation text.
- **Each remediation path is exercised** — the fault fixtures below drive real check code
  through expired credentials, denied model access, a missing bucket, and an unsupported
  `VECTOR` type, without breaking (or even touching) real infrastructure.
- **Against real infrastructure** (`pnpm test:integration 1`, opt-in): `pnpm doctor` runs
  all-green.

## What this gate deliberately does NOT prove

- **Any agent behaviour.** No supervisor, no specialist, no plan. Gate 2 onward.
- **Any schema.** The cluster stays empty. The vector check creates a uniquely-named scratch
  table and drops it in a `finally` — it must leave nothing behind.
- **Any AWS resource *creation*.** The doctor diagnoses and prescribes; the user provisions.
  A doctor that could create resources would defeat the purpose of it being the drift detector
  for a manually-provisioned environment.
- **That the mocks behave like the real thing.** They satisfy the interfaces. Whether
  `SqlAdapter` matches `InMemoryTicketDataPort` is Gate 3's integration problem, and whether
  the mock embedding client ranks like a real one is Gate 6's.
- **Retrieval quality.** `MockEmbeddingClient` produces deterministic hash vectors. They prove
  ranking *logic* and nothing about semantic *quality*.

## Layout

```
inputs/faults/          error payloads injected into probes to exercise remediation paths
expected/doctor-report.json   the documented report shape, one of each status
```

## The fault fixtures

Each file describes an error a probe should throw. `tests/gate-1/contract` binds a fake probe
that throws it and asserts the *real* check produces a FAIL whose remediation names the actual
fix — not a stack trace.

| Fixture | Injected into | The remediation must mention |
|---|---|---|
| `expired-credentials.json` | `sts.getCallerIdentity` | refreshing credentials (`aws sso login` / `aws configure`) |
| `denied-supervisor-model.json` | `bedrock.invokeSmallest` | Bedrock console → Model access |
| `wrong-account.json` | `sts.getCallerIdentity` | `AWS_PROFILE` / `AWS_ACCOUNT_ID` mismatch |
| `missing-bucket.json` | `s3.listObjects` | creating the bucket or correcting `S3_POLICY_BUCKET` |
| `missing-probe-object.json` | `s3.getObject` | uploading the probe object |
| `agentcore-region-unavailable.json` | `agentcore.listAgentRuntimes` | choosing a region that offers AgentCore |
| `vector-unsupported.json` | `cockroach.query` (CREATE TABLE) | CockroachDB version / vector support |
| `vector-index-unsupported.json` | `cockroach.query` (CREATE VECTOR INDEX) | vector indexing being unavailable |
| `cockroach-cert-missing.json` | `cockroach` connect | `COCKROACH_SSL_ROOT_CERT` path |
| `mcp-auth-failed.json` | `mcp.listTools` | `DB_ACCESS_MODE=sql` fallback being sanctioned |
