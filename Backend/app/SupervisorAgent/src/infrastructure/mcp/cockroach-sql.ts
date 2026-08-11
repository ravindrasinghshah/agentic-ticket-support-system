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

