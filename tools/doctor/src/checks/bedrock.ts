import { ConfigurationError, isEmbeddingModelSpecified } from '@ats/core';
import { fail, pass, skip, type CheckOutcome } from '../report.ts';
import {
  credentialRemediation,
  describeError,
  errorName,
  isCredentialError,
  type CheckDefinition,
} from './types.ts';

function configFailure(error: unknown): CheckOutcome | null {
  if (error instanceof ConfigurationError) {
    return fail(`Configuration incomplete: ${error.key}`, error.message);
  }
  return null;
}

export const bedrockReachableCheck: CheckDefinition = {
  id: 'bedrock-reachable',
  title: 'Bedrock control plane is reachable (ListFoundationModels)',
  category: 'bedrock',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    let region: string;
    try {
      region = ctx.config.awsRegion();
    } catch (error) {
      return configFailure(error) ?? fail(describeError(error), 'See docs/CONFIGURATION.md.');
    }

    try {
      const modelIds = await ctx.bedrock().listFoundationModels();
      if (modelIds.length === 0) {
        return fail(
          `ListFoundationModels succeeded in ${region} but returned no models.`,
          `Bedrock appears not to offer foundation models in ${region}. Pick a region where ` +
            'both Bedrock and AgentCore are available and set AWS_REGION accordingly — the ' +
            'agentcore-available check will confirm the second half.',
        );
      }
      return pass(`${modelIds.length} foundation models visible in ${region}.`);
    } catch (error) {
      if (isCredentialError(error)) {
        return fail(describeError(error), credentialRemediation());
      }
      const name = errorName(error);
      if (name === 'AccessDeniedException') {
        return fail(
          describeError(error),
          'IAM denies bedrock:ListFoundationModels. Attach a policy allowing ' +
            'bedrock:ListFoundationModels and bedrock:InvokeModel to the principal these ' +
            'credentials resolve to. See docs/PROVISIONING.md step 3.',
        );
      }
      if (name === 'UnknownEndpoint' || name === 'EndpointError') {
        return fail(
          describeError(error),
          `Bedrock has no endpoint in ${region}. Choose a supported region and update ` +
            'AWS_REGION in .env.',
        );
      }
      return fail(
        describeError(error),
        `Could not reach Bedrock in ${region}. Reproduce with ` +
          `\`aws bedrock list-foundation-models --region ${region}\` to separate a network ` +
          'problem from an IAM one.',
      );
    }
  },
};

export const supervisorModelAccessCheck: CheckDefinition = {
  id: 'bedrock-supervisor-model-access',
  title: 'Supervisor model access is actually granted (a real Converse call)',
  category: 'bedrock',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    let modelId: string;
    let region: string;
    try {
      modelId = ctx.config.supervisorModelId();
      region = ctx.config.awsRegion();
    } catch (error) {
      return configFailure(error) ?? fail(describeError(error), 'See docs/CONFIGURATION.md.');
    }

    try {
      // Deliberately an invocation, not a metadata read. ListFoundationModels happily
      // returns models the account has not been granted access to — that gap is exactly
      // what this check exists to close, and it only shows up on invoke.
      await ctx.bedrock().invokeSmallest(modelId);
      return pass(`Converse succeeded against '${modelId}' in ${region} — access is granted.`);
    } catch (error) {
      // Bad credentials must never be reported as "the model is not approved" — that would
      // send someone into the model-access console to fix an `aws configure` problem.
      if (isCredentialError(error)) {
        return fail(describeError(error), credentialRemediation());
      }
      const name = errorName(error);
      if (name === 'AccessDeniedException') {
        return fail(
          `Converse on '${modelId}' was denied: ${describeError(error)}`,
          `This is the classic silent gap: the Bedrock API is reachable but '${modelId}' is ` +
            `not approved for this account in ${region}. Open the Bedrock console → Model ` +
            'access → Modify model access, request the model, and wait for it to show ' +
            'Access granted (usually instant, occasionally minutes). Also confirm the IAM ' +
            'principal has bedrock:InvokeModel on the model ARN. Then re-run `pnpm doctor`.',
        );
      }
      if (name === 'ValidationException') {
        return fail(
          `Bedrock rejected model ID '${modelId}': ${describeError(error)}`,
          `'${modelId}' is not a valid model identifier in ${region}. Resolve the exact ID ` +
            `from the live service — \`aws bedrock list-foundation-models --region ${region} ` +
            '--query "modelSummaries[].modelId"` — and set BEDROCK_SUPERVISOR_MODEL_ID to ' +
            'it. Never use a model ID recalled from memory. Note that some models are only ' +
            'invocable through an inference profile ID rather than the bare model ID.',
        );
      }
      if (name === 'ResourceNotFoundException') {
        return fail(
          describeError(error),
          `'${modelId}' does not exist in ${region}. Either change AWS_REGION to one that ` +
            'offers it, or pick a model that this region does offer.',
        );
      }
      if (name === 'ThrottlingException') {
        return fail(
          describeError(error),
          'Bedrock throttled the request, so access could not be confirmed either way. ' +
            'Wait a moment and re-run `pnpm doctor`. If it persists, request a quota ' +
            'increase for on-demand InvokeModel requests.',
        );
      }
      return fail(
        describeError(error),
        `Could not invoke '${modelId}' in ${region}. Reproduce with \`aws bedrock-runtime ` +
          `converse --model-id ${modelId} --region ${region} --messages ` +
          '\'[{"role":"user","content":[{"text":"ping"}]}]\'` to see the raw service error.',
      );
    }
  },
};

export const embeddingModelAccessCheck: CheckDefinition = {
  id: 'bedrock-embedding-model-access',
  title: 'Embedding model access is granted',
  category: 'bedrock',
  // Hard check from Gate 6 onward. Before then it reports SKIPPED rather than guessing.
  gate: 6,
  async run(ctx): Promise<CheckOutcome> {
    if (!isEmbeddingModelSpecified(ctx.config)) {
      return skip(
        'Embedding model not yet specified — EMBEDDING_MODEL_ID and/or EMBEDDING_DIM are ' +
          'still REPLACE_ME.',
        'Nothing to do before Gate 6. The embedding model is a blocking user decision ' +
          '(ARCHITECTURE.md §9.2): every vector in `resolutions` comes from one model, ' +
          'vectors from different models are not comparable, and a later change corrupts ' +
          'similarity search without raising an error. This check stays SKIPPED — never ' +
          'guessed — until the user supplies the model ID, its output dimension, and which ' +
          'dimension to use if it offers several. It becomes a hard failure from Gate 6.',
      );
    }

    const modelId = ctx.config.embeddingModelId();
    const region = ctx.config.awsRegion();

    try {
      const modelIds = await ctx.bedrock().listFoundationModels();
      if (!modelIds.includes(modelId)) {
        return fail(
          `'${modelId}' is not among the ${modelIds.length} models Bedrock lists in ${region}.`,
          `Confirm the exact identifier with \`aws bedrock list-foundation-models --region ` +
            `${region}\` and correct EMBEDDING_MODEL_ID. If the model is hosted outside ` +
            'Bedrock, this check needs to be pointed at that provider instead — raise it ' +
            'rather than loosening the check.',
        );
      }
      return pass(
        `Embedding model '${modelId}' is available in ${region} at ` +
          `${ctx.config.embeddingDim()} dimensions.`,
      );
    } catch (error) {
      return fail(
        describeError(error),
        `Could not confirm access to embedding model '${modelId}' in ${region}. Grant model ` +
          'access in the Bedrock console → Model access, then re-run `pnpm doctor`.',
      );
    }
  },
};
