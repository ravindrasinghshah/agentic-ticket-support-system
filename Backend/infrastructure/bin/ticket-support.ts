#!/usr/bin/env node
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { loadDeploymentConfig } from '../lib/deployment-config';
import { loadEnvironmentFile } from '../lib/environment-file';
import { TicketSupportBackendStack } from '../lib/ticket-support-backend-stack';

loadEnvironmentFile({ defaultFilePath: path.resolve(__dirname, '../.env') });

const app = new cdk.App();
const deploymentConfig = loadDeploymentConfig({
  configDirectory: path.resolve(__dirname, '../config'),
});

new TicketSupportBackendStack(app, 'TicketSupportBackend', {
  deploymentConfig,
  description: 'Asynchronous Lambda-based ticket supervisor',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
