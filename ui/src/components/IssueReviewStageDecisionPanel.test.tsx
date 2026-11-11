// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { ToastProvider } from "../context/ToastContext";
import { IssueReviewStageDecisionPanel } from "./IssueReviewStageDecisionPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: { update: vi.fn(() => Promise.resolve({})) },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient();
  flushSync(() =>
    root?.render(
      <ToastProvider>
        <QueryClientProvider client={client}>{element}</QueryClientProvider>
      </ToastProvider>,
    ),
  );
  return container;
}

type PanelIssue = Pick<Issue, "id" | "companyId" | "status" | "assigneeUserId" | "executionState">;

function issueWith(participant: { type: "agent" | "user"; agentId?: string; userId?: string }, overrides: Partial<PanelIssue> = {}): PanelIssue {
  return {
    id: "issue-1",
    companyId: "c1",
    status: "in_review",
    assigneeUserId: participant.type === "user" ? participant.userId ?? null : null,
    executionState: {
      status: "pending",
      currentStageId: "stage-1",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: participant.type, agentId: participant.agentId ?? null, userId: participant.userId ?? null },
      returnAssignee: { type: "agent", agentId: "worker", userId: null },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 3,
    } as unknown as Issue["executionState"],
    ...overrides,
  };
}

describe("IssueReviewStageDecisionPanel (BLA-180)", () => {
  it("puts Approve / Request changes on the task page for the user who holds the stage", () => {
    const el = render(<IssueReviewStageDecisionPanel issue={issueWith({ type: "user", userId: "me" })} currentUserId="me" />);
    const panel = el.querySelector('[data-testid="issue-review-stage-panel"]');
    expect(panel?.getAttribute("aria-label")).toBe("Review decision needed from you");
    const buttons = [...(panel?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(["Request changes", "Approve"]);
    const textarea = panel?.querySelector("textarea");
    expect(panel?.querySelector(`label[for="${textarea?.id}"]`)?.textContent).toContain("decision note");
    // Every control is in the natural tab order (no tabindex=-1, none disabled).
    for (const control of panel?.querySelectorAll("button, textarea") ?? []) {
      expect(control.getAttribute("tabindex")).not.toBe("-1");
      expect((control as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("names who must act when another user holds the stage", () => {
    const el = render(
      <IssueReviewStageDecisionPanel
        issue={issueWith({ type: "user", userId: "dana" })}
        currentUserId="me"
        userLabelMap={new Map([["dana", "Dana"]])}
      />,
    );
    expect(el.querySelector("button")).toBeNull();
    expect(el.textContent).toContain("waiting on Dana");
  });

  it("explains a drifted record (assigned to the viewer, held by an agent) without offering verbs", () => {
    const el = render(
      <IssueReviewStageDecisionPanel
        issue={issueWith({ type: "agent", agentId: "reviewer" }, { assigneeUserId: "me" })}
        currentUserId="me"
        agentMap={new Map([["reviewer", { id: "reviewer", name: "Security Engineer" } as never]])}
      />,
    );
    expect(el.querySelector('[data-testid="review-stage-approve"]')).toBeNull();
    expect(el.textContent).toContain("waiting on Security Engineer");
    expect(el.querySelector('[data-testid="issue-review-stage-drift"]')?.textContent).toContain("reassign");
  });

  it("stays out of the way for agent-held stages and non-pending states", () => {
    expect(render(<IssueReviewStageDecisionPanel issue={issueWith({ type: "agent", agentId: "reviewer" })} currentUserId="me" />).textContent).toBe("");
    expect(render(<IssueReviewStageDecisionPanel issue={issueWith({ type: "user", userId: "me" }, { status: "in_progress" })} currentUserId="me" />).textContent).toBe("");
    expect(render(<IssueReviewStageDecisionPanel issue={issueWith({ type: "user", userId: "me" }, { executionState: null })} currentUserId="me" />).textContent).toBe("");
  });
});
