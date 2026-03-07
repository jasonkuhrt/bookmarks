import type { WorkspaceTree } from "./schema/workspace.ts";

export interface ImportedOccurrence {
  readonly id: string;
  readonly targetId: string;
  readonly nativeId: string | null;
  readonly kind: "bookmark" | "folder" | "separator" | "raw";
  readonly title?: string;
  readonly url?: string;
  readonly path: readonly string[];
  readonly nativeKinds: readonly string[];
  readonly payload?: unknown;
}

export interface ImportedTargetSnapshot {
  readonly tree: WorkspaceTree;
  readonly occurrences: readonly ImportedOccurrence[];
}

export interface ImportLockTarget {
  readonly browser: string;
  readonly profile?: string;
  readonly path: string;
  readonly importedAt: string;
  readonly occurrences: readonly ImportedOccurrence[];
}

export interface ImportLock {
  readonly version: 1;
  readonly snapshotId: string;
  readonly importedAt: string;
  readonly targets: Readonly<Record<string, ImportLockTarget>>;
}

export interface WorkspacePlanBlocker {
  readonly code:
    | "review-inbox"
    | "review-quarantine"
    | "duplicate-url"
    | "unsupported-node"
    | "target-unavailable"
    | "permission-denied";
  readonly message: string;
  readonly location?: string;
  readonly targetId?: string;
}

export interface WorkspacePlanTarget {
  readonly targetId: string;
  readonly browser: string;
  readonly profile?: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly writeMode: "rewrite";
  readonly status: "ready" | "blocked" | "disabled";
  readonly blockers: readonly WorkspacePlanBlocker[];
}

export interface WorkspacePlanSummary {
  readonly inboxItems: number;
  readonly canonicalItems: number;
  readonly archiveItems: number;
  readonly quarantineItems: number;
  readonly targetCount: number;
  readonly readyTargetCount: number;
  readonly blockerCount: number;
}

export interface WorkspacePlan {
  readonly version: 1;
  readonly generatedAt: string;
  readonly publishedAt: string | null;
  readonly workspaceHash: string;
  readonly workspacePath: string;
  readonly snapshotId: string;
  readonly summary: WorkspacePlanSummary;
  readonly blockers: readonly WorkspacePlanBlocker[];
  readonly targets: readonly WorkspacePlanTarget[];
}

export type WorkspaceNextAction =
  | {
      readonly kind: "run_command";
      readonly command: string;
      readonly message: string;
    }
  | {
      readonly kind: "edit_file" | "inspect_file";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly kind: "done";
      readonly message: string;
    };

export interface WorkspaceNextResult {
  readonly state:
    | "needs_import"
    | "needs_review"
    | "needs_plan"
    | "has_blockers"
    | "ready_to_publish"
    | "done";
  readonly summary: WorkspacePlanSummary;
  readonly nextAction: WorkspaceNextAction;
  readonly blockers: readonly WorkspacePlanBlocker[];
}
