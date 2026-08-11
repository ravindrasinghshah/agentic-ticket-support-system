import { z } from 'zod';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const uuidSchema = z.string().uuid();

export const jobMessageSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: uuidSchema,
  ticketId: uuidSchema,
  conversationId: uuidSchema,
});

export type JobMessage = z.infer<typeof jobMessageSchema>;

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'escalated',
  'failed',
]);

export const agentJobSchema = z.object({
  jobId: uuidSchema,
  ticketId: uuidSchema,
  conversationId: uuidSchema,
  status: jobStatusSchema,
  currentPlan: z.unknown().nullable().optional(),
  cycleCount: z.number().int().nonnegative().default(0),
  response: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type AgentJob = z.infer<typeof agentJobSchema>;

export const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  message: z.string(),
  timestamp: z.string().optional(),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const planSchema = z.object({
  objective: z.string().min(1).max(500),
  steps: z.array(z.string().min(1).max(500)).min(1).max(10),
});

export type ResolutionPlan = z.infer<typeof planSchema>;

export const agentOutcomeSchema = z.object({
  outcome: z.enum(['completed', 'escalated']),
  response: z.string().min(1).max(20_000),
});

export type AgentOutcome = z.infer<typeof agentOutcomeSchema>;

export const SAFE_ESCALATION_RESPONSE =
  'We could not safely complete this request automatically. Your ticket has been escalated to a human support agent.';
