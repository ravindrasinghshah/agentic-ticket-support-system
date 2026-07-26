/**
 * Mock implementations of every external boundary.
 *
 * These are the seams every later gate tests against — plan.md makes them a Gate 1
 * deliverable precisely so that no gate has to invent its own fake and drift from the
 * interface. Each records what it was asked to do, so a test can assert not only on the
 * result but on whether work happened at all (e.g. "a refused specialist did no work").
 *
 * None of these touch the network or read credentials.
 */

import type {
  AgentRuntimeClient,
  AgentRuntimeInvocation,
  AgentRuntimeResponse,
  GatewayToolClient,
  GatewayToolDescriptor,
  MemoryStore,
  SupervisorSessionState,
  TraceRecord,
  TraceSink,
} from '../ports/agentcore.ts';
import type { EmbeddingClient } from '../ports/embedding-client.ts';
import type {
  LoadedPolicyDocument,
  PolicyDocument,
  PolicyDocumentSource,
} from '../ports/policy-document-source.ts';
import type { Precedent, PrecedentQuery, PrecedentSource } from '../ports/precedent-source.ts';
import type { ModelClient, ModelRequest, ModelResponse } from '../ports/model-client.ts';

// ── ModelClient ────────────────────────────────────────────────────────────────────────

export interface MockModelClientOptions {
  modelId?: string;
  /** Responses returned in order; the last one repeats once exhausted. */
  responses?: string[];
  /** Full control, when a test needs to branch on the request. */
  respond?: (request: ModelRequest) => string;
}

export class MockModelClient implements ModelClient {
  readonly modelId: string;
  readonly requests: ModelRequest[] = [];
  private readonly responses: string[];
  private readonly respond: ((request: ModelRequest) => string) | undefined;
  private index = 0;

  constructor(options: MockModelClientOptions = {}) {
    this.modelId = options.modelId ?? 'mock-supervisor-model';
    this.responses = options.responses ?? ['mock model response'];
    this.respond = options.respond;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const text =
      this.respond?.(request) ??
      this.responses[Math.min(this.index, this.responses.length - 1)] ??
      '';
    this.index += 1;
    return {
      text,
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

// ── AgentRuntimeClient ─────────────────────────────────────────────────────────────────

export class MockAgentRuntimeClient implements AgentRuntimeClient {
  readonly runtimeArn: string;
  readonly invocations: AgentRuntimeInvocation[] = [];

  constructor(
    private readonly handler: (invocation: AgentRuntimeInvocation) => unknown = () => ({
      reply: 'mock supervisor reply',
    }),
    runtimeArn = 'arn:aws:bedrock-agentcore:mock:000000000000:runtime/mock',
  ) {
    this.runtimeArn = runtimeArn;
  }

  async invoke(invocation: AgentRuntimeInvocation): Promise<AgentRuntimeResponse> {
    this.invocations.push(invocation);
    return { payload: this.handler(invocation) };
  }
}

// ── MemoryStore (AgentCore Memory) ─────────────────────────────────────────────────────

export class InMemoryMemoryStore implements MemoryStore {
  private readonly states = new Map<string, SupervisorSessionState>();
  readonly calls: Array<{ method: string; sessionId: string }> = [];

  async load(sessionId: string): Promise<SupervisorSessionState | null> {
    this.calls.push({ method: 'load', sessionId });
    const state = this.states.get(sessionId);
    return state ? structuredClone(state) : null;
  }

  async save(sessionId: string, state: SupervisorSessionState): Promise<void> {
    this.calls.push({ method: 'save', sessionId });
    this.states.set(sessionId, structuredClone(state));
  }

  async clear(sessionId: string): Promise<void> {
    this.calls.push({ method: 'clear', sessionId });
    this.states.delete(sessionId);
  }
}

// ── GatewayToolClient ──────────────────────────────────────────────────────────────────

export type MockToolHandler = (input: unknown) => unknown;

export class MockGatewayToolClient implements GatewayToolClient {
  readonly calls: Array<{ name: string; input: unknown }> = [];

  constructor(
    private readonly handlers: Record<string, MockToolHandler> = {},
    private readonly descriptors: GatewayToolDescriptor[] = [],
  ) {}

  async listTools(): Promise<GatewayToolDescriptor[]> {
    if (this.descriptors.length > 0) return this.descriptors;
    return Object.keys(this.handlers).map((name) => ({
      name,
      description: `mock tool ${name}`,
      inputSchema: { type: 'object' },
    }));
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    this.calls.push({ name, input });
    const handler = this.handlers[name];
    if (!handler) throw new Error(`MockGatewayToolClient: no handler registered for '${name}'`);
    return handler(input);
  }
}

// ── EmbeddingClient ────────────────────────────────────────────────────────────────────

/**
 * Deterministic hash-based embeddings. Not semantically meaningful — good enough to prove
 * ranking *logic*, never good enough to prove retrieval *quality*. Gate 6's "a paraphrase
 * retrieves its source top-1" test must run against the real model.
 */
export class MockEmbeddingClient implements EmbeddingClient {
  readonly modelId: string;
  readonly dimension: number;
  readonly embedded: string[] = [];

  constructor(dimension = 8, modelId = 'mock-embedding-model') {
    this.dimension = dimension;
    this.modelId = modelId;
  }

  async embed(text: string): Promise<number[]> {
    this.embedded.push(text);
    return deterministicVector(text, this.dimension);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

function deterministicVector(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    const slot = i % dimension;
    vector[slot] = (vector[slot] ?? 0) + (text.charCodeAt(i) % 17) / 17;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

// ── PolicyDocumentSource ───────────────────────────────────────────────────────────────

export class MockPolicyDocumentSource implements PolicyDocumentSource {
  readonly loads: string[] = [];
  private readonly documents = new Map<string, PolicyDocument>();
  private readonly failures = new Map<string, Error>();

  constructor(documents: Record<string, PolicyDocument> = {}) {
    for (const [key, document] of Object.entries(documents)) this.documents.set(key, document);
  }

  /** Replace a document mid-test — how the "edit policy, verdict changes" tests work. */
  put(key: string, document: PolicyDocument): void {
    this.documents.set(key, document);
    this.failures.delete(key);
  }

  /** Simulate an S3 outage, to prove last-known-good fallback rather than no policy. */
  failNext(key: string, error: Error): void {
    this.failures.set(key, error);
  }

  async load(key: string): Promise<LoadedPolicyDocument> {
    this.loads.push(key);
    const failure = this.failures.get(key);
    if (failure) {
      this.failures.delete(key);
      throw failure;
    }
    const document = this.documents.get(key);
    if (!document) throw new Error(`MockPolicyDocumentSource: no document for key '${key}'`);
    return {
      key,
      document,
      etag: `"mock-etag-v${document.version}"`,
      fetchedAt: new Date(0).toISOString(),
    };
  }
}

// ── PrecedentSource ────────────────────────────────────────────────────────────────────

/**
 * Fixture-backed precedents. This is what Gates 2 and 5 bind; Gate 6 replaces it with real
 * vector retrieval behind the identical interface, with no specialist change.
 */
export class FixturePrecedentSource implements PrecedentSource {
  readonly queries: PrecedentQuery[] = [];

  constructor(private readonly precedents: Precedent[] = []) {}

  async findSimilar(query: PrecedentQuery): Promise<Precedent[]> {
    this.queries.push(query);
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      throw new Error('PrecedentSource.findSimilar requires a positive integer `limit`.');
    }
    return this.precedents
      .filter((p) => (query.outcome ? p.outcome === query.outcome : true))
      .filter((p) => (query.source ? p.source === query.source : true))
      .slice(0, query.limit);
  }
}

// ── TraceSink ──────────────────────────────────────────────────────────────────────────

/**
 * In-memory trace sink (Gate 2's implementation, real `agent_runs` at Gate 6).
 *
 * `failing: true` makes every write reject *internally* and still resolve — proving the
 * best-effort contract: a failed trace write must never invalidate a ticket outcome.
 */
export class InMemoryTraceSink implements TraceSink {
  readonly traces: TraceRecord[] = [];
  readonly failures: Error[] = [];

  constructor(private readonly failing = false) {}

  async record(trace: TraceRecord): Promise<void> {
    if (this.failing) {
      this.failures.push(new Error('MockTraceSink: simulated agent_runs insert failure'));
      return;
    }
    this.traces.push(structuredClone(trace));
  }
}
