import { McpClient, type JSONValue as McpJsonValue } from '@strands-agents/sdk';

type McpTool = Awaited<ReturnType<McpClient['listTools']>>[number];
export type QueryRow = Record<string, unknown>;

export const COCKROACH_CLOUD_MCP_ENDPOINT = 'https://cockroachlabs.cloud/mcp';
export const nativeMcpToolAllowlist = Object.freeze(['select_query', 'insert_rows'] as const);

const REQUIRED_NATIVE_TOOLS = new Set<string>(nativeMcpToolAllowlist);

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some MCP servers prefix JSON results with a short human-readable sentence.
    for (const [open, close] of [
      ['[', ']'],
      ['{', '}'],
    ] as const) {
      const start = trimmed.indexOf(open);
      const end = trimmed.lastIndexOf(close);
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        } catch {
          // Try the next supported representation.
        }
      }
    }
    return trimmed;
  }
}

function unwrapMcpResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? parseJsonText(value) : value;
  }
  if ('isError' in value && (value as { isError?: unknown }).isError === true) {
    throw new Error('CockroachDB MCP tool returned an error');
  }
  if ('structuredContent' in value) {
    const structured = (value as { structuredContent?: unknown }).structuredContent;
    if (structured !== undefined) return structured;
  }
  if (!('content' in value)) return value;

  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return value;

  const text = content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        Boolean(item) &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('\n');

  return text ? parseJsonText(text) : value;
}

function rowsFromColumns(columns: unknown[], rows: unknown[]): QueryRow[] {
  const names = columns.map((column) =>
    typeof column === 'string'
      ? column
      : String((column as { name?: unknown })?.name ?? ''),
  );
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length !== names.length || names.some((name) => !name)) {
      return [];
    }
    return [Object.fromEntries(names.map((name, index) => [name, row[index]]))];
  });
}

/** Normalizes the JSON and tabular result shapes used by MCP database servers. */
export function queryRowsFromMcpResult(value: unknown): QueryRow[] {
  const unwrapped = unwrapMcpResult(value);
  if (typeof unwrapped === 'string') {
    const lines = unwrapped
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const tableLines = lines.filter((line) => line.startsWith('|') && line.endsWith('|'));
    if (tableLines.length >= 3) {
      const cells = (line: string) => line.slice(1, -1).split('|').map((cell) => cell.trim());
      const headers = cells(tableLines[0]);
      return tableLines.slice(2).map((line) =>
        Object.fromEntries(headers.map((header, index) => [header, cells(line)[index] ?? null])),
      );
    }
    throw new Error('CockroachDB MCP returned an unsupported query result');
  }
  if (Array.isArray(unwrapped)) {
    return unwrapped.filter(
      (row): row is QueryRow => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
    );
  }
  if (!unwrapped || typeof unwrapped !== 'object') return [];

  const record = unwrapped as Record<string, unknown>;
  for (const key of ['rows', 'data', 'results', 'result']) {
    const candidate = record[key];
    if (!Array.isArray(candidate)) continue;
    if (Array.isArray(record.columns)) {
      const tabular = rowsFromColumns(record.columns, candidate);
      if (tabular.length || candidate.length === 0) return tabular;
    }
    return candidate.filter(
      (row): row is QueryRow => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
    );
  }

  return [record];
}

export function cockroachCloudMcpHeaders(
  clusterId: string,
  apiKey: string,
): Record<string, string> {
  return {
    'mcp-cluster-id': clusterId,
    Authorization: `Bearer ${apiKey}`,
  };
}

export interface ManagedCockroachMcpClient {
  select(query: string): Promise<QueryRow[]>;
  insert(query: string): Promise<void>;
  disconnect(): Promise<void>;
}

export class CockroachCloudMcpClient implements ManagedCockroachMcpClient {
  private tools: Map<string, McpTool> | undefined;

  constructor(
    private readonly client: McpClient,
    private readonly database: string,
    private readonly timeoutMs: number,
  ) {}

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  async select(query: string): Promise<QueryRow[]> {
    return queryRowsFromMcpResult(await this.call('select_query', { database: this.database, query }));
  }

  async insert(query: string): Promise<void> {
    await this.call('insert_rows', { database: this.database, query });
  }

  private async getTools(): Promise<Map<string, McpTool>> {
    if (this.tools) return this.tools;
    const listed = await this.client.listTools();
    const tools = new Map(listed.map((item) => [item.name, item]));
    const missing = [...REQUIRED_NATIVE_TOOLS].filter((name) => !tools.has(name));
    if (missing.length) {
      throw new Error(`CockroachDB Cloud MCP is missing required tools: ${missing.join(', ')}`);
    }
    this.tools = tools;
    return tools;
  }

  private async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (!REQUIRED_NATIVE_TOOLS.has(name)) throw new Error(`MCP tool is not allowlisted: ${name}`);
    const tool = (await this.getTools()).get(name);
    if (!tool) throw new Error(`MCP tool is unavailable: ${name}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const jsonInput = JSON.parse(JSON.stringify(input)) as McpJsonValue;
      const result = await this.client.callTool(tool, jsonInput, { signal: controller.signal });
      // Mutations still need error inspection even though their payload is ignored.
      return unwrapMcpResult(result);
    } finally {
      clearTimeout(timer);
    }
  }
}

