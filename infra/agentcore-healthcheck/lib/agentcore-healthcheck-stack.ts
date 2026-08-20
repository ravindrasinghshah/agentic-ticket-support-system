import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Duration, CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface AgentcoreHealthcheckStackProps extends StackProps {
  agentcoreRuntimeArn: string;
}

export class AgentcoreHealthcheckStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentcoreHealthcheckStackProps) {
    super(scope, id, props);

    const handler = new NodejsFunction(this, 'HealthcheckHandler', {
      entry: path.join(__dirname, '../../../lambdas/agentcore-healthcheck/src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(60),
      tracing: lambda.Tracing.PASS_THROUGH,
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        AGENTCORE_RUNTIME_ARN: props.agentcoreRuntimeArn,
      },
    });

    handler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [props.agentcoreRuntimeArn],
      }),
    );

    const functionUrl = handler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    new CfnOutput(this, 'FunctionUrl', { value: functionUrl.url });
    new CfnOutput(this, 'AgentcoreRuntimeArn', { value: props.agentcoreRuntimeArn });
  }
}
