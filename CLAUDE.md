# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Active implementation override

The pre-implementation Bedrock/AgentCore design notes below are historical. The active backend is
implemented under `Backend/` as an asynchronous Lambda/SQS supervisor using Strands with Groq and
CockroachDB Cloud MCP. Use `Backend/README.md` and `Backend/infrastructure/README.md` as the active
architecture and deployment sources of truth.

## Historical project status: pre-implementation

This repository contains **no application code** — only [README.md](README.md), [LICENSE](LICENSE)
(MIT), and the architecture diagram [agentic-ticket-system.png](agentic-ticket-system.png).
There is no `package.json`, no Lambda source, and no infrastructure code yet, so there are no
build, lint, or test commands to document.

**The diagram is the authoritative design spec.** Everything below is transcribed from it. Read
it directly when you need detail this file omits. (`architecture.md` was deleted from the working
tree; an older version survives in git history but describes a *different, superseded* agent
decomposition — do not use it.)

## What this system is

A multi-agent customer support platform for e-commerce-style tickets (tracking, refunds,
disputes), built for the CockroachDB × AWS Hackathon — "Build the Future of Agentic Memory."
Per the README, it targets IT help desks, SaaS customer support, internal employee support, and
product support, and manages **multiple specialized AI agents rather than a single LLM**.

## Tech stack

1. AWS Lambda Function URL
2. Amazon Bedrock Agent
3. S3 storage
4. CockroachDB + its MCP server
5. AWS CloudWatch
6. **TypeScript** — the designated language for this project

## Architecture: supervisor / specialist, non-deterministic

```
Ticket form ──form──> ticket-handler (AWS Lambda URL) ──> Bedrock Agent (Orchestrator/Supervisor)
                            ^                                    │
                            └──────── Human in the loop <─────────┘
                                                                 │
                                    ┌────────────────────────────┴─────────────┐
                                    │  Context agent (FIRST MANDATORY CALL)    │
                                    │  Tracking Specialist                     │
                                    │  Refund Specialist                       │
                                    │  Dispute Specialist                      │
                                    └──────────────────────────────────────────┘
```

The Orchestrator is a **Reasoning-Action agent**: it analyzes the ticket, creates a resolution
plan, and that plan may include calls to specialist agents to gather what it needs.

### Orchestrator loop (the core control flow)

1. **Always call the Context agent first** to obtain context — before creating any plan. This
   is non-negotiable in the design.
2. Create a plan, chasing the objective: *"Do I have everything I need to respond to the ticket
   and achieve resolution?"*
3. After **every** agent response, revisit the plan and evaluate it against the objective.
   Modify the plan if needed; otherwise continue to the next step.
4. **Max 3 plan → call → evaluate cycles** before escalating to a human.
5. Once the objective becomes true, assemble a user-friendly response. The orchestrator (LLM)
   decides which details to include based on user input.
6. If it determines it cannot answer/resolve, it escalates to a human and responds on the ticket
   saying the query could not be resolved and has been escalated.

Conversation history **persists with the orchestrator** and is passed to specialist agents on a
need basis alongside the specialist call. Specialist agents receive instructions from the
orchestrator and use their available tools to complete the work and respond back.

### Agents and their resources

| Agent | Tools | Docs |
|---|---|---|
| **Context agent** (mandatory first call) | Ticket, Conversation History, Resolutions Embedding | — |
| **Tracking Specialist** | Order history, Tracking status | — |
| **Refund Specialist** | — | Refund policy |
| **Dispute Specialist** | — | Dispute Policy |

## Specialist policy rules (business logic — implement these deterministically)

**Refund Specialist:**
- Refund requested **before** order status is shipped **and within 7 days** of order → issue
  automatically, **irrespective of order value**.
- Order **< $300** → refund may be issued if order status is *"Shipped back to sender"* **and
  within 30 days** of order received.
- All other cases → escalate to human.

**Dispute Specialist:**
- Dispute **< $300** → resolve by learning from similar past dispute resolutions and providing
  a response.
- Dispute **≥ $300** → automatically escalate to human.

## Data and storage layers

- **CockroachDB** — read/write, accessed **via the CockroachDB MCP server**. Tools exposed:
  Tickets, Order history, Tracking status, Conversation history, Resolution embeddings. All tool
  access to the database goes through the MCP server rather than a bespoke proxy.
- **S3** — **read only**. Holds policy documents: Refund policy, Dispute resolution policy,
  Generic policy.
- **CloudWatch** — logs and observability.

## Memory / learning loop

- After a response is provided, conversation history is offloaded/written to the Conversation
  history table in CockroachDB, keyed by **Conversation ID and Ticket ID**.
- A ticket is marked **resolved** if the user accepts the final output and closes it; otherwise
  it is marked **unresolved**.
- **Every** resolved *and* unresolved ticket, together with its conversation history, is
  converted into vector embeddings and logged into the Resolution embeddings store — this uses
  **CockroachDB distributed vector indexing**, and is what the Context agent's "Resolutions
  Embedding" tool reads from.

## Database schema

```
Customers
  id (unique), name, email (unique)

OrderHistory
  id, customer_id, status (tracking status), created_at

Tickets
  id (unique), customer_id, title, description, category, priority,
  status       -- 'open' | 'resolved' | 'escalated'
  assigned_to  -- null until a human picks up an escalated ticket
  created_at

ConversationHistory
  id (unique), ticket_id, role, message, timestamp
```

Plus **Resolution embeddings**, backed by CockroachDB distributed vector indexing.

## Known gaps in the spec

The diagram has empty `Tracking:` / `Refund:` / `Dispute:` sections, and does not specify the
embedding model, vector dimensions, how the specialist agents map onto Bedrock action groups or
Lambdas, or the human-agent UI. Ask before inventing these.
