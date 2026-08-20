#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AgentcoreHealthcheckStack } from '../lib/agentcore-healthcheck-stack.js';

const app = new cdk.App();
const runtimeArn = app.node.tryGetContext('agentcoreRuntimeArn');

if (typeof runtimeArn !== 'string' || !runtimeArn || runtimeArn === 'REPLACE_ME') {
  throw new Error(
    'Set -c agentcoreRuntimeArn=<deployed AgentCore Runtime ARN> before synthesizing or deploying.',
  );
}

new AgentcoreHealthcheckStack(app, 'AgentcoreHealthcheckLambdaStack', {
  agentcoreRuntimeArn: runtimeArn,
});
