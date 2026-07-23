# Architecture & Technical Instructions for Coding Agents

Version: 1.0

---

# Architecture Decision Summary

The system follows a **Supervisor Agent architecture**.

The AI workflow is controlled by a single **Amazon Bedrock Agent acting as the Orchestrator**.

The Orchestrator invokes its own **Action Groups**, each backed by one Lambda function. That Lambda internally dispatches to the relevant service module:

- Intent Agent
- Memory Agent
- Resolution Agent
- Tool Agent
- Response Agent

These are logical agents implemented as reusable service modules inside one or two Lambdas — not separate Bedrock Agent resources and not Bedrock's multi-agent-collaboration feature. One orchestrator Agent with action groups is enough to get the LLM deciding what to call and when, without the extra setup of registering multiple collaborator agents.

When the Resolution Agent can't produce a confident answer, the system escalates to a human rather than forcing a response. This is handled as one more action the Tool Agent can take — no separate escalation service is introduced.

AWS Lambda is used as the execution boundary and event trigger layer.

CockroachDB is the persistent memory layer.

---

# Web Application Scope

One Next.js app, two routes. No email intake pipeline, no RBAC.

## `/submit` — public, no auth

The customer-facing ticket form. A simple form (name/email, title, description) that POSTs to the Ticket Handler Lambda via its Function URL and shows the resulting response once the agent chain completes.

## `/tickets` — gated, not role-based

A single view that lists every ticket with its status (`open` / `escalated` / `resolved`), filterable by status — so "the queue" is just this view filtered to `status = 'escalated'`, not a separate page. Clicking a ticket opens `/tickets/[id]`, showing:

- Full details: category, priority, description, conversation history
- The agent's resolution (or the human's, once submitted) and which memories informed it
- A reply form, shown only when `status = 'escalated'` — that's the human agent's action to resolve the ticket

Gated by a single shared password or a Cognito Hosted UI with one test user — enough that it isn't wide open on the internet, but not real role/permission modeling. Everyone who can get past the gate can see and act on every ticket; that's fine for a hackathon, and it means you don't need a second page for the escalation queue.

Both routes talk to the same backend (Ticket Handler Lambda for submission, a direct pooled-connection query for listing/detail/reply). No separate admin service, no additional infrastructure beyond what's already in this document.

---

# Core Architecture

```
                Customer                    Human agent

                    |                             |
                    v                             v

            /submit (public)          /tickets (gated, list+detail)

                    |                             |
                    ------------------------------
                                 |
                                 v

                    Next.js Application

                            |
                            v

                Lambda Function URL

                            |
                            v

                  Ticket Handler Lambda

                            |
                            v

              Amazon Bedrock Agent
              (Supervisor / Orchestrator)

                            |
        ------------------------------------------------

        |                 |                 |

        v                 v                 v


 Intent Agent       Memory Agent       Tool Agent

 (module)           (module)           (module)


        |                 |
        |                 |
        |                 v

        |         Pooled SQL connection
        |         (module-scope, reused across warm invocations)

        |                 |

        |                 v

        |        CockroachDB Cloud

        |        -------------------

        |        Ticket Memory

        |        Conversation Memory

        |        Resolution Memory

        |        Vector Embeddings (Titan Embed V2, preview vector index)


        |
        v


 Resolution Agent


        |
        v

   requiresHuman?  ------ yes ------>  Tool Agent: escalate_to_human
        |                                      |
        no                                     v
        |                              tickets.status = 'escalated'
        v                              + Slack notification
                                               |
                                               v
                                      Human queue (Next.js app,
                                      filters status = 'escalated')
                                               |
                                               v
                                      Human submits reply
                                               |
                                               v
                                      tickets.status = 'resolved'
                                      resolutions.source = 'human'
                                               |
                                               +---------------+
                                                               |
 Response Agent  <---------------------------------------------
        |                                                       (both paths
        v                                                        converge here)

 Customer Response


        |
        v


 Memory Writer Lambda   <-- stores both agent-resolved and
                            human-resolved outcomes


        |
        v


 CockroachDB Persistent Memory


   (separately, off the request path:)

   CockroachDB Managed MCP Server  -- used live in the demo to
   introspect agent memory / show retrieval working; not called
   during ticket handling
```

---

# Agent Communication Model

The Orchestrator does not directly solve every problem. It delegates tasks via action-group calls, and each Lambda-backed action group returns a structured response.

```
Bedrock Orchestrator

        |
        |
        +---- Intent Agent

                returns:

                {
                  category:"billing",
                  confidence:0.95
                }


        |
        |
        +---- Memory Agent

                returns:

                {
                  similarTickets:[],
                  previousSolutions:[]
                }


        |
        |
        +---- Resolution Agent

                returns:

                {
                  solution:"",
                  confidence:0.91,
                  requiresHuman:false
                }


        |
        |
        +---- Tool Agent  (only called when requiresHuman is true)

                input:

                {
                  action:"escalate_to_human",
                  ticketId:"...",
                  reason:"low confidence / unresolved category"
                }

                returns:

                {
                  status:"escalated",
                  notified:true
                }


        |
        |
        +---- Response Agent

                returns:

                {
                  customerReply:""
                }
```

`confidence` values are self-reported by the LLM and are surfaced in the UI/logs as a signal, but nothing in the system branches on them. `requiresHuman` is set by one simple deterministic rule you control directly (e.g. resolution string empty, or category not in a known list) — never by the confidence value.

---

# AWS Components

## Amazon Bedrock Agent

Primary AI orchestrator. One Agent resource, multiple action groups.

Responsibilities:

- Understand ticket context
- Decide next action
- Invoke action groups (Intent / Memory / Resolution / Tool / Response)
- Maintain workflow state
- Select tools
- Generate final response

---

## AWS Lambda

```
lambdas/

 ticket-handler/

 memory-writer/

 tool-executor/
```

Action groups point at `ticket-handler` and `tool-executor`; there is no Lambda per logical agent.

---

## Ticket Handler Lambda

Fronted by a **Lambda Function URL** (not API Gateway), so the multi-hop agent chain isn't at risk of hitting a 29-second integration timeout.

Responsibilities:

- Receive HTTP request
- Validate input
- Start Bedrock Agent workflow (`InvokeAgent`)
- Return response

Should NOT contain business logic.

---

## Memory Writer Lambda

Responsibilities, after ticket resolution:

Store:

- Conversation summary
- Successful resolution
- Customer preferences
- Agent actions
- Lessons learned

Flow:

```
Resolution Completed

        |

Memory Writer Lambda

        |

CockroachDB (pooled connection, module-scope)
```

---

## Tool Executor Lambda

Used for external actions.

A `DEMO_MODE` environment variable controls behavior:

- `DEMO_MODE=true` (default): every tool call is logged with its intended action and payload instead of executed, **except** posting to a designated test Slack channel, which is safe to actually run live.
- `DEMO_MODE=false`: executes for real (Jira, CRM, arbitrary Slack channels) — only enable after each integration has been tested independently.

`escalate_to_human` is always executed for real, regardless of `DEMO_MODE` — it's core to the product story, not a side-effecting integration, and both of its effects (a status update in your own database and a Slack post to your own test channel) are safe to run live.

Examples:

- Create Jira issue
- Send Slack message
- Update CRM
- Trigger workflows
- Escalate ticket to a human (see Human-in-the-Loop Escalation below)

---

# Agent Services

```
services/

 agents/

   intent-agent/

   memory-agent/

   resolution-agent/

   response-agent/

   tool-agent/


 integrations/

   bedrock/

   cockroach/

   jira/

```

---

# Agent Responsibilities

## Intent Agent

Input: customer message.

Output:

```json
{
 "intent":"payment_failure",
 "category":"billing",
 "priority":"high"
}
```

---

## Memory Agent

Purpose: long-term organizational memory.

Uses:

- Pooled SQL connection to CockroachDB Cloud (module-scope, reused across warm Lambda invocations)
- CockroachDB vector index (public preview) for similarity search

Retrieves:

- Similar tickets
- Previous fixes
- Customer history
- Known issues

Every retrieval query filters `WHERE type = $1` before the vector similarity ordering, since `memories` holds several conceptually different content types sharing one embedding column. Queries also order by `importance DESC` and apply a `LIMIT`, so noisy or duplicate rows don't dominate results.

```
New Ticket

"My payment stopped working"

        |

Embedding Generation (Bedrock Titan Text Embeddings V2)

        |

CockroachDB Vector Search (filtered by type, capped, ranked by importance)

        |

Previous Successful Fix
```

---

## Resolution Agent

Purpose: generate solution.

Uses:

- Ticket context
- Intent
- Historical memory
- Knowledge documents

Output:

```json
{
 "resolution":"Reset payment token",
 "confidence":0.92,
 "requiresHuman":false
}
```

`requiresHuman` is set by a simple deterministic rule (e.g. resolution string empty, or category unrecognized) — not by the confidence value.

---

## Response Agent

Purpose: generate user-facing response.

Supports:

- Chat response
- Email response
- Internal notes

---

## Tool Agent

Purpose: execute external actions, gated by `DEMO_MODE` as described above.

Examples:

```
Create Jira ticket

Send Slack notification

Update CRM

Trigger API workflow
```

---

# Human-in-the-Loop Escalation

The system does not force a resolution when it doesn't have one. When the Resolution Agent sets `requiresHuman: true`, the Orchestrator calls the Tool Agent's `escalate_to_human` action instead of proceeding straight to the Response Agent.

`escalate_to_human` does two things, both against systems you already own:

1. Updates the ticket's row: `status = 'escalated'`, `assigned_to = null` (open for pickup).
2. Posts a Slack notification to the support channel with the ticket ID and category.

No new service or queue is introduced — the existing Next.js app's `/tickets` view already lists tickets by status; filtering to `status = 'escalated'` and opening `/tickets/[id]` is how a human picks one up and replies. There's no separate queue page — it's the same ticket list/detail view every ticket lives in.

When a human submits a reply for an escalated ticket:

- `tickets.status` is set to `'resolved'`
- A row is written to `resolutions` with `source = 'human'`
- The Memory Writer Lambda stores it exactly like an agent resolution, so the next similar ticket benefits from what the human did — this is what closes the "continuously learning" loop for the cases the agent couldn't handle on its own.

Either path — agent-resolved or human-resolved — converges back through the Response Agent so the customer always gets a reply through the same channel.

---

# CockroachDB Usage

CockroachDB is the system memory.

## 1. Vector Search (public preview)

CockroachDB's distributed vector index (`CREATE VECTOR INDEX`) is used for:

- Semantic ticket search
- Historical resolution retrieval
- Agent memory

It's labeled **public preview** by CockroachDB — solid to build on, but don't present it as a battle-tested GA capability.

Embeddings are generated with **Bedrock Titan Text Embeddings V2** for every row written to `memories`, so all vectors share one model and one dimension. Don't mix embedding models across memory types.

## 2. Runtime data access

Application-path reads/writes (Memory Agent, Memory Writer Lambda) use a normal SQL client with a connection cached at module scope, reused across warm invocations. This keeps per-invocation overhead low and keeps the request path simple.

## 3. CockroachDB Managed MCP Server

The managed MCP server gives secure, agent-native access to CockroachDB Cloud (schema exploration, ad hoc querying, audit logging) and is used as a **demo-time introspection tool**: live during the presentation, query the `memories` table in natural language to show what got learned. It is not called during ticket handling.

Architecture:

```
Presenter / demo agent

       |

CockroachDB Managed MCP Server

       |

CockroachDB Cloud
```

Benefits:

- Secure access
- Audit logging
- No custom database proxy
- Agent-native database interaction

---

# Database Model

## tickets

```
id
customer_id
title
description
category
priority
status        -- includes 'open' | 'resolved' | 'escalated'
assigned_to   -- null until a human picks up an escalated ticket
created_at
```

---

## conversations

```
id
ticket_id
role
message
timestamp
```

---

## memories

Long-term agent memory.

```
id
type          -- 'ticket' | 'conversation' | 'resolution' | 'preference' | 'known_issue'
content
embedding     -- Titan Embed V2, fixed dimension across all rows
importance
created_at
```

Examples:

```
Customer prefers email

Payment issue solved by token refresh

Known outage affecting checkout
```

Query pattern: always filter by `type`, order by `importance DESC`, and `LIMIT` — this keeps cross-category noise out of results and keeps result sets bounded.

---

## resolutions

```
id
ticket_id
solution
confidence
success
source        -- 'agent' | 'human'
created_at
```

---

# Complete Execution Flow

```
1. User creates ticket

2. Ticket Handler Lambda receives request (via Lambda Function URL)

3. Bedrock Agent becomes supervisor

4. Orchestrator calls Intent Agent action group

5. Orchestrator calls Memory Agent action group

6. Memory Agent queries CockroachDB via pooled connection

7. Vector search (filtered by type, capped) retrieves relevant memories

8. Resolution Agent generates solution; requiresHuman set by deterministic rule

8a. If requiresHuman is true: Tool Agent calls escalate_to_human — ticket status set to 'escalated', Slack notification sent, ticket appears in `/tickets` filtered by status in the Next.js app

8b. Human picks up the ticket and submits a reply — ticket status set to 'resolved', resolution stored with source = 'human'

9. Tool Agent executes any other external actions if needed (respecting DEMO_MODE)

10. Response Agent creates final response (from either the agent's resolution or the human's reply)

11. Memory Writer Lambda stores new learning (agent- or human-sourced)

12. Future tickets benefit from previous experience, including cases a human previously resolved
```

---

# Repository Structure

```
agentic-ticket-support/


apps/

 web/          -- Next.js app: /submit (public) + /tickets (gated, list+detail)


lambdas/

 ticket-handler/

 memory-writer/

 tool-executor/


services/

 agents/

   intent-agent/

   memory-agent/

   resolution-agent/

   response-agent/

   tool-agent/


 integrations/

   cockroach/

   bedrock/


prompts/

 database/

infra/

 terraform/

```

---

# MVP Success Criteria

The demo must prove:

1. Ticket submitted
2. Bedrock Agent delegates work across action groups
3. Memory Agent retrieves previous knowledge
4. CockroachDB vector search influences response
5. Agent resolves issue
6. New memory is stored
7. Future ticket improves because of past experience
8. The full chain completes without hitting a request timeout
9. No tool action fires unexpectedly against a real external system during the demo
10. A ticket the agent can't resolve is escalated to a human queue, gets a human reply, and that reply is captured back into memory

---

# Key Differentiator

This is not a chatbot.

It is a continuously learning support organization.

Every resolved ticket becomes memory.

Every memory improves future agent decisions.

CockroachDB is the foundation of the agent's long-term intelligence — used both as the runtime memory store and, live in the demo, as an agent-queryable surface via its managed MCP server.
