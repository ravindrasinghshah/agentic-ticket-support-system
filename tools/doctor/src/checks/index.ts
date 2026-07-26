import { configPlaceholdersCheck } from './config-placeholders.ts';
import { awsCredentialsCheck, s3PolicyBucketCheck } from './aws.ts';
import {
  bedrockReachableCheck,
  embeddingModelAccessCheck,
  supervisorModelAccessCheck,
} from './bedrock.ts';
import { agentCoreAvailableCheck } from './agentcore.ts';
import {
  cockroachConnectivityCheck,
  cockroachGenRandomUuidCheck,
  cockroachMcpCheck,
  cockroachVectorSupportCheck,
} from './cockroachdb.ts';
import type { CheckDefinition } from './types.ts';

/**
 * Every check, in run order.
 *
 * Order is for readability only — each check is independent and reports on its own, so one
 * failure never masks another. Configuration comes first because a missing value is the
 * most common cause of everything below it, and its remediation is the cheapest to act on.
 */
export const ALL_CHECKS: readonly CheckDefinition[] = [
  configPlaceholdersCheck,
  awsCredentialsCheck,
  bedrockReachableCheck,
  supervisorModelAccessCheck,
  embeddingModelAccessCheck,
  agentCoreAvailableCheck,
  cockroachConnectivityCheck,
  cockroachGenRandomUuidCheck,
  cockroachVectorSupportCheck,
  cockroachMcpCheck,
  s3PolicyBucketCheck,
];

export {
  configPlaceholdersCheck,
  awsCredentialsCheck,
  s3PolicyBucketCheck,
  bedrockReachableCheck,
  supervisorModelAccessCheck,
  embeddingModelAccessCheck,
  agentCoreAvailableCheck,
  cockroachConnectivityCheck,
  cockroachGenRandomUuidCheck,
  cockroachVectorSupportCheck,
  cockroachMcpCheck,
};
export type { CheckDefinition } from './types.ts';
