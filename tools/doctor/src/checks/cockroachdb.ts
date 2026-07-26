import { ConfigurationError } from '@ats/core';
import { randomBytes } from 'node:crypto';
import { fail, pass, type CheckOutcome } from '../report.ts';
import type { CockroachProbe } from '../context.ts';
import { describeError, type CheckDefinition } from './types.ts';

function configFailure(error: unknown): CheckOutcome | null {
  if (error instanceof ConfigurationError) {
    return fail(`Configuration incomplete: ${error.key}`, error.message);
  }
  return null;
}

/** Postgres wire errors carry a SQLSTATE on `.code`; Node socket errors reuse the field. */
function sqlCode(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === 'string'
    ? String((error as { code: string }).code)
    : '';
}

function connectionRemediation(code: string): string | null {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return (
        'The hostname in COCKROACH_DATABASE_URL does not resolve. Copy the connection ' +
        'string again from CockroachDB Cloud → cluster → Connect → General connection ' +
        'string; the host includes a cluster-specific prefix that is easy to truncate.'
      );
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return (
        'The cluster refused or dropped the connection. Check the port (CockroachDB Cloud ' +
        'uses 26257, not 5432) and that your IP is on the cluster allowlist: CockroachDB ' +
        'Cloud → cluster → Networking → IP allowlist. Serverless clusters also sleep when ' +
        'idle and take a moment on first connect.'
      );
    case 'ENOENT':
      return (
        'The CA certificate at COCKROACH_SSL_ROOT_CERT was not found. Download it from the ' +
        'same Connect dialog (cc-ca.crt), save it outside the repo or under certs/ (which ' +
        'is gitignored), and set COCKROACH_SSL_ROOT_CERT to its absolute path.'
      );
    case '28P01':
      return (
        'Password authentication failed. Regenerate the SQL user password in CockroachDB ' +
        'Cloud → cluster → SQL Users and paste the fresh connection string into ' +
        'COCKROACH_DATABASE_URL. The password is shown only once at creation.'
      );
    case '3D000':
      return (
        'The database named in COCKROACH_DATABASE_URL does not exist. Create it, or correct ' +
        'the database segment of the connection string. See docs/PROVISIONING.md step 5.'
      );
    default:
      return null;
  }
}

export const cockroachConnectivityCheck: CheckDefinition = {
  id: 'cockroachdb-connectivity',
  title: 'CockroachDB is reachable over verified SSL and answers SELECT 1',
  category: 'cockroachdb',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    try {
      ctx.config.cockroachDatabaseUrl();
      ctx.config.cockroachSslRootCert();
    } catch (error) {
      return configFailure(error) ?? fail(describeError(error), 'See docs/CONFIGURATION.md.');
    }

    try {
      const db = await ctx.cockroach();
      const rows = await db.query<{ one: number }>('SELECT 1 AS one');
      if (rows[0]?.one !== 1) {
        return fail(
          `SELECT 1 returned ${JSON.stringify(rows)}.`,
          'The connection succeeded but the cluster did not answer a trivial query as ' +
            'expected. Confirm COCKROACH_DATABASE_URL points at a CockroachDB cluster and ' +
            'not some other Postgres-wire-compatible service.',
        );
      }
      const version = await db
        .query<{ version: string }>('SELECT version() AS version')
        .then((r) => r[0]?.version ?? 'unknown')
        .catch(() => 'unknown');
      return pass(`Connected over verify-full SSL; SELECT 1 succeeded. Cluster: ${version}`);
    } catch (error) {
      const code = sqlCode(error);
      const advice = connectionRemediation(code);
      if (advice) return fail(describeError(error), advice);

      const message = error instanceof Error ? error.message : '';
      if (/self.signed|unable to verify|certificate/i.test(message)) {
        return fail(
          describeError(error),
          'TLS verification failed. COCKROACH_SSL_ROOT_CERT must point at the CA ' +
            'certificate for *this* cluster (cc-ca.crt from the Connect dialog). Do not ' +
            'disable certificate verification to get past this — the Lambdas will make the ' +
            'same verified connection, so a workaround here would hide a real failure later.',
        );
      }
      return fail(
        describeError(error),
        'Could not connect to CockroachDB. Reproduce outside the tool with ' +
          '`cockroach sql --url "$COCKROACH_DATABASE_URL"` to see the raw server error. ' +
          'See docs/PROVISIONING.md step 5.',
      );
    }
  },
};

export const cockroachGenRandomUuidCheck: CheckDefinition = {
  id: 'cockroachdb-gen-random-uuid',
  title: 'gen_random_uuid() is available (every table uses it as a primary-key default)',
  category: 'cockroachdb',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    try {
      const db = await ctx.cockroach();
      const rows = await db.query<{ id: string }>('SELECT gen_random_uuid()::STRING AS id');
      const id = rows[0]?.id ?? '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return fail(
          `gen_random_uuid() returned '${id}', which is not a UUID.`,
          'Every table in ARCHITECTURE.md §10 declares ' +
            '`id UUID PRIMARY KEY DEFAULT gen_random_uuid()`. Confirm you are connected to ' +
            'CockroachDB and not another engine.',
        );
      }
      return pass(`gen_random_uuid() available (sample: ${id}).`);
    } catch (error) {
      return fail(
        describeError(error),
        'gen_random_uuid() is unavailable, which means the schema in ARCHITECTURE.md §10 ' +
          'cannot be created as written. This usually indicates a CockroachDB version older ' +
          'than v22.2. Upgrade the cluster — do not switch the schema to client-generated ' +
          'IDs without raising it first.',
      );
    }
  },
};

export const cockroachVectorSupportCheck: CheckDefinition = {
  id: 'cockroachdb-vector-support',
  title: 'VECTOR column type and CREATE VECTOR INDEX are both supported',
  category: 'cockroachdb',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    // The learning-memory layer at Gate 6 is the hackathon's central claim, and it rests
    // entirely on these two capabilities. Vector indexing is public preview, so this must be
    // known on day one rather than discovered five gates in.
    const suffix = randomBytes(6).toString('hex');
    const table = `_doctor_vector_probe_${suffix}`;
    let db: CockroachProbe;

    try {
      db = await ctx.cockroach();
    } catch (error) {
      return fail(
        describeError(error),
        'Could not connect to CockroachDB — resolve the cockroachdb-connectivity check ' +
          'first; this check depends on it.',
      );
    }

    const drop = async () => {
      await db.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    };

    try {
      try {
        await db.query(`CREATE TABLE ${table} (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), v VECTOR(3))`);
      } catch (error) {
        return fail(
          `The VECTOR column type was rejected: ${describeError(error)}`,
          'CockroachDB vector support is unavailable on this cluster. `resolutions.embedding` ' +
            'at Gate 6 cannot be created without it, and the learning-memory layer is the ' +
            'central claim of this build — so this is a blocker, not a warning. Vector ' +
            'support requires a recent CockroachDB version (public preview); upgrade the ' +
            'cluster or create a new one on a supported version. Confirm with ' +
            '`SELECT version();` and check the CockroachDB release notes for VECTOR ' +
            'availability before starting Gate 6.',
        );
      }

      try {
        await db.query(`CREATE VECTOR INDEX ON ${table} (v)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const settingHint = /cluster setting|not enabled|feature/i.test(message)
          ? ' The error mentions a feature flag: vector indexing may need to be enabled ' +
            'with a cluster setting first — check the message text and the CockroachDB ' +
            'docs for the exact setting name for your version.'
          : '';
        return fail(
          `The VECTOR column type works, but CREATE VECTOR INDEX was rejected: ` +
            `${describeError(error)}`,
          'Vectors could be stored but not indexed, so similarity search at Gate 6 would ' +
            'fall back to a full scan — which §9 forbids.' +
            settingHint +
            ' Resolve this before Gate 6: upgrade to a CockroachDB version with vector ' +
            'indexing (public preview), or raise it as a design decision if the cluster ' +
            'cannot be upgraded.',
        );
      }

      return pass(
        `VECTOR(3) column created and CREATE VECTOR INDEX succeeded on a scratch table ` +
          `(dropped afterwards). The cluster can host resolutions.embedding at Gate 6.`,
      );
    } finally {
      // Gate 1 creates no schema — the cluster must be left exactly as it was found.
      await drop();
    }
  },
};

export const cockroachMcpCheck: CheckDefinition = {
  id: 'cockroachdb-mcp-connector',
  title: 'CockroachDB MCP connector authenticates and lists its tools',
  category: 'cockroachdb',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    try {
      ctx.config.cockroachMcpEndpoint();
      ctx.config.cockroachMcpApiKey();
    } catch (error) {
      return configFailure(error) ?? fail(describeError(error), 'See docs/CONFIGURATION.md.');
    }

    try {
      const tools = await ctx.mcp().listTools();
      if (tools.length === 0) {
        return fail(
          'The MCP connector authenticated but advertised no tools.',
          'McpAdapter has nothing to call. Confirm the MCP server is configured against the ' +
            'right cluster and database. If the connector genuinely exposes no tools, ' +
            'record the finding and keep DB_ACCESS_MODE=sql — SqlAdapter is the default and ' +
            'the build does not depend on MCP (ARCHITECTURE.md §11).',
        );
      }
      return pass(
        `MCP connector authenticated and advertises ${tools.length} tool(s): ` +
          `${tools.slice(0, 8).join(', ')}${tools.length > 8 ? ', …' : ''}. ` +
          'DB_ACCESS_MODE=mcp is viable.',
      );
    } catch (error) {
      return fail(
        describeError(error),
        'The CockroachDB MCP connector could not be reached or authenticated. This is a ' +
          'KNOWN UNKNOWN, not necessarily a blocker: ARCHITECTURE.md §11 puts data access ' +
          'behind TicketDataPort with two implementations precisely so this can be a config ' +
          'flip. Try: confirm COCKROACH_MCP_ENDPOINT is the streamable-HTTP MCP URL (not the ' +
          'SQL connection string), and that COCKROACH_MCP_API_KEY is a current key from ' +
          'CockroachDB Cloud → Access → API keys. If MCP cannot be made to work, set ' +
          'DB_ACCESS_MODE=sql, record the finding in docs/PROGRESS.md, and continue — Gate 3 ' +
          'will skip the McpAdapter integration suite explicitly rather than silently.',
      );
    }
  },
};
