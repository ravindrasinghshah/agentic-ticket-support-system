import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { DeploymentConfig } from '../lib/deployment-config';
import { TicketSupportBackendStack } from '../lib/ticket-support-backend-stack';

const deploymentConfig: DeploymentConfig = {
  stage: 'test',
  cockroachCloudClusterId: '01234567-89ab-4def-8123-456789abcdef',
  cockroachCloudDatabase: 'ticket_support',
  cockroachCloudMcpApiKey: 'test-api-key',
  corsAllowedOrigin: 'https://frontend.test.example',
  groqApiKey: 'test-groq-api-key',
  groqModelId: 'openai/gpt-oss-120b',
  supervisorReservedConcurrency: 5,
};
const app = new App();
const stack = new TicketSupportBackendStack(app, 'TestTicketSupportBackend', {
  deploymentConfig,
  lambdaSourceDirectory: path.resolve(__dirname, '../../../app/SupervisorAgent'),
});
const template = Template.fromStack(stack);

describe('TicketSupportBackendStack', () => {
  it('provisions the three bounded Lambda functions', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      MemorySize: 512,
      Runtime: 'nodejs22.x',
      Timeout: 30,
      TracingConfig: { Mode: 'Active' },
      Environment: {
        Variables: Match.objectLike({
          CORS_ALLOWED_ORIGIN: deploymentConfig.corsAllowedOrigin,
          COCKROACH_CLOUD_MCP_API_KEY: deploymentConfig.cockroachCloudMcpApiKey,
          COCKROACH_CLOUD_CLUSTER_ID: deploymentConfig.cockroachCloudClusterId,
          COCKROACH_CLOUD_DATABASE: deploymentConfig.cockroachCloudDatabase,
          JOB_QUEUE_URL: Match.anyValue(),
          COCKROACH_CLOUD_MCP_ENDPOINT: 'https://cockroachlabs.cloud/mcp',
          COCKROACH_CLOUD_MCP_TOOL_TIMEOUT_MS: '20000',
        }),
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      MemorySize: 1024,
      ReservedConcurrentExecutions: deploymentConfig.supervisorReservedConcurrency,
      Runtime: 'nodejs22.x',
      Timeout: 780,
      Environment: {
        Variables: Match.objectLike({
          AGENT_TIMEOUT_MS: '720000',
          GROQ_API_KEY: deploymentConfig.groqApiKey,
          GROQ_MODEL_ID: deploymentConfig.groqModelId,
        }),
      },
    });
  });

  it('omits reserved concurrency when configured as zero', () => {
    const noReservationStack = new TicketSupportBackendStack(
      new App(),
      'TestTicketSupportBackendWithoutReservedConcurrency',
      {
        deploymentConfig: {
          ...deploymentConfig,
          supervisorReservedConcurrency: 0,
        },
        lambdaSourceDirectory: path.resolve(
          __dirname,
          '../../../app/SupervisorAgent',
        ),
      },
    );
    const noReservationTemplate = Template.fromStack(noReservationStack);
    const functions = noReservationTemplate.findResources('AWS::Lambda::Function');
    const supervisorFunction = Object.values(functions).find(
      (resource) =>
        resource.Properties?.Description ===
        'Runs the bounded Strands supervisor for queued ticket jobs',
    );

    assert.ok(supervisorFunction, 'expected the supervisor Lambda function');
    assert.equal(
      supervisorFunction.Properties?.ReservedConcurrentExecutions,
      undefined,
    );
  });

  it('configures encrypted queues, bounded retries, and partial failure reporting', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 345600,
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 840,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('keeps the Function URL public but restricts browser CORS', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
      Cors: {
        AllowHeaders: ['content-type'],
        AllowMethods: ['GET', 'POST'],
        AllowOrigins: [deploymentConfig.corsAllowedOrigin],
        MaxAge: 300,
      },
    });
  });

  it('injects the Groq key only into the supervisor and grants no Bedrock actions', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const supervisor = Object.values(functions).find(
      (resource) =>
        resource.Properties?.Description ===
        'Runs the bounded Strands supervisor for queued ticket jobs',
    );
    assert.ok(supervisor, 'expected the supervisor Lambda function');
    assert.equal(
      supervisor.Properties?.Environment?.Variables?.GROQ_API_KEY,
      deploymentConfig.groqApiKey,
    );
    for (const resource of Object.values(functions)) {
      if (resource === supervisor) continue;
      assert.equal(resource.Properties?.Environment?.Variables?.GROQ_API_KEY, undefined);
    }
    assert.equal(JSON.stringify(template.toJSON()).includes('bedrock:InvokeModel'), false);
  });

  it('publishes the API and queue URLs as stack outputs', () => {
    template.hasOutput('JobApiUrl', {});
    template.hasOutput('JobQueueUrl', {});
    template.hasOutput('DeadLetterQueueUrl', {});
  });

  it('synthesizes concrete configuration instead of deployment parameters', () => {
    const parameters = template.toJSON().Parameters as Record<string, unknown> | undefined;

    assert.equal(parameters?.CockroachCloudClusterId, undefined);
    assert.equal(parameters?.CockroachCloudMcpApiKey, undefined);
    assert.equal(parameters?.CorsAllowedOrigin, undefined);
    assert.equal(parameters?.GroqApiKey, undefined);
    assert.equal(parameters?.GroqModelId, undefined);
    assert.equal(parameters?.SupervisorReservedConcurrency, undefined);
  });
});
