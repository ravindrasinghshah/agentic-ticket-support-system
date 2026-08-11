# Lambda ticket supervisor

The backend uses AWS Lambda, SQS, Amazon Bedrock model inference, and the authenticated managed
CockroachDB Cloud MCP service.

The Lambdas connect to `https://cockroachlabs.cloud/mcp` with a required
`mcp-cluster-id` header and a service-account API key. For the current development-only setup, both
are read from the ignored `infrastructure/.env` file and injected into the Lambda environment.
Production deployment should move the API key back to Secrets Manager.

The supervisor package layout and dependency direction are documented in
`app/SupervisorAgent/README.md`.

AWS infrastructure is defined in TypeScript under `infrastructure/`. CDK is the only active
deployment source of truth and synthesizes standard AWS CloudFormation.

## Request flow

1. The public Function URL accepts `POST /jobs` and returns `202` with a job ID.
2. The request Lambda creates durable job state through MCP and publishes a versioned SQS message.
3. The supervisor Lambda loads context first, forms and persists a plan, and runs at most three
   domain-tool calls through an allowlisted MCP boundary.
4. Clients poll `GET /jobs/{jobId}` until the job is `completed`, `escalated`, or `failed`.
5. Messages that exhaust three SQS deliveries move to a DLQ and are safely escalated.

## Build and test

```powershell
cd app/SupervisorAgent
npm install
npm test

cd ../../infrastructure
npm install
npm test
npm run synth
```

## Database and MCP

Apply `database/migrations/001_agent_jobs.sql`. The model receives only the local operations in
`database/MCP_TOOL_CONTRACT.md`; arbitrary SQL and the managed MCP `select_query` tool are
intentionally not model-facing.

## Deployment

Deployment uses the locally pinned AWS CDK CLI in `infrastructure/`. Bootstrap each AWS account and
Region once, review the proposed changes, then deploy. First copy and edit the local configuration
template; environment variables can override any file value:

```powershell
cd infrastructure
Copy-Item .env.example .env
# Replace the example values in .env. This temporary development setup reads the MCP API key here.

aws sso login
npx cdk bootstrap --termination-protection
npm run diff
npm run deploy
```

See `infrastructure/README.md` for configuration precedence, environment-variable names, and SSO
profile usage.

The Function URL is deliberately public for the demo. CORS is not authentication; use IAM or an
application authorization layer before treating this deployment as production-ready.
