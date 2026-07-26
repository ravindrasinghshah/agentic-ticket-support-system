import { describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@ats/core';

function capture() {
  const records: LogRecord[] = [];
  return { records, sink: (record: LogRecord) => records.push(record) };
}

const FIXED_NOW = () => new Date('2026-07-26T12:00:00.000Z');

describe('logger', () => {
  it('emits structured JSON carrying both correlation IDs', () => {
    const { records, sink } = capture();
    const log = createLogger(
      { component: 'lambda.refund', ticketId: 'tkt-1', conversationId: 'conv-1' },
      { sink, now: FIXED_NOW },
    );

    log.info('verdict reached', { reasonCode: 'REFUND_POLICY_ESCALATION', policyVersion: 3 });

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({
      level: 'info',
      message: 'verdict reached',
      component: 'lambda.refund',
      ticket_id: 'tkt-1',
      conversation_id: 'conv-1',
      reasonCode: 'REFUND_POLICY_ESCALATION',
      policyVersion: 3,
    });
    expect(record.timestamp).toBe('2026-07-26T12:00:00.000Z');
    // It has to survive the trip to CloudWatch as one JSON line.
    expect(() => JSON.parse(JSON.stringify(record))).not.toThrow();
  });

  it('omits correlation fields that are genuinely unknown rather than emitting null', () => {
    const { records, sink } = capture();
    createLogger({ component: 'doctor' }, { sink, now: FIXED_NOW }).info('starting');

    expect(records[0]).not.toHaveProperty('ticket_id');
    expect(records[0]).not.toHaveProperty('conversation_id');
  });

  it('filters below the configured level', () => {
    const { records, sink } = capture();
    const log = createLogger({ component: 'supervisor' }, { sink, level: 'warn', now: FIXED_NOW });

    log.debug('noise');
    log.info('noise');
    log.warn('kept');
    log.error('kept');

    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('child() inherits context and adds to it', () => {
    const { records, sink } = capture();
    const base = createLogger({ component: 'supervisor', ticketId: 'tkt-9' }, { sink, now: FIXED_NOW });

    base.child({ tool: 'tracking', conversationId: 'conv-9' }).info('calling specialist');

    expect(records[0]).toMatchObject({
      component: 'supervisor',
      ticket_id: 'tkt-9',
      conversation_id: 'conv-9',
      tool: 'tracking',
    });
  });

  it('serializes Errors instead of flattening them to {}', () => {
    const { records, sink } = capture();
    createLogger({ component: 'lambda.context' }, { sink, now: FIXED_NOW }).error('failed', {
      err: new TypeError('boom'),
    });

    expect(records[0]!.err).toMatchObject({ name: 'TypeError', message: 'boom' });
    expect(JSON.stringify(records[0])).toContain('boom');
  });
});
