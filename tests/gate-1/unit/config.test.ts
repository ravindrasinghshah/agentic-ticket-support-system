import { describe, expect, it } from 'vitest';
import {
  CONFIG_MANIFEST,
  ConfigurationError,
  PLACEHOLDER,
  createConfig,
  type EnvSource,
} from '@ats/core';
import { GOOD_ENV } from '../helpers/fake-context.ts';

describe('config: failing loudly on an unreplaced placeholder', () => {
  it('throws naming the variable and pointing at the manifest', () => {
    const config = createConfig({ ...GOOD_ENV, AWS_REGION: PLACEHOLDER });

    expect(() => config.awsRegion()).toThrowError(ConfigurationError);

    try {
      config.awsRegion();
      expect.unreachable('expected a ConfigurationError');
    } catch (error) {
      const message = (error as Error).message;
      // The three things a placeholder error must carry, so the reader never has to hunt.
      expect(message).toContain('AWS_REGION');
      expect(message).toContain(PLACEHOLDER);
      expect(message).toContain('docs/CONFIGURATION.md');
      // And where to actually get the value.
      expect(message).toContain('Obtain the real value');
      expect((error as ConfigurationError).key).toBe('AWS_REGION');
    }
  });

  it('throws on a missing value with no default, not just on the placeholder', () => {
    const env: EnvSource = { ...GOOD_ENV };
    delete env.COCKROACH_DATABASE_URL;
    const config = createConfig(env);

    expect(() => config.cockroachDatabaseUrl()).toThrowError(/COCKROACH_DATABASE_URL/);
    expect(() => config.cockroachDatabaseUrl()).toThrowError(/not set and has no default/);
  });

  it('treats an empty string as absent — a blank .env line is not a value', () => {
    const config = createConfig({ ...GOOD_ENV, AWS_ACCOUNT_ID: '   ' });
    expect(() => config.awsAccountId()).toThrowError(/AWS_ACCOUNT_ID/);
  });

  it('rejects a placeholder even on an optional variable', () => {
    // "Not yet filled in" is a different state from "deliberately unset", and only one of
    // them is safe to proceed on.
    const config = createConfig({ ...GOOD_ENV, AWS_PROFILE: PLACEHOLDER });
    expect(() => config.awsProfile()).toThrowError(/AWS_PROFILE/);
  });

  it('returns undefined for an optional variable that is simply absent', () => {
    const config = createConfig(GOOD_ENV);
    expect(config.awsProfile()).toBeUndefined();
  });

  it('refuses keys that are not in the manifest', () => {
    const config = createConfig(GOOD_ENV);
    expect(() => config.get('SOME_UNDECLARED_VAR')).toThrowError(
      /not in the configuration manifest/,
    );
  });
});

describe('config: defaults and typed accessors', () => {
  it('applies manifest defaults when the environment is silent', () => {
    const config = createConfig(GOOD_ENV);
    expect(config.dbAccessMode()).toBe('sql');
    expect(config.s3DoctorProbeKey()).toBe('_doctor-probe.json');
    expect(config.policyCacheTtlSeconds()).toBe(300);
    expect(config.logLevel()).toBe('info');
  });

  it('lets the environment override a default', () => {
    const config = createConfig({ ...GOOD_ENV, DB_ACCESS_MODE: 'mcp' });
    expect(config.dbAccessMode()).toBe('mcp');
  });

  it('rejects a DB_ACCESS_MODE outside the two known adapters', () => {
    const config = createConfig({ ...GOOD_ENV, DB_ACCESS_MODE: 'mongo' });
    expect(() => config.dbAccessMode()).toThrowError(/must be 'sql' or 'mcp'/);
  });

  it('rejects a non-integer where an integer is required', () => {
    const config = createConfig({ ...GOOD_ENV, EMBEDDING_DIM: 'one thousand' });
    expect(() => config.embeddingDim()).toThrowError(/must be an integer/);
  });
});

describe('config: the audit that drives pnpm check:config', () => {
  it('never throws, even when everything is outstanding', () => {
    const config = createConfig({});
    expect(() => config.audit()).not.toThrow();
    expect(config.audit().outstanding.length).toBeGreaterThan(0);
  });

  it('reports a placeholder and a missing value with different reasons', () => {
    const env: EnvSource = { ...GOOD_ENV, AWS_REGION: PLACEHOLDER };
    delete env.AWS_ACCOUNT_ID;
    const audit = createConfig(env).audit();

    const byKey = new Map(audit.outstanding.map((item) => [item.key, item]));
    expect(byKey.get('AWS_REGION')?.reason).toBe('placeholder');
    expect(byKey.get('AWS_ACCOUNT_ID')?.reason).toBe('missing');
  });

  it('carries the source for every outstanding value — the point of the audit', () => {
    const audit = createConfig({}).audit();
    for (const item of audit.outstanding) {
      expect(item.source.trim(), `${item.key} has no stated source`).not.toBe('');
      expect(item.description.trim(), `${item.key} has no description`).not.toBe('');
    }
  });

  it('scopes to a gate, so Gate 1 is not blocked by Gate 6 decisions', () => {
    const audit = createConfig(GOOD_ENV).audit(1);
    const keys = audit.outstanding.map((item) => item.key);

    // The embedding model is user-specified at Gate 6 and must not gate this build now.
    expect(keys).not.toContain('EMBEDDING_MODEL_ID');
    expect(keys).not.toContain('EMBEDDING_DIM');
    expect(keys).not.toContain('AGENTCORE_RUNTIME_ARN');
    expect(audit.outstanding).toEqual([]);
  });

  it('does demand the Gate 6 values once the audit reaches Gate 6', () => {
    const keys = createConfig(GOOD_ENV)
      .audit(6)
      .outstanding.map((item) => item.key);
    expect(keys).toContain('EMBEDDING_MODEL_ID');
    expect(keys).toContain('EMBEDDING_DIM');
  });

  it('orders outstanding values by the gate that first needs them', () => {
    const outstanding = createConfig({}).audit().outstanding;
    const gates = outstanding.map((item) => item.gate);
    expect(gates).toEqual([...gates].sort((a, b) => a - b));
  });

  it('counts an optional unset variable as skipped, not outstanding', () => {
    const audit = createConfig(GOOD_ENV).audit();
    expect(audit.skipped).toContain('AWS_PROFILE');
    expect(audit.outstanding.map((item) => item.key)).not.toContain('AWS_PROFILE');
  });
});

describe('config: the manifest itself', () => {
  it('has no duplicate keys', () => {
    const keys = CONFIG_MANIFEST.map((spec) => spec.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every variable a description, a source, and a gate', () => {
    for (const spec of CONFIG_MANIFEST) {
      expect(spec.description.trim(), `${spec.key}: description`).not.toBe('');
      expect(spec.source.trim(), `${spec.key}: source`).not.toBe('');
      expect(spec.gate, `${spec.key}: gate`).toBeGreaterThanOrEqual(1);
    }
  });

  it('never ships REPLACE_ME as a default — a placeholder default would resolve silently', () => {
    for (const spec of CONFIG_MANIFEST) {
      expect(spec.defaultValue, `${spec.key}`).not.toBe(PLACEHOLDER);
    }
  });
});
