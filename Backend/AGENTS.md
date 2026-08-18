# Backend contributor guidance

The active backend deployment is the TypeScript AWS CDK app in `infrastructure/`: a Function URL
request Lambda, SQS supervisor, and DLQ escalation Lambda. Do not add a parallel SAM or handwritten
CloudFormation deployment; CDK is the single infrastructure source of truth.

Code under `app/SupervisorAgent/src` follows dependency-oriented layers: `domain`, `application`,
`agent`, `handlers`, `infrastructure`, and `config`. Keep AWS/MCP clients out of application logic;
wire concrete dependencies only in the three root Lambda entrypoints.

Preserve these invariants:

1. Load authoritative ticket context before creating an agent or plan.
2. Require a persisted plan before domain tools run.
3. Enforce the three-call limit with the durable, atomic `begin_tool_call` MCP operation.
4. Never pass the remote MCP client directly to Strands; expose only locally allowlisted typed tools.
5. Make completion/escalation conditional and transactional so SQS redelivery is harmless.
6. Customer responses never contain internal exception messages.

Build and test the Lambda package from `app/SupervisorAgent` with `npm test`. Test and synthesize
infrastructure from `infrastructure` with `npm test` and `npm run synth`; deploy with `npx cdk
deploy` only after reviewing `npx cdk diff`.

CDK deployment settings are loaded from ignored `infrastructure/.env` and
`infrastructure/config/<stage>.json` files, with shell/CI variables taking precedence. Keep only
sanitized example files in source control. The current development-only deployment reads the
CockroachDB Cloud MCP API key from the ignored `.env`; never put a real key in an example or stage
JSON file, and use Secrets Manager before production.
