import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cockroachCloudMcpHeaders,
  COCKROACH_CLOUD_MCP_ENDPOINT,
  mcpToolAllowlist,
} from '../../src/infrastructure/mcp/cockroach-mcp-data-client.js';

test('CockroachDB Cloud MCP connection is cluster-scoped and API-key authenticated', () => {
  const clusterId = '01234567-89ab-4def-8123-456789abcdef';

  assert.equal(COCKROACH_CLOUD_MCP_ENDPOINT, 'https://cockroachlabs.cloud/mcp');
  assert.deepEqual(cockroachCloudMcpHeaders(clusterId, 'test-api-key'), {
    'mcp-cluster-id': clusterId,
    Authorization: 'Bearer test-api-key',
  });
});

test('MCP boundary exposes only named application operations and never arbitrary SQL', () => {
  assert.deepEqual(new Set(mcpToolAllowlist), new Set([
    'ticket_exists',
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
  assert.equal(mcpToolAllowlist.some((name) => /sql|query|execute/i.test(name)), false);
});
