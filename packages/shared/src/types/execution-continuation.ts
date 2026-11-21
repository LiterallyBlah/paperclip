/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
  };
  originCommentIds: string[];
  objective: string;
  objectiveSource?: {
    kind: "comment" | "description" | "title";
    id: string;
    revision: string | null;
  };
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
    /** Set only on recent-window copies whose body was capped for the prompt. */
    bodyTruncated?: boolean;
  }>;
  /**
   * Bounded history for fresh (non-resumed) provider sessions on adapters that
   * opt in. `messages` above stays complete so resume deltas and audits keep
   * their baseline; renderers use this window only when no resume delta applies.
   */
  recentWindow?: {
    messages: ExecutionContinuationEnvelope["messages"];
    /** Task messages not included in the window. */
    omittedCount: number;
    /** Window messages whose body was capped. */
    truncatedCount: number;
    throughCommentId: string | null;
  };
  /** Only direct human resolutions, projected from server-owned resolver columns. */
  humanResponses?: Array<{
    id: string;
    kind: string;
    status: string;
    resolvedByUserId: string;
    resolvedAt: string;
    result: unknown;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  completedWork: string | null;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  /** Verified snapshots attached separately to the new workspace. Paths are
   * relative to the new working directory and include a provenance record. */
  recoveredFiles?: Array<{ operationId: string; sourceRunId: string; path: string }>;
  /** A fresh attempt starts from committed files. The previous attempt's local
   * directory is retained unmodified at this absolute path; changedFiles lists
   * its uncommitted paths (bounded) so the agent can recover that work. */
  priorWorkspace?: {
    sourceRunId: string;
    path: string;
    branchName: string | null;
    changedFilesKnown: boolean;
    changedFileCount: number;
    changedFiles: string[];
  };
  unresolvedInteractionIds: string[];
  coverage: {
    kind: "full_task_history" | "task_history_delta" | "recent_window";
    baseRunId?: string;
    /** Present for `recent_window`: task messages left out of the prompt. */
    omittedCount?: number;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
  };
}
