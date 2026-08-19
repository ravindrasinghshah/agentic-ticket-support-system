import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentOutcome } from '../../src/domain/contracts.js';
import type { AgentRunInput, AgentRunner } from '../../src/application/ports.js';
import { processJob } from '../../src/application/process-job.js';
import { createSupervisorHandler } from '../../src/handlers/supervisor-handler.js';
import { FakeDataPort, JOB_MESSAGE } from '../support/fakes.js';

class FakeRunner implements AgentRunner {
  constructor(private readonly callback: (input: AgentRunInput) => Promise<AgentOutcome>) {}
  run(input: AgentRunInput): Promise<AgentOutcome> {
    return this.callback(input);
  }
}

test('loads context before planning, persists tool results, and completes', async () => {
  const data = new FakeDataPort();
  const runner = new FakeRunner(async ({ tools, resolutionMemory }) => {
    assert.deepEqual(data.calls.slice(0, 4), [
      'claimJob',
      'loadTicketContext',
      'loadConversation',
      'searchResolutions',
    ]);
    assert.deepEqual(resolutionMemory, []);
    await tools.savePlan({ objective: 'Answer tracking question', steps: ['Read tracking'] });
    await tools.getTracking({});
    await tools.savePlan({ objective: 'Answer tracking question', steps: ['Respond with status'] });
    return { outcome: 'completed', response: 'Your order has shipped.' };
  });

  await processJob(JOB_MESSAGE, 1, {
    createDataClient: async () => data,
    agentRunner: runner,
    timeoutMs: 1_000,
  });

  assert.ok(data.calls.indexOf('savePlan') < data.calls.indexOf('beginToolCall:get_tracking'));
  assert.ok(data.calls.includes('recordToolResult:get_tracking'));
  assert.ok(data.calls.includes('appendMessage:assistant'));
  assert.ok(data.calls.includes('completeJob'));
});

test('completes directly from a high-confidence vector FAQ memory', async () => {
  const data = new FakeDataPort();
  data.resolutionSearchResult = {
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
    resolutions: [{
      title: 'Cannot sign in',
      summary: 'Request a new password-reset link and use only the newest link.',
      distance: 0.84,
    }],
  };
  let agentRan = false;

  await processJob(JOB_MESSAGE, 1, {
    createDataClient: async () => data,
    agentRunner: new FakeRunner(async () => {
      agentRan = true;
      return { outcome: 'escalated', response: 'unused' };
    }),
    timeoutMs: 1_000,
  });

  assert.equal(agentRan, false);
  assert.ok(data.calls.includes('searchResolutions'));
  assert.ok(data.calls.includes('appendMessage:assistant'));
  assert.ok(data.calls.includes('completeJob'));
  assert.equal(data.calls.some((call) => call.startsWith('savePlan')), false);
});

test('refuses domain tools until a plan is saved and escalates missing-plan output', async () => {
  const data = new FakeDataPort();
  const runner = new FakeRunner(async ({ tools }) => {
    const result = await tools.getTracking({});
    assert.equal((result as { error: string }).error, 'PLAN_REQUIRED');
    return { outcome: 'completed', response: 'Unsupported answer' };
  });

  await processJob(JOB_MESSAGE, 1, {
    createDataClient: async () => data,
    agentRunner: runner,
    timeoutMs: 1_000,
  });

  assert.equal(data.calls.includes('getTracking'), false);
  assert.ok(data.calls.includes('escalateJob:PLAN_REVIEW_REQUIRED'));
  assert.equal(data.calls.includes('completeJob'), false);
});

test('requires the plan to be revisited after every domain result', async () => {
  const data = new FakeDataPort();
  const runner = new FakeRunner(async ({ tools }) => {
    await tools.savePlan({ objective: 'Investigate', steps: ['Check once'] });
    await tools.getTracking({});
    const second = await tools.getTracking({});
    assert.equal((second as { error: string }).error, 'PLAN_REQUIRED');
    return { outcome: 'completed', response: 'Premature answer' };
  });

  await processJob(JOB_MESSAGE, 1, {
    createDataClient: async () => data,
    agentRunner: runner,
    timeoutMs: 1_000,
  });
  assert.equal(data.calls.filter((call) => call === 'getTracking').length, 1);
  assert.ok(data.calls.includes('escalateJob:PLAN_REVIEW_REQUIRED'));
});

test('the fourth domain call is blocked by durable cycle state and forces escalation', async () => {
  const data = new FakeDataPort();
  data.permitResults.push(
    { allowed: true, cycleCount: 1 },
    { allowed: true, cycleCount: 2 },
    { allowed: true, cycleCount: 3 },
    { allowed: false, cycleCount: 3 },
  );
  const runner = new FakeRunner(async ({ tools }) => {
    await tools.savePlan({ objective: 'Investigate', steps: ['Check tracking'] });
    await tools.getTracking({});
    await tools.savePlan({ objective: 'Investigate', steps: ['Check tracking again'] });
    await tools.getTracking({});
    await tools.savePlan({ objective: 'Investigate', steps: ['Verify tracking'] });
    await tools.getTracking({});
    await tools.savePlan({ objective: 'Investigate', steps: ['One final check'] });
    const fourth = await tools.getTracking({});
    assert.equal((fourth as { error: string }).error, 'CYCLE_LIMIT');
    return { outcome: 'completed', response: 'Should not complete' };
  });

  await processJob(JOB_MESSAGE, 1, {
    createDataClient: async () => data,
    agentRunner: runner,
    timeoutMs: 1_000,
  });

  assert.equal(data.calls.filter((call) => call === 'getTracking').length, 3);
  assert.ok(data.calls.includes('escalateJob:CYCLE_LIMIT'));
  assert.equal(data.calls.includes('completeJob'), false);
});

test('terminal duplicate delivery is skipped without creating an agent', async () => {
  const data = new FakeDataPort();
  data.claimResult = { claimed: false, status: 'completed' };
  let ran = false;

  await processJob(JOB_MESSAGE, 2, {
    createDataClient: async () => data,
    agentRunner: new FakeRunner(async () => {
      ran = true;
      return { outcome: 'completed', response: 'duplicate' };
    }),
    timeoutMs: 1_000,
  });

  assert.equal(ran, false);
  assert.deepEqual(data.calls, ['claimJob', 'disconnect']);
});

test('blank response uses the safe escalation path', async () => {
  const data = new FakeDataPort();
  await processJob(JOB_MESSAGE, 1, {
    createDataClient: async () => data,
    agentRunner: new FakeRunner(async ({ tools }) => {
      await tools.savePlan({ objective: 'Respond', steps: ['Respond'] });
      return { outcome: 'completed', response: '' } as AgentOutcome;
    }),
    timeoutMs: 1_000,
  });
  assert.ok(data.calls.includes('escalateJob:AGENT_ESCALATED'));
});

test('SQS handler reports only failed records for retry', async () => {
  const handler = createSupervisorHandler({
    createDataClient: async () => {
      throw new Error('MCP unavailable');
    },
    agentRunner: new FakeRunner(async () => ({ outcome: 'completed', response: 'unused' })),
    timeoutMs: 1_000,
  });
  const result = await handler({
    Records: [
      {
        messageId: 'retry-me',
        body: JSON.stringify(JOB_MESSAGE),
        attributes: { ApproximateReceiveCount: '2' },
      },
    ],
  } as never);
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'retry-me' }] });
});
