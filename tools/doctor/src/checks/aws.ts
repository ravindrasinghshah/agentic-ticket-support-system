import { ConfigurationError } from '@ats/core';
import { fail, pass, type CheckOutcome } from '../report.ts';
import { describeError, errorName, type CheckDefinition } from './types.ts';

/** A configuration error already names the variable and where to get it — surface it as-is. */
function configFailure(error: unknown): CheckOutcome | null {
  if (error instanceof ConfigurationError) {
    return fail(`Configuration incomplete: ${error.key}`, error.message);
  }
  return null;
}

export const awsCredentialsCheck: CheckDefinition = {
  id: 'aws-credentials',
  title: 'AWS credentials and region resolve, and match the configured account',
  category: 'aws',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    let region: string;
    let expectedAccount: string;
    try {
      region = ctx.config.awsRegion();
      expectedAccount = ctx.config.awsAccountId();
    } catch (error) {
      return configFailure(error) ?? fail(describeError(error), 'See docs/CONFIGURATION.md.');
    }

    try {
      const identity = await ctx.sts().getCallerIdentity();
      if (identity.account !== expectedAccount) {
        return fail(
          `Credentials resolve to account ${identity.account}, but AWS_ACCOUNT_ID is ` +
            `${expectedAccount} (caller: ${identity.arn}).`,
          'You are pointed at the wrong AWS account — every later check would pass or fail ' +
            'against the wrong environment. Either set AWS_PROFILE to the profile for ' +
            `account ${expectedAccount}, or correct AWS_ACCOUNT_ID in .env if you intended ` +
            `to use account ${identity.account}. Verify with ` +
            '`aws sts get-caller-identity`.',
        );
      }
      return pass(`Authenticated to account ${identity.account} in ${region} as ${identity.arn}.`);
    } catch (error) {
      const name = errorName(error);
      if (name === 'ExpiredToken' || name === 'ExpiredTokenException') {
        return fail(
          describeError(error),
          'Your credentials have expired. Refresh them — `aws sso login --profile ' +
            '<your-profile>` for SSO, or re-run `aws configure` for long-lived keys — then ' +
            're-run `pnpm doctor`.',
        );
      }
      if (name === 'CredentialsProviderError' || name === 'CredentialsError') {
        return fail(
          describeError(error),
          'No credentials were found by the AWS SDK credential chain. Run ' +
            '`aws configure --profile <name>` and set AWS_PROFILE=<name> in .env, or export ' +
            'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. See docs/PROVISIONING.md step 2.',
        );
      }
      if (name === 'UnrecognizedClientException' || name === 'InvalidClientTokenId') {
        return fail(
          describeError(error),
          'The access key is not valid for this account. Re-issue credentials in IAM and ' +
            'run `aws configure --profile <name>` again.',
        );
      }
      return fail(
        describeError(error),
        `Could not call sts:GetCallerIdentity in ${region}. Check network access and that ` +
          'AWS_REGION is a real region name. Reproduce outside the tool with ' +
          `\`aws sts get-caller-identity --region ${region}\`.`,
      );
    }
  },
};

export const s3PolicyBucketCheck: CheckDefinition = {
  id: 's3-policy-bucket',
  title: 'Policy bucket is readable — ListBucket and GetObject both succeed',
  category: 's3',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    let bucket: string;
    let probeKey: string;
    try {
      bucket = ctx.config.s3PolicyBucket();
      probeKey = ctx.config.s3DoctorProbeKey();
    } catch (error) {
      return configFailure(error) ?? fail(describeError(error), 'See docs/CONFIGURATION.md.');
    }

    const s3 = ctx.s3();

    try {
      await s3.listObjects(bucket);
    } catch (error) {
      const name = errorName(error);
      if (name === 'NoSuchBucket' || name === 'NotFound') {
        return fail(
          `Bucket '${bucket}' does not exist in this account/region.`,
          `Create it: \`aws s3 mb s3://${bucket} --region ${safeRegion(ctx)}\`, or correct ` +
            'S3_POLICY_BUCKET in .env. See docs/PROVISIONING.md step 4.',
        );
      }
      if (name === 'AccessDenied' || name === 'AccessDeniedException') {
        return fail(
          `s3:ListBucket denied on '${bucket}'.`,
          `Grant s3:ListBucket on arn:aws:s3:::${bucket} to the principal these credentials ` +
            'resolve to. Lambdas need s3:GetObject on the objects and nothing else; the ' +
            'doctor additionally lists to confirm the bucket is the one you think it is.',
        );
      }
      if (name === 'PermanentRedirect' || name === 'IllegalLocationConstraintException') {
        return fail(
          `Bucket '${bucket}' exists but lives in a different region than AWS_REGION.`,
          'Either set AWS_REGION to the bucket\'s region, or create the policy bucket in ' +
            'the region where Bedrock and AgentCore are configured. Keeping them in one ' +
            'region avoids cross-region latency on every policy load.',
        );
      }
      return fail(describeError(error), `Could not list bucket '${bucket}'. ${genericS3Advice()}`);
    }

    try {
      const bytes = await s3.getObject(bucket, probeKey);
      return pass(
        `Bucket '${bucket}' listable, and GetObject on '${probeKey}' returned ${bytes} bytes.`,
      );
    } catch (error) {
      const name = errorName(error);
      if (name === 'NoSuchKey' || name === 'NotFound') {
        return fail(
          `Bucket '${bucket}' is listable but the probe object '${probeKey}' is missing.`,
          'ListBucket and GetObject are separate permissions, so listing alone does not ' +
            'prove the Lambdas will be able to read a policy document. Upload the probe ' +
            `object: \`echo '{"probe":true}' > _doctor-probe.json && aws s3 cp ` +
            `_doctor-probe.json s3://${bucket}/${probeKey}\`. See docs/PROVISIONING.md ` +
            'step 4.',
        );
      }
      if (name === 'AccessDenied' || name === 'AccessDeniedException') {
        return fail(
          `s3:GetObject denied on '${bucket}/${probeKey}'.`,
          `Grant s3:GetObject on arn:aws:s3:::${bucket}/* — this is the exact permission ` +
            'every specialist Lambda needs to load its policy document at Gates 4 and 5.',
        );
      }
      return fail(
        describeError(error),
        `Could not GetObject '${bucket}/${probeKey}'. ${genericS3Advice()}`,
      );
    }
  },
};

function genericS3Advice(): string {
  return (
    'Reproduce outside the tool with `aws s3 ls s3://<bucket>` to separate a credentials ' +
    'problem from a bucket-policy one. See docs/PROVISIONING.md step 4.'
  );
}

function safeRegion(ctx: { config: { awsRegion: () => string } }): string {
  try {
    return ctx.config.awsRegion();
  } catch {
    return '<AWS_REGION>';
  }
}
