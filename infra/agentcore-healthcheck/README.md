# AgentCore healthcheck Lambda stack

Deploy the AgentCore runtime from `AgentcoreHealthcheck` first and copy its runtime ARN. Then run:

```powershell
npm run synth --workspace @ticket-support/agentcore-healthcheck-infra -- -c agentcoreRuntimeArn=<runtime-arn>
npx cdk deploy -c agentcoreRuntimeArn=<runtime-arn>
```

The stack creates only the healthcheck Lambda, its Function URL, log retention, and the least-
privilege permission to invoke the supplied AgentCore Runtime. The Function URL defaults to
`AWS_IAM`; change that only for a short-lived manual smoke test.
