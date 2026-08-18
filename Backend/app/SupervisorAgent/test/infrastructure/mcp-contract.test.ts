import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationOperationAllowlist,
  cockroachCloudMcpHeaders,
  COCKROACH_CLOUD_MCP_ENDPOINT,
  nativeMcpToolAllowlist,
} from '../../src/infrastructure/mcp/cockroach-mcp-data-client.js';
import { queryRowsFromMcpResult } from '../../src/infrastructure/mcp/managed-cockroach-mcp-client.js';

test('CockroachDB Cloud MCP connection is cluster-scoped and API-key authenticated', () => {
  const clusterId = '01234567-89ab-4def-8123-456789abcdef';

  assert.equal(COCKROACH_CLOUD_MCP_ENDPOINT, 'https://cockroachlabs.cloud/mcp');
  assert.deepEqual(cockroachCloudMcpHeaders(clusterId, 'test-api-key'), {
    'mcp-cluster-id': clusterId,
    Authorization: 'Bearer test-api-key',
  });
});

test('MCP boundary exposes only named application operations and never arbitrary SQL', () => {
  assert.deepEqual(new Set(applicationOperationAllowlist), new Set([
    'ticket_exists',
    'create_ticket',
    'get_ticket',
    'list_tickets',
    'create_job',
    'get_job',
    'fail_job',
    'claim_job',
    'load_ticket_context',
    'load_conversation',
    'save_plan',
    'begin_tool_call',
    'record_tool_result',
    'get_tracking',
    'search_resolutions',
    'record_ticket_note',
    'append_message',
    'complete_job',
    'escalate_job',
  ]));
  assert.equal(applicationOperationAllowlist.some((name) => /sql|query|execute/i.test(name)), false);
  assert.deepEqual([...nativeMcpToolAllowlist], ['select_query', 'insert_rows']);
});

test('managed MCP tabular results are normalized without exposing the MCP client to the model', () => {
  assert.deepEqual(
    queryRowsFromMcpResult({
      columns: ['ticketId', 'status'],
      rows: [['22222222-2222-4222-8222-222222222222', 'open']],
    }),
    [{ ticketId: '22222222-2222-4222-8222-222222222222', status: 'open' }],
  );
  assert.deepEqual(
    queryRowsFromMcpResult({
      content: [{ type: 'text', text: '[{"status":"queued"}]' }],
    }),
    [{ status: 'queued' }],
  );
});
