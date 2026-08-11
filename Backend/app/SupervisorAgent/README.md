# Supervisor Lambda package

This package is organized by responsibility so the agent loop can be tested without AWS or a live
MCP server.

```text
SupervisorAgent/
|-- job-api.ts                 # Function URL composition root
|-- supervisor.ts              # SQS supervisor composition root
|-- dead-letter.ts             # DLQ composition root
|-- scripts/                   # Local-only CockroachDB migrate, seed, and health commands
|-- src/
|   |-- domain/                # Validated job, plan, message, and outcome contracts
|   |-- application/           # Use cases, dependency ports, and safety rules
|   |-- agent/                 # Strands model/tool integration
|   |-- handlers/              # Lambda event parsing and response mapping
|   |-- infrastructure/        # AWS, Bedrock, and CockroachDB MCP adapters
|   `-- config/                # Environment parsing
`-- test/                      # Tests arranged to mirror the source layers
```

The three root files are intentionally small deployment entrypoints. Business flow begins in
`src/application/process-job.ts`; the model never receives the raw MCP client, only the typed tools
created by `src/application/orchestration-tools.ts`.

## Dependency direction

`handlers -> application -> domain`, while infrastructure implements ports declared by the
application layer. Composition roots are the only files that connect concrete infrastructure to
handlers and use cases.

## Environment variables

| Variable | Entrypoint | Required | Description |
| --- | --- | --- | --- |
| `COCKROACH_CLOUD_MCP_ENDPOINT` | all | no | Must be `https://cockroachlabs.cloud/mcp`; defaults to that managed endpoint |
| `COCKROACH_CLOUD_CLUSTER_ID` | all | yes | CockroachDB Cloud cluster UUID sent as the `mcp-cluster-id` header |
| `COCKROACH_CLOUD_MCP_API_KEY` | all | yes | Service-account API key; temporarily injected from the ignored deployment `.env` |
| `COCKROACH_CLOUD_DATABASE` | all | yes | Dedicated database name; project configuration uses `ticket_support` |
| `COCKROACH_CLOUD_MCP_TOOL_TIMEOUT_MS` | all | no | Per-tool timeout; defaults to 20 seconds |
| `JOB_QUEUE_URL` | job API | yes | Work queue URL |
| `CORS_ALLOWED_ORIGIN` | job API | yes | Exact frontend origin |
| `BEDROCK_MODEL_ID` | supervisor | no | Bedrock model/inference profile ID |
| `AGENT_TIMEOUT_MS` | supervisor | no | Agent deadline below Lambda and SQS deadlines |

Run `npm test` to compile and execute the unit and contract tests. The configured CockroachDB
database must be provisioned independently before using these local-only commands:

| Command | Purpose |
| --- | --- |
| `npm run db:migrate` | Apply unapplied versioned table migrations and record their checksums |
| `npm run db:check` | Verify the existing database, expected tables/columns, MCP tools, and runtime read/write permissions without persisting test rows |
| `npm run db:seed` | Optionally add the deterministic development ticket; never run automatically in AWS |
| `npm run db:setup` | Development convenience command: migrate, seed, then check |

None of the Lambda entrypoints imports the local database script or has access to MCP schema tools.
At runtime, AWS assumes the database has already passed `db:check`.

## MCP safety boundary

The infrastructure adapter uses only CockroachDB Cloud MCP's `select_query` and `insert_rows`
tools. Application operations build fixed SQL templates with validated, escaped values.
Conditional `INSERT ... ON CONFLICT DO UPDATE` statements implement durable state changes, and a
data-modifying CTE updates a terminal job and its ticket in one database statement.

The model-facing tool allowlist is separate. Never expose either native MCP query tool directly to
Strands.

For the current development-only deployment, CDK places the API key in the Lambda environment.
Use Secrets Manager before deploying to production.

The Lambda functions, SQS queues, Function URL, and IAM permissions are deployed by the TypeScript
CDK app in `../../infrastructure`.
