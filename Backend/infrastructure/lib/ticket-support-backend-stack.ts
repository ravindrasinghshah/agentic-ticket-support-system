import * as path from "node:path";
import { CfnOutput, Duration, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  COCKROACH_CLOUD_MCP_ENDPOINT,
  type DeploymentConfig,
} from "./deployment-config";

const SUPERVISOR_TIMEOUT = Duration.minutes(13);
const QUEUE_VISIBILITY_TIMEOUT = Duration.minutes(14);

export interface TicketSupportBackendStackProps extends StackProps {
  readonly deploymentConfig: DeploymentConfig;
  /** Override used by infrastructure tests and non-standard repository layouts. */
  readonly lambdaSourceDirectory?: string;
}

export class TicketSupportBackendStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: TicketSupportBackendStackProps,
  ) {
    const {
      deploymentConfig,
      lambdaSourceDirectory: sourceOverride,
      ...stackProps
    } = props;
    super(scope, id, stackProps);

    const lambdaSourceDirectory =
      sourceOverride ?? path.resolve(__dirname, "../../app/SupervisorAgent");

    Tags.of(this).add("Application", "agentic-ticket-support-system");
    Tags.of(this).add("Environment", deploymentConfig.stage);

    const deadLetterQueue = new sqs.Queue(this, "AgentDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    const jobQueue = new sqs.Queue(this, "AgentJobQueue", {
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: deadLetterQueue,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: QUEUE_VISIBILITY_TIMEOUT,
    });

    const commonEnvironment = {
      COCKROACH_CLOUD_MCP_ENDPOINT,
      COCKROACH_CLOUD_CLUSTER_ID: deploymentConfig.cockroachCloudClusterId,
      COCKROACH_CLOUD_MCP_API_KEY: deploymentConfig.cockroachCloudMcpApiKey,
      COCKROACH_CLOUD_DATABASE: deploymentConfig.cockroachCloudDatabase,
      COCKROACH_CLOUD_MCP_TOOL_TIMEOUT_MS: "20000",
    };
    const commonFunctionProps = {
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      depsLockFilePath: path.join(lambdaSourceDirectory, "package-lock.json"),
      bundling: {
        externalModules: ["@aws-sdk/client-s3"],
        format: lambdaNodejs.OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        target: "node22",
      },
    } satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

    const jobApi = new lambdaNodejs.NodejsFunction(this, "JobApiFunction", {
      ...commonFunctionProps,
      entry: path.join(lambdaSourceDirectory, "job-api.ts"),
      handler: "handler",
      description: "Public ticket submission and status API",
      environment: {
        ...commonEnvironment,
        CORS_ALLOWED_ORIGIN: deploymentConfig.corsAllowedOrigin,
        JOB_QUEUE_URL: jobQueue.queueUrl,
      },
      logGroup: this.createLogGroup("JobApiLogGroup"),
      memorySize: 512,
      timeout: Duration.seconds(30),
    });
    jobQueue.grantSendMessages(jobApi);

    const jobApiUrl = jobApi.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedHeaders: ["content-type"],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedOrigins: [
          deploymentConfig.corsAllowedOrigin,
          "http://localhost:3000",
        ],
        maxAge: Duration.minutes(5),
      },
    });

    const supervisor = new lambdaNodejs.NodejsFunction(
      this,
      "SupervisorFunction",
      {
        ...commonFunctionProps,
        entry: path.join(lambdaSourceDirectory, "supervisor.ts"),
        handler: "handler",
        description:
          "Runs the bounded Strands supervisor for queued ticket jobs",
        environment: {
          ...commonEnvironment,
          AGENT_TIMEOUT_MS: "720000",
          GROQ_API_KEY: deploymentConfig.groqApiKey,
          GROQ_MODEL_ID: deploymentConfig.groqModelId,
        },
        logGroup: this.createLogGroup("SupervisorLogGroup"),
        memorySize: 1024,
        ...(deploymentConfig.supervisorReservedConcurrency > 0
          ? {
              reservedConcurrentExecutions:
                deploymentConfig.supervisorReservedConcurrency,
            }
          : {}),
        timeout: SUPERVISOR_TIMEOUT,
      },
    );
    supervisor.addEventSource(
      new lambdaEventSources.SqsEventSource(jobQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    const deadLetterEscalation = new lambdaNodejs.NodejsFunction(
      this,
      "DeadLetterEscalationFunction",
      {
        ...commonFunctionProps,
        entry: path.join(lambdaSourceDirectory, "dead-letter.ts"),
        handler: "handler",
        description: "Safely escalates jobs after SQS retries are exhausted",
        environment: commonEnvironment,
        logGroup: this.createLogGroup("DeadLetterEscalationLogGroup"),
        memorySize: 512,
        timeout: Duration.seconds(30),
      },
    );
    deadLetterEscalation.addEventSource(
      new lambdaEventSources.SqsEventSource(deadLetterQueue, { batchSize: 1 }),
    );

    new CfnOutput(this, "JobApiUrl", {
      description: "Public ticket and job API endpoint",
      value: jobApiUrl.url,
    });
    new CfnOutput(this, "JobQueueUrl", { value: jobQueue.queueUrl });
    new CfnOutput(this, "DeadLetterQueueUrl", {
      value: deadLetterQueue.queueUrl,
    });
  }

  private createLogGroup(id: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      retention: logs.RetentionDays.ONE_MONTH,
    });
  }
}
