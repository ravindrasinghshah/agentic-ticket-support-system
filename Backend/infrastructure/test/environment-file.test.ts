import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { loadEnvironmentFile } from '../lib/environment-file';

function createEnvironmentFile(contents: string): {
  filePath: string;
  cleanup(): void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-support-cdk-env-'));
  const filePath = path.join(directory, '.env');
  fs.writeFileSync(filePath, contents, 'utf8');
  return {
    filePath,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

describe('loadEnvironmentFile', () => {
  it('loads supported values without replacing shell variables', () => {
    const fixture = createEnvironmentFile(`
      COCKROACH_CLOUD_CLUSTER_ID=01234567-89ab-4def-8123-456789abcdef
      COCKROACH_CLOUD_MCP_API_KEY=file-api-key
      CORS_ALLOWED_ORIGIN=https://frontend.file.example
    `);
    const environment: NodeJS.ProcessEnv = {
      COCKROACH_CLOUD_CLUSTER_ID: '11111111-2222-4333-8444-555555555555',
    };
    try {
      const loadedPath = loadEnvironmentFile({
        defaultFilePath: fixture.filePath,
        environment,
      });

      assert.equal(loadedPath, fixture.filePath);
      assert.equal(
        environment.COCKROACH_CLOUD_CLUSTER_ID,
        '11111111-2222-4333-8444-555555555555',
      );
      assert.equal(environment.CORS_ALLOWED_ORIGIN, 'https://frontend.file.example');
      assert.equal(environment.COCKROACH_CLOUD_MCP_API_KEY, 'file-api-key');
    } finally {
      fixture.cleanup();
    }
  });

  it('allows the default .env file to be absent', () => {
    const result = loadEnvironmentFile({
      defaultFilePath: path.join(os.tmpdir(), 'ticket-support-env-does-not-exist'),
      environment: {},
    });

    assert.equal(result, undefined);
  });

  it('fails for a missing explicitly selected file or unknown fields', () => {
    assert.throws(
      () =>
        loadEnvironmentFile({
          defaultFilePath: 'unused',
          environment: { CDK_ENV_FILE: path.join(os.tmpdir(), 'missing-ticket-support.env') },
        }),
      /CDK_ENV_FILE does not exist/,
    );

    const fixture = createEnvironmentFile(
      'MISSPELLED_COCKROACH_CLOUD_CLUSTER_ID=01234567-89ab-4def-8123-456789abcdef',
    );
    try {
      assert.throws(
        () => loadEnvironmentFile({ defaultFilePath: fixture.filePath, environment: {} }),
        /Unknown deployment environment fields/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
