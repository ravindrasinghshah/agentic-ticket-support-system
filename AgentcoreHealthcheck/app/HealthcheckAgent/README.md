# Healthcheck AgentCore runtime

This minimal AgentCore Runtime has no tools, memory, database, or S3 access. Set
`BEDROCK_MODEL_ID` to a model enabled for the target account and region before deployment.

From `AgentcoreHealthcheck`, run `agentcore validate`, then `agentcore dev` for local testing and
`agentcore deploy` to create the AgentCore runtime. Record its runtime ARN for the Lambda stack.
