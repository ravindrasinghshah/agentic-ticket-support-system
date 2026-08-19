import { uuidSchema } from '../../domain/contracts.js';

export function sqlUuid(value: string): string {
  return `${sqlString(uuidSchema.parse(value))}::UUID`;
}

export function sqlString(value: string): string {
  if (value.includes('\0')) throw new Error('SQL text values cannot contain null bytes');
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Value cannot be represented as JSON');
  return `${sqlString(encoded)}::JSONB`;
}

export function sqlVector(value: readonly number[], dimensions: number): string {
  if (value.length !== dimensions) {
    throw new Error(`Expected a ${dimensions}-dimensional vector, received ${value.length}`);
  }
  if (value.some((item) => !Number.isFinite(item))) {
    throw new Error('Vector values must be finite numbers');
  }
  // Eight decimal places preserve retrieval ranking while keeping managed-MCP SQL below its
  // 16,384-character query limit for 384-dimensional vectors.
  const encoded = value.map((item) => Number(item.toFixed(8))).join(',');
  return `${sqlString(`[${encoded}]`)}::VECTOR(${dimensions})`;
}

export function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function validateDatabaseName(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(
      'COCKROACH_CLOUD_DATABASE must start with a lowercase letter and contain only a-z, 0-9, or underscore',
    );
  }
  return value;
}

