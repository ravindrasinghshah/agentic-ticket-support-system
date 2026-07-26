/**
 * `PolicyDocumentSource` — read-only access to the S3 policy documents
 * (ARCHITECTURE.md §6.3).
 *
 * Each document pairs human-editable `prose` with a machine-readable `params` block and a
 * `version`, so an edit changes verdicts *and* explanations atomically. The shared loader
 * (TTL + ETag revalidation, zod-validated params, last-known-good fallback) is built at
 * Gate 4 on top of this interface; Gate 1 provides only the boundary and its mock.
 *
 * `params` is deliberately untyped here. Each specialist validates its own params shape with
 * zod at its own gate — the loader stays generic and document-key-parameterized, with no
 * refund- or dispute-specific logic inside it (plan.md, "Running gates in parallel", rule 2).
 */

export interface PolicyDocument {
  version: number;
  updatedAt: string;
  params: Record<string, unknown>;
  prose: string;
}

export interface LoadedPolicyDocument {
  key: string;
  document: PolicyDocument;
  /** S3 ETag, used for revalidation after the TTL expires. */
  etag: string;
  fetchedAt: string;
}

export interface PolicyDocumentSource {
  load(key: string): Promise<LoadedPolicyDocument>;
}

export const POLICY_DOCUMENT_SOURCE_METHODS = ['load'] as const;
