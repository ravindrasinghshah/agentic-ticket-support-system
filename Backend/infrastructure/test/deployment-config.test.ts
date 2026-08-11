import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { loadDeploymentConfig } from '../lib/deployment-config';

function createConfigFile(contents: Record<string, unknown>): {
  directory: string;
  cleanup(): void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-support-cdk-config-'));
  fs.writeFileSync(
    path.join(directory, 'development.json'),
    JSON.stringify(contents),
    'utf8',
  );
  return {
    directory,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

const requiredFileValues = {
  cockroachCloudClusterId: '01234567-89ab-4def-8123-456789abcdef',
  cockroachCloudDatabase: 'ticket_support',
  corsAllowedOrigin: 'https://frontend.config.example',
};

describe('loadDeploymentConfig', () => {
  it('loads a stage file and applies optional defaults', () => {
    const fixture = createConfigFile(requiredFileValues);
    try {
      const config = loadDeploymentConfig({
        configDirectory: fixture.directory,
        environment: {
          DEPLOYMENT_STAGE: 'development',
          COCKROACH_CLOUD_MCP_API_KEY: 'test-api-key',
        },
      });

      assert.equal(config.stage, 'development');
      assert.equal(config.cockroachCloudClusterId, requiredFileValues.cockroachCloudClusterId);
      assert.equal(config.cockroachCloudDatabase, requiredFileValues.cockroachCloudDatabase);
      assert.equal(config.corsAllowedOrigin, requiredFileValues.corsAllowedOrigin);
      assert.equal(
        config.bedrockModelId,
        'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      );
      assert.equal(config.supervisorReservedConcurrency, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it('lets environment variables override file values', () => {
    const fixture = createConfigFile({
      ...requiredFileValues,
      bedrockModelId: 'file.model',
      supervisorReservedConcurrency: 3,
    });
    try {
      const config = loadDeploymentConfig({
        configDirectory: fixture.directory,
        environment: {
          DEPLOYMENT_STAGE: 'development',
          COCKROACH_CLOUD_CLUSTER_ID: '11111111-2222-4333-8444-555555555555',
          COCKROACH_CLOUD_MCP_API_KEY: 'environment-api-key',
          COCKROACH_CLOUD_DATABASE: 'support_override',
          BEDROCK_MODEL_ID: 'environment.model',
          SUPERVISOR_RESERVED_CONCURRENCY: '7',
        },
      });

      assert.equal(
        config.cockroachCloudClusterId,
        '11111111-2222-4333-8444-555555555555',
      );
      assert.equal(config.bedrockModelId, 'environment.model');
      assert.equal(config.cockroachCloudDatabase, 'support_override');
      assert.equal(config.supervisorReservedConcurrency, 7);
      assert.equal(config.corsAllowedOrigin, requiredFileValues.corsAllowedOrigin);
    } finally {
      fixture.cleanup();
    }
  });

  it('supports environment-only configuration', () => {
    const config = loadDeploymentConfig({
      configDirectory: path.join(os.tmpdir(), 'ticket-support-config-does-not-exist'),
      environment: {
        DEPLOYMENT_STAGE: 'production',
        COCKROACH_CLOUD_CLUSTER_ID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        COCKROACH_CLOUD_MCP_API_KEY: 'production-api-key',
        COCKROACH_CLOUD_DATABASE: 'ticket_support',
        CORS_ALLOWED_ORIGIN: 'https://support.example.com',
      },
    });

    assert.equal(config.stage, 'production');
    assert.equal(
      config.cockroachCloudClusterId,
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
  });

  it('rejects missing, misspelled, or unsafe configuration', () => {
    assert.throws(
      () =>
        loadDeploymentConfig({
          configDirectory: path.join(os.tmpdir(), 'ticket-support-config-does-not-exist'),
          environment: {},
        }),
      /COCKROACH_CLOUD_CLUSTER_ID/,
    );

    const fixture = createConfigFile({ ...requiredFileValues, unexpectedSetting: true });
    try {
      assert.throws(
        () =>
          loadDeploymentConfig({
            configDirectory: fixture.directory,
            environment: {
              DEPLOYMENT_STAGE: 'development',
              COCKROACH_CLOUD_MCP_API_KEY: 'test-api-key',
            },
          }),
        /Unknown deployment config fields/,
      );
    } finally {
      fixture.cleanup();
    }

    assert.throws(
      () =>
        loadDeploymentConfig({
          environment: {
            COCKROACH_CLOUD_CLUSTER_ID: 'not-a-cluster-id',
            COCKROACH_CLOUD_MCP_API_KEY: 'test-api-key',
            CORS_ALLOWED_ORIGIN: 'https://frontend.example/path',
          },
        }),
      /COCKROACH_CLOUD_CLUSTER_ID/,
    );
  });
});
