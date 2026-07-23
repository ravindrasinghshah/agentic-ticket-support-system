# Agentic Ticket Support System
## Architecture & Technical Instructions for Coding Agents

Version: 1.0

---

# Project Overview

Build an AI-powered **Agentic Ticket Support System** that demonstrates persistent agent memory using:

- CockroachDB Cloud as the long-term memory layer
- CockroachDB Distributed Vector Indexing for semantic retrieval
- CockroachDB Managed MCP Server for agent database interaction
- Amazon Bedrock Agents for reasoning and orchestration
- AWS Lambda for serverless execution

The goal is not to build a simple chatbot.

The goal is to build an autonomous support organization where every interaction becomes reusable organizational memory.

---

# Core Problem

Traditional support systems:

- Answer the same questions repeatedly
- Lose historical knowledge
- Require manual ticket triaging
- Cannot learn from previous resolutions

This system creates AI agents that:

- Understand tickets
- Retrieve historical knowledge
- Reason about solutions
- Execute actions
- Store new memories

---

# High-Level Architecture

```
                         Customer
                            |
                            |
                            v

                   Next.js Web Application

                            |
                            |
                            v

                 API Gateway / Lambda URL

                            |
                            |
                            v

              AWS Bedrock Agent Orchestrator

                            |
        ------------------------------------------------
        |                  |                           |
        v                  v                           v

 Intent Agent       Memory Agent              Resolution Agent

 (Bedrock)          (CockroachDB)             (Bedrock)


        |
        |
        v


              CockroachDB Cloud Serverless

        --------------------------------------

        Operational Memory
        ------------------
        tickets
        users
        conversations
        resolutions


        Vector Memory
        -------------
        embeddings
        semantic search
        historical solutions


        MCP Interface
        -------------
        AI Agent database access


        |
        |
        v


              Memory Writer Agent

              Stores new learnings
```

---

# Hackathon Requirement Mapping

## CockroachDB Components

The project MUST use at least two CockroachDB tools.

We use:

---

## 1. CockroachDB Distributed Vector Indexing

Purpose:

Long-term semantic memory.

Use cases:

- Find similar historical tickets
- Retrieve previous successful resolutions
- Search customer history
- Retrieve troubleshooting steps


Example:

User:

```
"My payment failed after changing my password"
```

Embedding search:

```
Query Embedding

        |
        v

CockroachDB Vector Index

        |
        v

Similar historical tickets

        |
        v

Previous successful resolution
```

---

## 2. CockroachDB Managed MCP Server

Purpose:

Allow AI agents to interact with CockroachDB safely.

Agents can:

- Query ticket history
- Retrieve customer context
- Inspect schemas
- Analyze patterns
- Store memories


Architecture:

```
Bedrock Agent

      |
      |

CockroachDB MCP Server

      |
      |

CockroachDB Cloud
```

No custom database proxy required.

---

# AWS Architecture

Required AWS services:

## Amazon Bedrock

Purpose:

AI reasoning and agent orchestration.

Used for:

- Ticket understanding
- Decision making
- Response generation
- Tool selection


Example:

```
Ticket

  |

Bedrock Agent

  |

Decision:

- Answer?
- Search memory?
- Execute tool?
- Escalate?
```

---

## AWS Lambda

Purpose:

Serverless agent execution.

Functions:

```
lambda/

 ticket-handler

 memory-writer

 tool-executor

 notification-handler

 embedding-worker

```

---

## Amazon S3

Purpose:

Knowledge artifact storage.

Store:

- PDF documents
- Product manuals
- Screenshots
- Support guides
- Runbooks


Flow:

```
S3 Documents

       |

Embedding Pipeline

       |

CockroachDB Vector Memory
```

---

# Frontend Stack

```
Next.js

React

TypeScript

Tailwind CSS

shadcn/ui

TanStack Query
```

Responsibilities:

- Submit tickets
- Display AI responses
- Show agent activity
- Display memory retrieval
- Show resolution history

---

# Agent Architecture

Agents must have clear responsibilities.

Do not build one large prompt.

---

# Agent 1: Orchestrator Agent

Technology:

Amazon Bedrock Agent

Responsibilities:

- Understand workflow
- Call other agents/tools
- Maintain state
- Decide next action


Input:

```
Customer ticket
```

Output:

```
Execution plan
```

---

# Agent 2: Intent Agent

Responsibilities:

- Classify issue
- Extract entities
- Determine category


Example output:

```json
{
 "category": "billing",
 "priority": "high",
 "customerImpact": "payment_failure"
}
```

---

# Agent 3: Memory Retrieval Agent

Responsibilities:

Retrieve from CockroachDB:

- Similar tickets
- Previous conversations
- Customer history
- Successful fixes


Uses:

- Vector similarity search
- MCP database access

---

# Agent 4: Resolution Agent

Responsibilities:

Generate solution.

Input:

- Current ticket
- Memory results
- Knowledge context


Output:

```json
{
 "solution": "...",
 "confidence": 0.92,
 "requiresHuman": false
}
```

---

# Agent 5: Tool Execution Agent

Purpose:

Interact with external systems.

Examples:

- Create Jira issue
- Send Slack notification
- Update CRM
- Trigger workflow


Implementation:

AWS Lambda tools.

---

# Agent 6: Response Agent

Creates customer response.

Supports:

- Chat response
- Email response
- Internal notes

---

# Agent 7: Memory Writer Agent

Critical for hackathon theme.

After every ticket:

Store:

- Conversation summary
- Resolution
- Success/failure
- Customer preferences
- Agent actions


Future agents learn from this data.

---

# Ticket Processing Workflow

```
Ticket Created

      |

      v

Orchestrator Agent

      |

      v

Intent Classification

      |

      v

Retrieve Memory

      |

      v

Vector Search in CockroachDB

      |

      v

Generate Resolution

      |

      v

Need External Action?

       |
       |
   +---+---+

   No      Yes

   |        |

Response   Tool Agent

             |

             v

          External API


      |

      v

Save New Memory

      |

      v

Return Response
```

---

# Database Design

CockroachDB schema.


## users

```
id

name

email

created_at
```

---

## tickets

```
id

user_id

title

description

category

priority

status

created_at
```

---

## conversations

```
id

ticket_id

role

message

created_at
```

---

## memories

Long-term agent memory.

```
id

user_id

memory_type

content

embedding

importance

created_at
```


Examples:

```
Customer prefers email communication

Previous VPN issue solved by resetting token

Billing issue caused by expired payment method
```

---

## resolutions

```
id

ticket_id

solution

confidence

successful

created_at
```

---

# Repository Structure

```
agentic-ticket-support/

apps/

  web/
    Next.js application


services/

  agents/

      orchestrator/

      intent/

      memory/

      resolution/

      response/

      tools/


  lambdas/

      ticket-handler/

      memory-writer/

      tool-executor/


packages/

  database/

  prompts/

  types/


infra/

  aws/

  terraform/
```

---

# Coding Rules

All implementations must follow:

## Language

TypeScript preferred.

---

## Validation

Use:

- Zod schemas
- Strict typing


Avoid:

- any
- untyped responses
- duplicated interfaces


---

# Prompt Management

Never hardcode prompts.

Store:

```
prompts/

 intent.md

 resolution.md

 response.md

 memory.md
```

---

# Observability

Capture:

- Agent execution
- Latency
- Tool calls
- Errors
- Token usage


Use:

- CloudWatch
- Bedrock tracing

---

# Security

Never store:

- API keys
- Secrets
- Credentials


Use:

- AWS Secrets Manager
- IAM roles

---

# MVP Scope

Must demonstrate:

1. User submits support ticket
2. AI agent analyzes request
3. Agent retrieves memory from CockroachDB
4. Vector search finds similar issues
5. AI generates resolution
6. New memory is stored
7. Future tickets benefit from previous knowledge


---

# Future Enhancements

- Voice support agent
- Automatic incident detection
- Self-healing workflows
- Sentiment analysis
- Multi-agent collaboration
- MCP-based enterprise integrations
- Human support dashboard


---

# Success Criteria

The final demo should clearly prove:

"Every solved ticket makes the AI support system smarter."

The differentiator is not answering questions.

The differentiator is **persistent agent memory powered by CockroachDB.**
