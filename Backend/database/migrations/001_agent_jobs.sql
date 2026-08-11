-- Durable Lambda orchestration state. Apply this with the same migration mechanism
-- used by the CockroachDB MCP server before deploying the Lambda functions.
CREATE TABLE IF NOT EXISTS agent_jobs (
  job_id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  status STRING NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'escalated', 'failed')),
  current_plan JSONB NULL,
  plan_required BOOL NOT NULL DEFAULT true,
  cycle_count INT8 NOT NULL DEFAULT 0 CHECK (cycle_count BETWEEN 0 AND 3),
  last_attempt INT8 NOT NULL DEFAULT 0,
  response STRING NULL,
  error_code STRING NULL,
  claimed_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_jobs_ticket_conversation_idx
  ON agent_jobs (ticket_id, conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_tool_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES agent_jobs (job_id) ON DELETE CASCADE,
  tool_name STRING NOT NULL,
  cycle_number INT8 NOT NULL CHECK (cycle_number BETWEEN 1 AND 3),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, cycle_number)
);

CREATE TABLE IF NOT EXISTS ticket_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL,
  job_id UUID NOT NULL REFERENCES agent_jobs (job_id) ON DELETE CASCADE,
  note STRING NOT NULL,
  visibility STRING NOT NULL CHECK (visibility IN ('internal', 'customer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
