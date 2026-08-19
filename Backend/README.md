# Lambda ticket supervisor

The backend uses AWS Lambda, SQS, Strands with Groq model inference, and the authenticated managed
CockroachDB Cloud MCP service. It does not depend on Bedrock model access or AgentCore.

The Lambdas connect to `https://cockroachlabs.cloud/mcp` with a required
`mcp-cluster-id` header and a service-account API key. For the current development-only setup, both
are read from the ignored `infrastructure/.env` file and injected into the Lambda environment. The
Groq and Hugging Face API keys are read from the same file but injected only into the supervisor
Lambda. Hugging Face generates query embeddings for CockroachDB vector search. Production
deployment should move all API keys to Secrets Manager.

The supervisor package layout and dependency direction are documented in
`app/SupervisorAgent/README.md`.

AWS infrastructure is defined in TypeScript under `infrastructure/`. CDK is the only active
deployment source of truth and synthesizes standard AWS CloudFormation.

## Request flow

1. The public Function URL accepts `POST /tickets`, creates the ticket plus initial conversation,
   and returns `202` with ticket, conversation, and job IDs. `POST /jobs` remains available for an
   existing ticket.
2. The request Lambda creates durable job state through MCP and publishes a versioned SQS message.
3. The supervisor Lambda invokes Groq through Strands, loads context first, forms and persists a
   plan, and runs at most three domain-tool calls through an allowlisted MCP boundary.
4. Clients poll `GET /jobs/{jobId}` until the job is `completed`, `escalated`, or `failed`.
   `GET /tickets/{ticketId}` supports customer lookup and `GET /tickets` supplies the demo admin
   dashboard.
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

The CockroachDB database is an existing external dependency; CDK and Lambda never create or migrate
it. Configure `infrastructure/.env`, then apply versioned migrations from the local workstation and
verify the schema plus runtime read/write permissions:

```powershell
cd app/SupervisorAgent
npm run db:migrate
npm run db:check
```

`db:migrate` refuses to create a database. The configured database must already exist, and the MCP
service account must have Cluster Admin or Cluster Operator access to it. Run `npm run db:seed`
only when the deterministic demo ticket is wanted; production data is never seeded automatically.

The model receives only the local operations in `database/MCP_TOOL_CONTRACT.md`; arbitrary SQL and
the native managed MCP query tools are intentionally not model-facing.

`search_resolutions` embeds the agent query with `sentence-transformers/all-MiniLM-L6-v2`, searches
the 384-dimensional vectors in `resolution_embeddings`, and returns the nearest FAQ text.

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

`npm run deploy` executes `db:check` locally before CDK. A missing database, schema drift, or
insufficient MCP read/write access stops deployment before AWS is changed.

See `infrastructure/README.md` for configuration precedence, environment-variable names, and SSO
profile usage.

The Function URL is deliberately public for the demo. CORS is not authentication; use IAM or an
application authorization layer before treating this deployment as production-ready. In
particular, the ticket list must be admin-authorized before real customer data is used.
