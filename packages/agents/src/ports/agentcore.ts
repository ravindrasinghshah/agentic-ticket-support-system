/**
 * The three AgentCore boundaries.
 *
 * `AgentRuntimeClient` — InvokeAgentRuntime, called by the ticket-handler Lambda with
 *   sessionId = conversation_id (ARCHITECTURE.md §5).
 *
 * `MemoryStore` — AgentCore Memory. The supervisor's *active*, session-scoped working state.
 *   Deliberately NOT the durable authority: the §5 guards read `orchestration_state` in
 *   CockroachDB and never this. Keeping that separation is the point of having two stores.
 *
 * `GatewayToolClient` — AgentCore Gateway, which publishes the specialist Lambdas to the
 *   supervisor as MCP tools. Distinct from the CockroachDB MCP connector behind McpAdapter;
 *   the two MCP surfaces are easily conflated and land at different gates.
 */

import type { AgentRunStep } from '@ats/core';

// ── AgentCore Runtime ──────────────────────────────────────────────────────────────────

export interface AgentRuntimeInvocation {
  /** Always the conversation_id, so AgentCore Memory keys line up with our own records. */
  sessionId: string;
  payload: unknown;
}

export interface AgentRuntimeResponse {
  payload: unknown;
}

export interface AgentRuntimeClient {
  readonly runtimeArn: string;
  invoke(invocation: AgentRuntimeInvocation): Promise<AgentRuntimeResponse>;
}

// ── AgentCore Memory ───────────────────────────────────────────────────────────────────

/**
 * The typed shape of the supervisor's session state. Formalized at Gate 2; declared here so
 * the mock exists as a seam from Gate 1.
 */
export interface SupervisorSessionState {
  ticketId: string;
  conversationId: string;
  /** Structured, not prose — tests assert on it. */
  plan: unknown;
  /** Mirrors orchestration_state.context_called_at, but is NOT the authority for it. */
  contextLoaded: boolean;
  specialistOutputs: Record<string, unknown>;
  cycleCount: number;
  handOff?: { escalated: boolean; reply?: string };
}

export interface MemoryStore {
  load(sessionId: string): Promise<SupervisorSessionState | null>;
  save(sessionId: string, state: SupervisorSessionState): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

// ── AgentCore Gateway (MCP tool surface) ───────────────────────────────────────────────

export interface GatewayToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface GatewayToolClient {
  listTools(): Promise<GatewayToolDescriptor[]>;
  callTool(name: string, input: unknown): Promise<unknown>;
}

// ── Trace sink ─────────────────────────────────────────────────────────────────────────

/**
 * The reasoning trace (`agent_runs`, ARCHITECTURE.md §9.1). In-memory at Gates 2–5, backed by
 * a real table at Gate 6 behind this same interface.
 *
 * Two rules the implementations must honour, and that the tests assert:
 *   1. Best-effort and off the critical path — a failed write must never invalidate a ticket
 *      outcome, so `record` resolves rather than throwing.
 *   2. Write-only from the agent's perspective. The §5 guards never read it.
 */
export interface TraceSink {
  record(trace: TraceRecord): Promise<void>;
}

export interface TraceRecord {
  ticketId: string;
  conversationId: string;
  planSummary: string;
  steps: AgentRunStep[];
  cyclesUsed: number;
  outcome: 'resolved' | 'unresolved' | 'escalated';
}

export const AGENT_RUNTIME_CLIENT_METHODS = ['invoke'] as const;
export const MEMORY_STORE_METHODS = ['load', 'save', 'clear'] as const;
export const GATEWAY_TOOL_CLIENT_METHODS = ['listTools', 'callTool'] as const;
export const TRACE_SINK_METHODS = ['record'] as const;
