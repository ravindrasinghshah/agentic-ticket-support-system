/**
 * AgentCore availability.
 *
 * This is the single riskiest unknown in the whole build: the supervisor is hosted on
 * AgentCore Runtime, its session state lives in AgentCore Memory, and the specialists are
 * published through AgentCore Gateway. AgentCore's regional availability is limited, so if
 * the chosen region does not offer it, that must surface on day one — not at Gate 2 with a
 * supervisor already written against it.
 *
 * The probe calls the three List APIs. An empty list is a PASS: it proves the service
 * answers in this region and IAM allows the call. Nothing is provisioned yet at Gate 1, so
 * an empty list is the expected result.
 */

import { ConfigurationError } from '@ats/core';
import { fail, pass, type CheckOutcome } from '../report.ts';
import {
  credentialRemediation,
  describeError,
  errorName,
  isCredentialError,
  type CheckDefinition,
} from './types.ts';

export const agentCoreAvailableCheck: CheckDefinition = {
  id: 'agentcore-available',
  title: 'AgentCore Runtime, Memory, and Gateway all answer in the target region',
  category: 'agentcore',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    let region: string;
    try {
      region = ctx.config.awsRegion();
    } catch (error) {
      if (error instanceof ConfigurationError) {
        return fail(`Configuration incomplete: ${error.key}`, error.message);
      }
      return fail(describeError(error), 'See docs/CONFIGURATION.md.');
    }

    const probe = ctx.agentcore();
    const surfaces: Array<[string, () => Promise<number>]> = [
      ['Runtime', () => probe.listAgentRuntimes()],
      ['Memory', () => probe.listMemories()],
      ['Gateway', () => probe.listGateways()],
    ];

    const counts: string[] = [];
    for (const [name, call] of surfaces) {
      try {
        const count = await call();
        counts.push(`${name}: ${count}`);
      } catch (error) {
        // Credentials first: every AWS call fails this way when they are bad, and reporting
        // it as "AgentCore is unavailable here" would send someone changing regions to fix a
        // problem that `aws configure` solves.
        if (isCredentialError(error)) {
          return fail(
            `AgentCore ${name} call failed on credentials: ${describeError(error)}`,
            credentialRemediation(),
          );
        }

        const errName = errorName(error);
        if (errName === 'UnknownEndpoint' || errName === 'EndpointError') {
          return fail(
            `AgentCore ${name} has no endpoint in ${region}: ${describeError(error)}`,
            `AgentCore is not available in ${region}. This blocks the entire build — the ` +
              'supervisor runtime, its session memory, and the specialist tool surface all ' +
              'depend on it. Pick a region that offers BOTH AgentCore and access to your ' +
              'supervisor model, set AWS_REGION to it, and re-run `pnpm doctor`. Do not ' +
              'work around this by hosting the supervisor elsewhere without raising it ' +
              'first — that is an architecture change, not a config change.',
          );
        }
        if (errName === 'AccessDeniedException') {
          return fail(
            `AgentCore ${name} denied the call: ${describeError(error)}`,
            `Grant the bedrock-agentcore-control List* permissions to your principal — at ` +
              'minimum bedrock-agentcore:ListAgentRuntimes, ListMemories, and ListGateways. ' +
              'See docs/PROVISIONING.md step 3.',
          );
        }
        if (errName === 'ValidationException') {
          return fail(
            `AgentCore ${name} rejected the request: ${describeError(error)}`,
            'The AgentCore control-plane API shape has changed under this SDK version. ' +
              'Update @aws-sdk/client-bedrock-agentcore-control and re-check the command ' +
              'names in tools/doctor/src/live-context.ts before altering the check logic.',
          );
        }
        return fail(
          `AgentCore ${name} check failed: ${describeError(error)}`,
          `Could not reach AgentCore ${name} in ${region}. Confirm the service is enabled ` +
            'for this account and that your credentials are not restricted by an SCP or ' +
            'permission boundary.',
        );
      }
    }

    return pass(
      `All three AgentCore surfaces answered in ${region} (existing resources — ` +
        `${counts.join(', ')}). Empty is expected at Gate 1; nothing is provisioned yet.`,
    );
  },
};
