# Bedrock AgentCore agentic-flow POC

## Decision and boundary

Use **Amazon Bedrock AgentCore Runtime**, not Amazon Bedrock Agents Classic, for the first AWS
healthcheck and for new environments. The POC is successful only when this path works:

```text
AgentCore CLI
  -> AgentCore supervisor runtime
  -> Context specialist Lambda (mandatory first tool)
  -> Tracking specialist Lambda (when the ticket asks about an order)
  -> Bedrock model final response
```

This is deliberately not yet a ticket-support implementation. It excludes CockroachDB, S3,
embeddings, policy evaluation, and the web app. Its purpose is to prove AWS account access,
permissions, deployment, Supervisor -> Lambda tool orchestration, and a final response before
iterative product work begins. The public **UI-entry** Lambda and its Function URL are deliberately
deferred until a UI needs an HTTP endpoint.

Amazon Bedrock Agents Classic is not used: AWS has placed it in maintenance mode and says new
customers are no longer accepted after 2026-07-30. AgentCore is the recommended path for new
environments. See [AWS's migration guidance](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html)
and the [AgentCore TypeScript quickstart](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html).

## Definition of success

An AgentCore CLI invocation of the deployed supervisor returns a non-empty generated reply
containing `AGENTCORE_HEALTHY`, after invoking Context and Tracking in order.

```json
{
  "sessionId": "healthcheck-…",
  "reply": "AGENTCORE_HEALTHY"
}
```

The test must be run twice with the same session. AgentCore traces/CloudWatch logs must show that
Context was called before Tracking and that the supervisor produced the final reply. No credential
or full prompt/response is logged.

## AWS setup steps

### 1. Prerequisites

1. Choose one supported AWS region and use it consistently for Lambda, AgentCore, and the Bedrock
   model. Record the account ID, region, and selected model ID outside source control.
2. Configure an AWS CLI profile for the deployment identity and confirm it can identify the target
   account (`aws sts get-caller-identity`).
3. Enable access to the selected Bedrock model in the Bedrock Model Catalog where the model requires
   it. Use a model available in the chosen region; do not hardcode a model ID from an example.
4. Install Node.js 20+, AWS CDK, and the AgentCore CLI (`npm install -g @aws/agentcore`). The CLI
   uses CDK to provision the runtime resources. Bootstrap CDK once in the selected account/region.

### 2. Create and deploy specialist Lambda tools

1. Create two small TypeScript Lambda functions using only fixture data:

   - `context`: accepts `ticketId` and `conversationId`, returns a fixed ticket, customer, and
     order; it writes `contextCalledAt` for that test conversation to a small POC-only DynamoDB
     orchestration-state table.
   - `tracking`: accepts `ticketId` and `orderId`, returns a fixed shipping timeline. It first
     checks the test state and returns `CONTEXT_REQUIRED` without doing work unless Context has
     already been called for that conversation.

2. Keep ticket and tracking fixture data in source for the POC. DynamoDB is used only for the
   Context-first guard; do not connect CockroachDB, S3, or policy engines. Each tool response must
   be structured JSON, not customer-facing prose.
3. Deploy the two Lambdas with CloudWatch Logs. Create an AgentCore Gateway that exposes each Lambda
   as an MCP tool. Grant the Gateway/service role permission to invoke only these two Lambda ARNs.
   Grant Context `PutItem` and Tracking `GetItem` permission only on the POC orchestration-state
   table, in addition to their CloudWatch logging permissions.
4. Invoke each tool independently with a test event. Verify Context returns fixture data, Tracking
   returns `CONTEXT_REQUIRED` before Context, and Tracking succeeds after Context.

### 3. Create and deploy the AgentCore supervisor runtime

1. Scaffold the isolated TypeScript healthcheck agent using the AgentCore CLI. The supported
   TypeScript path creates a Strands-based agent and uses a CodeZip deployment artifact:

   ```powershell
   agentcore create --name ticket-support-healthcheck --no-agent
   Set-Location ticket-support-healthcheck
   agentcore add agent --name HealthcheckAgent --type create --build CodeZip --language TypeScript --framework Strands --model-provider Bedrock --memory none
   ```

2. Replace the generated agent entry point with a supervisor instruction that requires it to:

   - call the Context tool before every other tool;
   - call Tracking for a tracking request after Context returns an order;
   - use only tool output for ticket/order facts; and
   - begin the final response with `AGENTCORE_HEALTHY`.

   Configure the AgentCore Gateway MCP client in the supervisor and register the Context and
   Tracking tools. Do not add durable memory, knowledge bases, database credentials, Refund, or
   Dispute tools in this POC.
3. Configure the selected model and AWS target in the generated `agentcore/agentcore.json` and
   `agentcore/aws-targets.json` files. Keep account-specific values uncommitted.
4. Run the agent locally with `agentcore dev`, then invoke it locally with a short healthcheck
   prompt. Fix local build/runtime errors before deploying.
5. Preview the infrastructure with `agentcore deploy --dry-run`, then deploy with
   `agentcore deploy`. It compiles/packages the TypeScript agent, synthesizes/deploys CDK resources,
   creates the AgentCore Runtime and its execution role, and configures logging.
6. Wait for deployment success and record the resulting **AgentCore Runtime ARN**. Test the
   supervisor directly through the CLI:

   ```powershell
   agentcore invoke --runtime HealthcheckAgent "Where is ticket ticket-001?"
   ```

7. Confirm the runtime execution role has only the model and Gateway permissions it needs. It does
   not need database, S3, Refund, or Dispute permissions for this test. AgentCore's control-plane
   `CreateAgentRuntime` requires a runtime role ARN; the CLI creates this as part of the standard
   deployment. The underlying API is documented at [CreateAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateAgentRuntime.html).

### 4. Deferred: UI-entry Lambda Function URL integration

Do **not** deploy the Lambda or Function URL for this POC. Add this integration only when the UI is
ready to submit requests. At that point:

1. Create a dedicated Lambda execution role with:

   - CloudWatch Logs write permissions scoped to the healthcheck log group; and
   - `bedrock-agentcore:InvokeAgentRuntime` scoped to the deployed AgentCore Runtime ARN.

   This is a different role from the AgentCore runtime execution role.
2. Deploy a Node.js 20 TypeScript Lambda in the same region, outside a VPC for this healthcheck.
   Use 512 MB memory and a 60-second timeout initially. Set environment variables:

   ```text
   AGENTCORE_RUNTIME_ARN=<deployed runtime ARN>
   AWS_REGION=<selected region>
   ```

3. Create a Lambda Function URL for the Lambda. For a command-line-only smoke test, select
   `AWS_IAM` and use a signed caller. If rapid unauthenticated testing is essential, `NONE` is
   acceptable only as a short-lived endpoint with no sensitive input, restrictive CORS, and an
   immediate cleanup date.
4. Configure CloudWatch Logs retention and output the Function URL and runtime ARN from the stack.
   Do not commit either endpoint to source code.

The Lambda must call the AgentCore **data-plane** operation `InvokeAgentRuntime`, not Classic
`InvokeAgent`. The required permission is `bedrock-agentcore:InvokeAgentRuntime`; AgentCore invokes
by runtime ARN and supports a caller-supplied runtime session ID. See
[InvokeAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html).

## Code work in this repository

1. Add an isolated `agentcore/healthcheck-agent` project (the AgentCore CLI scaffold) and retain
   its deployment configuration. This is the deployed supervisor, not a Lambda.
2. Add `lambdas/context-healthcheck` and `lambdas/tracking-healthcheck`, their fixture data, and
   unit tests for normal structured responses plus the Context-first guard.
3. Add the AgentCore Gateway/MCP configuration that exposes only those two specialist Lambdas to
   the supervisor.
4. The `lambdas/agentcore-healthcheck` HTTP handler and CDK stack are a **deferred UI-integration
   reference**, not POC deployment work. They invoke AgentCore through the runtime ARN when a UI
   requires an HTTP endpoint.
5. Verify the supervisor locally with `agentcore validate` and `agentcore dev`; then deploy the
   specialist Lambdas/Gateway and `agentcore deploy`. Do not deploy or test the UI-entry Lambda
   stack yet.

## POC verification

1. Deploy the specialist Lambdas and Gateway, then configure an enabled Bedrock model ID and the
   Gateway connection in the AgentCore runtime configuration.
2. Deploy the AgentCore supervisor and invoke it with a tracking request:

   ```powershell
   agentcore invoke --runtime HealthcheckAgent "Where is ticket ticket-001?"
   ```

3. Confirm the response contains `AGENTCORE_HEALTHY` plus the fixture tracking status.
4. Inspect the AgentCore trace and specialist Lambda logs: Context must precede Tracking. Invoke
   Tracking directly before Context once and confirm its `CONTEXT_REQUIRED` guard response.
5. Invoke a second prompt in the same CLI session and confirm it succeeds. Session-memory behavior
   is not a POC requirement because this minimal runtime intentionally has no durable memory.
6. Record date, region, model ID, runtime ARN, Gateway ARN, specialist Lambda ARNs, and observed
   latency in `docs/PROGRESS.md` once that tracker is created.

## What this changes before iterative development

The existing `architecture.md` and `plan.md` describe Agents Classic aliases and Bedrock-managed
Lambda action groups. They must be revised before CP4/CP6 implementation: AgentCore Runtime becomes
the orchestrator deployment target, and the logical context/tracking/refund/dispute specialists
become explicit tools invoked by the custom agent/orchestrator rather than Classic action-group
configuration. The same application-level safety invariants remain required, but their enforcement
will move into the tool/Lambda layer and custom orchestration code.

Do not start the full specialist implementation until this healthcheck passes and that architecture
migration is recorded.

## Cleanup

After two successful CLI invocations and recorded evidence, run the AgentCore CLI's generated
teardown/stack deletion workflow unless the runtime is being retained as a smoke test. Add and
deploy the Lambda Function URL stack only when UI work starts.
