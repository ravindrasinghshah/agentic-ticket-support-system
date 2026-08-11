import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { McpClient, type JSONValue as McpJsonValue } from '@strands-agents/sdk';
import {
  cockroachCloudMcpHeaders,
  COCKROACH_CLOUD_MCP_ENDPOINT,
  queryRowsFromMcpResult,
  type QueryRow,
} from '../src/infrastructure/mcp/managed-cockroach-mcp-client.js';
import { validateDatabaseName } from '../src/infrastructure/mcp/cockroach-sql.js';

type DatabaseCommand = 'migrate' | 'seed' | 'check' | 'setup';
type McpTool = Awaited<ReturnType<McpClient['listTools']>>[number];

export const DEMO_TICKET_ID = '22222222-2222-4222-8222-222222222222';
export const DEMO_CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const DEMO_ORDER_ID = '44444444-4444-4444-8444-444444444444';
const TOOL_TIMEOUT_MS = 20_000;

const EXPECTED_SCHEMA = Object.freeze({
  schema_migrations: ['version', 'checksum', 'applied_at'],
  orders: ['order_id', 'customer_name', 'item_description', 'order_status', 'ordered_at', 'created_at'],
  tickets: ['ticket_id', 'conversation_id', 'order_id', 'subject', 'description', 'category', 'status', 'created_at', 'updated_at'],
  resolution_articles: ['resolution_id', 'category', 'title', 'summary', 'active', 'created_at', 'updated_at'],
  agent_jobs: ['job_id', 'ticket_id', 'conversation_id', 'status', 'current_plan', 'plan_required', 'cycle_count', 'last_attempt', 'claim_token', 'last_tool_call_token', 'terminal_token', 'response', 'error_code', 'claimed_at', 'completed_at', 'created_at', 'updated_at'],
  conversation_messages: ['message_id', 'ticket_id', 'conversation_id', 'job_id', 'role', 'message', 'created_at'],
  tracking_events: ['tracking_event_id', 'order_id', 'tracking_status', 'carrier', 'location', 'details', 'event_at'],
  agent_context_loads: ['job_id', 'ticket_id', 'conversation_id', 'loaded_at'],
  agent_tool_results: ['id', 'job_id', 'tool_name', 'cycle_number', 'result', 'created_at'],
  ticket_notes: ['id', 'ticket_id', 'job_id', 'cycle_number', 'note', 'visibility', 'created_at'],
} as const);

const WRITE_PERMISSION_PROBES = Object.freeze([
  `INSERT INTO public.agent_jobs (job_id, ticket_id, conversation_id, status)
   SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'queued' WHERE false
   ON CONFLICT (job_id) DO UPDATE SET status = excluded.status`,
  `INSERT INTO public.tickets (ticket_id, conversation_id, subject, description, category, status)
   SELECT gen_random_uuid(), gen_random_uuid(), '', '', '', 'open' WHERE false
   ON CONFLICT (ticket_id) DO UPDATE SET status = excluded.status`,
  `INSERT INTO public.conversation_messages (message_id, ticket_id, conversation_id, role, message)
   SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'assistant', '' WHERE false
   ON CONFLICT (message_id) DO NOTHING`,
  `INSERT INTO public.agent_context_loads (job_id, ticket_id, conversation_id)
   SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid() WHERE false
   ON CONFLICT (job_id) DO UPDATE SET loaded_at = now()`,
  `INSERT INTO public.agent_tool_results (id, job_id, tool_name, cycle_number, result)
   SELECT gen_random_uuid(), gen_random_uuid(), '', 1, '{}'::JSONB WHERE false
   ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO public.ticket_notes (id, ticket_id, job_id, cycle_number, note, visibility)
   SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, '', 'internal' WHERE false
   ON CONFLICT (id) DO NOTHING`,
]);

interface Migration {
  readonly version: string;
  readonly checksum: string;
  readonly statements: readonly string[];
}

function loadConfiguration(): { clusterId: string; apiKey: string; database: string } {
  const filePath = process.env.CDK_ENV_FILE?.trim()
    ? resolve(process.env.CDK_ENV_FILE)
    : resolve(process.cwd(), '../../infrastructure/.env');
  const file = parseEnv(readFileSync(filePath, 'utf8'));
  const value = (name: string): string => {
    const configured = process.env[name]?.trim() || file[name]?.trim();
    if (!configured) throw new Error(`${name} must be configured in the shell or ${filePath}`);
    return configured;
  };
  return {
    clusterId: value('COCKROACH_CLOUD_CLUSTER_ID'),
    apiKey: value('COCKROACH_CLOUD_MCP_API_KEY'),
    database: validateDatabaseName(value('COCKROACH_CLOUD_DATABASE')),
  };
}

function loadMigrations(): Migration[] {
  const directory = resolve(process.cwd(), '../../database/migrations');
  return readdirSync(directory)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort()
    .map((version) => {
      const source = readFileSync(resolve(directory, version), 'utf8');
      const statements = source
        .replace(/^\s*--.*$/gm, '')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        if (!/^CREATE TABLE IF NOT EXISTS\b/i.test(statement)) {
          throw new Error(
            `Migration ${version} contains unsupported DDL: ${statement.slice(0, 40)}`,
          );
        }
      }
      return {
        version,
        checksum: createHash('sha256').update(source).digest('hex'),
        statements,
      };
    });
}

function resultValue(row: QueryRow, camel: string, snake: string): string {
  return String(row[camel] ?? row[snake] ?? '');
}

class LocalDatabaseManager {
  private tools: Map<string, McpTool> | undefined;

  constructor(
    private readonly client: McpClient,
    private readonly database: string,
  ) {}

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  async verifyExistingDatabase(): Promise<void> {
    const rows = await this.select('SELECT current_database() AS "databaseName"');
    if (resultValue(rows[0] ?? {}, 'databaseName', 'database_name') !== this.database) {
      throw new Error(`Configured database ${this.database} is unavailable`);
    }
    console.log(`Verified existing CockroachDB database: ${this.database}`);
  }

  async migrate(): Promise<void> {
    await this.call('create_table', {
      database: this.database,
      ddl: `CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version STRING PRIMARY KEY,
        checksum STRING NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    });

    const appliedRows = await this.select(
      'SELECT version, checksum FROM public.schema_migrations ORDER BY version',
    );
    const applied = new Map(
      appliedRows.map((row) => [String(row.version ?? ''), String(row.checksum ?? '')]),
    );

    for (const migration of loadMigrations()) {
      const existingChecksum = applied.get(migration.version);
      if (existingChecksum && existingChecksum !== migration.checksum) {
        throw new Error(
          `Applied migration ${migration.version} has changed; add a new migration instead`,
        );
      }
      if (existingChecksum) {
        console.log(`Migration already applied: ${migration.version}`);
        continue;
      }

      for (const ddl of migration.statements) {
        await this.call('create_table', { database: this.database, ddl });
      }
      await this.insert(`
        INSERT INTO public.schema_migrations (version, checksum)
        VALUES ('${migration.version}', '${migration.checksum}')
        ON CONFLICT (version) DO NOTHING`);
      console.log(`Applied local migration: ${migration.version}`);
    }
  }

  async seed(): Promise<void> {
    const statements = [
      `INSERT INTO public.orders (
        order_id, customer_name, item_description, order_status, ordered_at
      ) VALUES (
        '${DEMO_ORDER_ID}'::UUID, 'Alex Morgan', 'Wireless noise-cancelling headphones',
        'shipped', now() - INTERVAL '4 days'
      ) ON CONFLICT (order_id) DO NOTHING`,
      `INSERT INTO public.tickets (
        ticket_id, conversation_id, order_id, subject, description, category, status
      ) VALUES (
        '${DEMO_TICKET_ID}'::UUID, '${DEMO_CONVERSATION_ID}'::UUID,
        '${DEMO_ORDER_ID}'::UUID, 'Where is my order?',
        'My headphones have shipped, but I need the latest delivery status.',
        'shipping', 'open'
      ) ON CONFLICT (ticket_id) DO NOTHING`,
      `INSERT INTO public.conversation_messages (
        message_id, ticket_id, conversation_id, role, message, created_at
      ) VALUES (
        '55555555-5555-4555-8555-555555555555'::UUID,
        '${DEMO_TICKET_ID}'::UUID, '${DEMO_CONVERSATION_ID}'::UUID,
        'user', 'Can you tell me where my order is and when it should arrive?',
        now() - INTERVAL '10 minutes'
      ) ON CONFLICT (message_id) DO NOTHING`,
      `INSERT INTO public.tracking_events (
        tracking_event_id, order_id, tracking_status, carrier, location, details, event_at
      ) VALUES (
        '66666666-6666-4666-8666-666666666666'::UUID,
        '${DEMO_ORDER_ID}'::UUID, 'out_for_delivery', 'Demo Parcel',
        'Austin, TX', 'The parcel is on a local delivery vehicle and is expected today.',
        now() - INTERVAL '30 minutes'
      ) ON CONFLICT (tracking_event_id) DO NOTHING`,
      `INSERT INTO public.tracking_events (
        tracking_event_id, order_id, tracking_status, carrier, location, details, event_at
      ) VALUES (
        '77777777-7777-4777-8777-777777777777'::UUID,
        '${DEMO_ORDER_ID}'::UUID, 'arrived_at_facility', 'Demo Parcel',
        'Austin, TX', 'The parcel arrived at the destination facility.',
        now() - INTERVAL '8 hours'
      ) ON CONFLICT (tracking_event_id) DO NOTHING`,
      `INSERT INTO public.resolution_articles (
        resolution_id, category, title, summary
      ) VALUES (
        '88888888-8888-4888-8888-888888888888'::UUID, 'shipping',
        'Responding to in-transit delivery questions',
        'Use the latest tracking event, name the carrier when known, avoid guaranteeing an exact delivery time, and ask the customer to follow up if tracking does not update.'
      ) ON CONFLICT (resolution_id) DO NOTHING`,
    ];
    for (const query of statements) await this.insert(query);
    console.log('Seeded the optional deterministic demo ticket through MCP.');
    console.log(`ticketId=${DEMO_TICKET_ID}`);
    console.log(`conversationId=${DEMO_CONVERSATION_ID}`);
  }

  async check(): Promise<void> {
    const tableNames = Object.keys(EXPECTED_SCHEMA);
    for (const [table, columns] of Object.entries(EXPECTED_SCHEMA)) {
      try {
        // Managed CockroachDB MCP blocks metadata schemas. Selecting zero rows from every expected
        // column validates table/column existence and SELECT permission without reading data.
        await this.select(`SELECT ${columns.join(', ')} FROM public.${table} LIMIT 0`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown MCP error';
        throw new Error(`Database schema/read check failed for public.${table}: ${reason}`);
      }
    }
    for (const query of WRITE_PERMISSION_PROBES) await this.insert(query);

    console.log(
      `Database preflight passed: ${tableNames.length} tables, ${tableNames.length} read checks, ${WRITE_PERMISSION_PROBES.length} write checks.`,
    );
  }

  private async select(query: string): Promise<QueryRow[]> {
    return queryRowsFromMcpResult(
      await this.call('select_query', { database: this.database, query }),
    );
  }

  private async insert(query: string): Promise<void> {
    await this.call('insert_rows', { database: this.database, query });
  }

  private async getTools(): Promise<Map<string, McpTool>> {
    if (!this.tools) {
      this.tools = new Map((await this.client.listTools()).map((tool) => [tool.name, tool]));
    }
    return this.tools;
  }

  private async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    const tool = (await this.getTools()).get(name);
    if (!tool) throw new Error(`CockroachDB Cloud MCP is missing required tool ${name}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
    try {
      const result = await this.client.callTool(
        tool,
        JSON.parse(JSON.stringify(input)) as McpJsonValue,
        { signal: controller.signal },
      );
      if (
        result &&
        typeof result === 'object' &&
        'isError' in result &&
        (result as { isError?: unknown }).isError === true
      ) {
        throw new Error(`CockroachDB MCP tool ${name} returned an error`);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseCommand(value: string | undefined): DatabaseCommand {
  if (value === 'migrate' || value === 'seed' || value === 'check' || value === 'setup') {
    return value;
  }
  throw new Error('Database command must be one of: migrate, seed, check, setup');
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const { clusterId, apiKey, database } = loadConfiguration();
  if (clusterId === '01234567-89ab-4def-8123-456789abcdef') {
    throw new Error('COCKROACH_CLOUD_CLUSTER_ID is still the example UUID');
  }

  const manager = new LocalDatabaseManager(
    new McpClient({
      url: COCKROACH_CLOUD_MCP_ENDPOINT,
      headers: cockroachCloudMcpHeaders(clusterId, apiKey),
    }),
    database,
  );
  try {
    await manager.verifyExistingDatabase();
    if (command === 'migrate' || command === 'setup') await manager.migrate();
    if (command === 'seed') await manager.check();
    if (command === 'seed' || command === 'setup') await manager.seed();
    if (command === 'check' || command === 'setup') await manager.check();
  } finally {
    await manager.disconnect();
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown database command failure';
  if (/unauthorized/i.test(message)) {
    console.error(
      'CockroachDB MCP denied database access. Grant the existing service account Cluster Operator or Cluster Admin access to the configured cluster.',
    );
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});
