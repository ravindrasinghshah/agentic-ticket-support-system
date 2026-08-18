-- Application schema for the Lambda ticket workflow.
-- This migration is applied only by the local database command. Lambda never executes DDL.
-- The configured CockroachDB database must already exist before this migration is run.

CREATE TABLE IF NOT EXISTS public.orders (
  order_id UUID PRIMARY KEY,
  customer_name STRING NOT NULL,
  item_description STRING NOT NULL,
  order_status STRING NOT NULL,
  ordered_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tickets (
  ticket_id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL,
  order_id UUID NULL REFERENCES public.orders (order_id),
  subject STRING NOT NULL,
  description STRING NOT NULL,
  category STRING NOT NULL,
  status STRING NOT NULL CHECK (
    status IN ('open', 'processing', 'awaiting_customer', 'resolved', 'escalated')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, conversation_id),
  INDEX tickets_conversation_idx (conversation_id)
);

CREATE TABLE IF NOT EXISTS public.resolution_articles (
  resolution_id UUID PRIMARY KEY,
  category STRING NOT NULL,
  title STRING NOT NULL,
  summary STRING NOT NULL,
  active BOOL NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX resolution_articles_category_idx (category, updated_at DESC)
);

CREATE TABLE IF NOT EXISTS public.agent_jobs (
  job_id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  status STRING NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'escalated', 'failed')),
  current_plan JSONB NULL,
  plan_required BOOL NOT NULL DEFAULT true,
  cycle_count INT8 NOT NULL DEFAULT 0 CHECK (cycle_count BETWEEN 0 AND 3),
  last_attempt INT8 NOT NULL DEFAULT 0,
  claim_token UUID NULL,
  last_tool_call_token UUID NULL,
  terminal_token UUID NULL,
  response STRING NULL,
  error_code STRING NULL,
  claimed_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (ticket_id, conversation_id)
    REFERENCES public.tickets (ticket_id, conversation_id),
  INDEX agent_jobs_ticket_conversation_idx (ticket_id, conversation_id, created_at DESC)
);

CREATE TABLE IF NOT EXISTS public.conversation_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  job_id UUID NULL REFERENCES public.agent_jobs (job_id) ON DELETE CASCADE,
  role STRING NOT NULL CHECK (role IN ('user', 'assistant')),
  message STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (ticket_id, conversation_id)
    REFERENCES public.tickets (ticket_id, conversation_id),
  UNIQUE (job_id, role),
  INDEX conversation_messages_history_idx (ticket_id, conversation_id, created_at)
);

CREATE TABLE IF NOT EXISTS public.tracking_events (
  tracking_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders (order_id) ON DELETE CASCADE,
  tracking_status STRING NOT NULL,
  carrier STRING NULL,
  location STRING NULL,
  details STRING NULL,
  event_at TIMESTAMPTZ NOT NULL,
  INDEX tracking_events_order_timeline_idx (order_id, event_at DESC)
);

CREATE TABLE IF NOT EXISTS public.agent_context_loads (
  job_id UUID PRIMARY KEY REFERENCES public.agent_jobs (job_id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_tool_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.agent_jobs (job_id) ON DELETE CASCADE,
  tool_name STRING NOT NULL,
  cycle_number INT8 NOT NULL CHECK (cycle_number BETWEEN 1 AND 3),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, cycle_number)
);

CREATE TABLE IF NOT EXISTS public.ticket_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.tickets (ticket_id),
  job_id UUID NOT NULL REFERENCES public.agent_jobs (job_id) ON DELETE CASCADE,
  cycle_number INT8 NOT NULL CHECK (cycle_number BETWEEN 1 AND 3),
  note STRING NOT NULL,
  visibility STRING NOT NULL CHECK (visibility IN ('internal', 'customer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, cycle_number)
);
