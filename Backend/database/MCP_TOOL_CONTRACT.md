# Application data-operation contract

The Lambda application never gives the model a generic SQL tool. These are the exact typed
operations required by the application and its model-facing boundary. They are not the native tool
names exposed by the managed CockroachDB Cloud MCP service. Inputs and outputs use camelCase JSON
fields.

| Tool | Input | Output / required behavior |
| --- | --- | --- |
| `ticket_exists` | `{ ticketId }` | `{ exists: boolean }` |
| `create_ticket` | `{ ticketId, conversationId, subject, description, category }` | Create an `open` ticket and its initial user conversation message |
| `get_ticket` | `{ ticketId }` | Ticket with its most recent agent job, or `null` |
| `list_tickets` | `{ limit }` | Newest tickets with their most recent agent jobs; hard limit of 100 |
| `create_job` | versioned job message | Created job; insert as `queued` |
| `get_job` | `{ jobId }` | Job or `null`; never return internal exception text |
| `fail_job` | `{ jobId, errorCode }` | Conditionally change `queued` to `failed` |
| `claim_job` | `{ jobId, attempt }` | `{ claimed, status, currentPlan, planRequired, cycleCount, toolResults }`; claim `queued`, or reclaim `running` only when `attempt > last_attempt`; terminal jobs return `claimed: false` |
| `load_ticket_context` | `{ jobId, ticketId, conversationId }` | Authoritative ticket/customer/order context; stamp context load durably |
| `load_conversation` | `{ ticketId, conversationId }` | `{ messages: [{ role, message, timestamp }] }` |
| `save_plan` | `{ jobId, plan }` | Update only a running job's `current_plan` and set `plan_required = false` |
| `begin_tool_call` | `{ jobId, toolName }` | Only run when `plan_required = false`; atomically increment `cycle_count` below 3 and set `plan_required = true`; return `{ allowed, cycleCount, reason? }` |
| `record_tool_result` | `{ jobId, toolName, result }` | Insert the result for the current cycle; redact secrets server-side |
| `get_tracking` | `{ jobId, orderId? }` | Read tracking data authorized for the job's ticket/customer |
| `search_resolutions` | `{ jobId, query, category?, limit }` | Return at most five authorized resolution matches |
| `record_ticket_note` | `{ jobId, ticketId, note, visibility }` | Append-only constrained write; confirm the ticket matches the job |
| `append_message` | `{ jobId, ticketId, conversationId, role, message }` | Idempotently append the conversation message, authorized through the stored job |
| `complete_job` | `{ jobId, response }` | In one transaction, conditionally change `running` to `completed`, store response, and transition the ticket to `awaiting_customer`; return `{ applied }` |
| `escalate_job` | `{ jobId, response, errorCode }` | In one transaction, conditionally change any nonterminal job to `escalated`, store the safe response, and transition the ticket; return `{ applied }` |

Every mutating tool must authorize identifiers from the stored job rather than trusting identifiers
supplied by the model. Terminal transitions are conditional, making SQS redelivery harmless.

The adapter uses only CockroachDB Cloud MCP's `select_query` and `insert_rows` tools. Updates are
expressed as conditional `INSERT ... ON CONFLICT DO UPDATE` statements. Terminal transitions use a
data-modifying CTE and an outer insert so the job and ticket change in the same CockroachDB
statement. Both native tools stay behind this application boundary and are never handed directly
to Strands.
