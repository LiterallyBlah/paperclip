// @vitest-environment jsdom

/**
 * Regression tests for decision/question context written in Markdown
 * (BLA-185). Agents put their context in `questions[].prompt`, `helpText`,
 * option `description` and confirmation `payload.prompt`; those fields used to
 * render as plain text, so users saw raw `**`, `|---|` and backticks. All text
 * here is synthetic.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "../api/issues";
import type { Decision } from "../api/decisions";
import {
  answeredAskUserQuestionsInteraction,
  pendingAskUserQuestionsInteraction,
  pendingAskUserQuestionsWithFreeTextOption,
  genericPendingRequestConfirmationInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  pendingRequestConfirmationInteraction,
} from "../fixtures/issueThreadInteractionFixtures";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { AttentionInteractionResolver } from "./AttentionInteractionResolver";
import { DecisionCard } from "./DecisionCard";
import { TaskChatInteractionCard } from "./task-chat/TaskChatInteractionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
  useCaseHref: () => () => "#",
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    listInteractions: vi.fn(),
    acceptInteraction: vi.fn(),
    rejectInteraction: vi.fn(),
    respondToInteraction: vi.fn(),
    cancelInteraction: vi.fn(),
    submitInteractionVerdicts: vi.fn(),
  },
}));

const MARKDOWN_CONTEXT = [
  "## Synthetic context heading",
  "",
  "The **storage choice** affects *two* services. See [the design notes](https://example.com/notes).",
  "",
  "1. First numbered step",
  "2. Second numbered step with `inline-code-token`",
  "",
  "- bullet alpha",
  "- bullet beta",
  "",
  "| Option | Cost | Risk |",
  "|---|---|---|",
  "| Alpha cell | low | medium |",
  "| Beta cell | high | low |",
  "",
  "```ts",
  "const fencedSample = 42;",
  "```",
].join("\n");

const HELP_MARKDOWN = "Pick **one**. Details in `synthetic-help-code`.";
const OPTION_MARKDOWN = "Uses the **shared** pool.\n\n- keeps `cache-key` stable\n- [option reference](https://example.com/option)";
const PLAIN_MULTILINE = "First plain line\nSecond plain line";
const HOSTILE_MARKDOWN = [
  "Before <script>window.__bla185Executed = true</script> after",
  "",
  '<img src="x" onerror="window.__bla185Executed = true">',
  "",
  "[script link](javascript:window.__bla185Executed=true) and [data link](data:text/html;base64,PHNjcmlwdD4=)",
].join("\n");
const LONG_TABLE = [
  `| ${Array.from({ length: 12 }, (_, i) => `Column ${i + 1} with a long synthetic header`).join(" | ")} |`,
  `|${Array.from({ length: 12 }, () => "---").join("|")}|`,
  `| ${Array.from({ length: 12 }, (_, i) => `value-${i + 1}-${"x".repeat(40)}`).join(" | ")} |`,
  "",
  "```",
  `${"long_fenced_code_token_".repeat(20)}`,
  "```",
].join("\n");

const questionInteraction = {
  ...pendingAskUserQuestionsInteraction,
  id: "interaction-markdown-questions",
  payload: {
    version: 1 as const,
    title: "Synthetic storage decision",
    questions: [
      {
        id: "storage",
        prompt: MARKDOWN_CONTEXT,
        helpText: HELP_MARKDOWN,
        selectionMode: "single" as const,
        required: true,
        options: [
          { id: "shared", label: "Shared pool", description: OPTION_MARKDOWN },
          { id: "dedicated", label: "Dedicated pool", description: PLAIN_MULTILINE },
        ],
      },
    ],
  },
};

const roots: Array<{ root: Root; container: HTMLDivElement; client: QueryClient }> = [];

function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  roots.push({ root, container, client });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ThemeProvider>{node}</ThemeProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

afterEach(() => {
  for (const { root, container, client } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
    client.clear();
  }
  vi.clearAllMocks();
  delete (window as { __bla185Executed?: boolean }).__bla185Executed;
});

function promptElement(host: HTMLElement, interactionId: string, questionId: string) {
  const el = host.querySelector<HTMLElement>(`[id="${interactionId}-${questionId}-prompt"]`);
  expect(el).toBeTruthy();
  return el!;
}

function expectRenderedContext(scope: HTMLElement) {
  // Headings, emphasis, lists, links, inline + fenced code and a table are real elements.
  expect(scope.querySelector("h2")?.textContent).toBe("Synthetic context heading");
  expect(scope.querySelector("strong")?.textContent).toBe("storage choice");
  expect(scope.querySelector("em")?.textContent).toBe("two");
  expect(scope.querySelector("ol")?.querySelectorAll("li")).toHaveLength(2);
  expect(scope.querySelector("ul")?.querySelectorAll("li")).toHaveLength(2);
  expect(scope.querySelector<HTMLAnchorElement>('a[href="https://example.com/notes"]')?.textContent).toBe("the design notes");
  expect([...scope.querySelectorAll(":not(pre) > code")].map((el) => el.textContent)).toContain("inline-code-token");
  expect(scope.querySelector("pre code")?.textContent).toContain("const fencedSample = 42;");
  expect(scope.querySelector(".paperclip-markdown-table-scroll table")).toBeTruthy();
  expect([...scope.querySelectorAll("td")].map((td) => td.textContent)).toContain("Alpha cell");
  // No raw Markdown syntax is left in the visible text.
  const text = scope.textContent ?? "";
  expect(text).not.toContain("## ");
  expect(text).not.toContain("**");
  expect(text).not.toContain("|---|");
  expect(text).not.toContain("```");
  expect(text).not.toContain("](https://");
}

describe("Markdown decision context in the thread card", () => {
  it("renders a Markdown question prompt, help text and option descriptions", () => {
    const host = mount(<IssueThreadInteractionCard interaction={questionInteraction} onSubmitInteractionAnswers={vi.fn()} />);
    const prompt = promptElement(host, questionInteraction.id, "storage");
    expectRenderedContext(prompt);
    // The prompt is not one bold block.
    expect(prompt.className).not.toContain("font-semibold");

    const help = [...prompt.parentElement!.children].find(
      (el) => el !== prompt && !el.hasAttribute("hidden") && el.textContent?.includes("synthetic-help-code"),
    ) as HTMLElement;
    expect(help.querySelector("strong")?.textContent).toBe("one");
    expect(help.querySelector("code")?.textContent).toBe("synthetic-help-code");
    expect(help.textContent).not.toContain("**");

    const radio = host.querySelector<HTMLElement>(`[id="${questionInteraction.id}-storage-shared"]`)!;
    expect(radio.getAttribute("role")).toBe("radio");
    expect(radio.textContent).toBe("Shared pool");
    const description = document.getElementById(radio.getAttribute("aria-describedby")!)!;
    expect(description.querySelector("strong")?.textContent).toBe("shared");
    expect(description.querySelector("ul li code")?.textContent).toBe("cache-key");
    expect(description.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe("https://example.com/option");
    // Markdown with links is never nested inside the option button.
    expect(radio.querySelector("a, button")).toBeNull();
  });

  it("keeps option selection, keyboard focus and submit working with Markdown descriptions", async () => {
    const submit = vi.fn(async () => undefined);
    const host = mount(<IssueThreadInteractionCard interaction={questionInteraction} onSubmitInteractionAnswers={submit} />);
    const shared = host.querySelector<HTMLButtonElement>(`[id="${questionInteraction.id}-storage-shared"]`)!;
    const dedicated = host.querySelector<HTMLButtonElement>(`[id="${questionInteraction.id}-storage-dedicated"]`)!;
    expect(shared.tagName).toBe("BUTTON");
    shared.focus();
    expect(document.activeElement).toBe(shared);

    // A click on a link inside the description does not change the selection.
    const link = document.getElementById(shared.getAttribute("aria-describedby")!)!.querySelector("a")!;
    link.addEventListener("click", (event) => event.preventDefault());
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(shared.getAttribute("aria-checked")).toBe("false");

    // A click on the description text selects the option, like the old one-button card.
    const dedicatedDescription = document.getElementById(dedicated.getAttribute("aria-describedby")!)!;
    act(() => dedicatedDescription.querySelector("p")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(dedicated.getAttribute("aria-checked")).toBe("true");

    act(() => shared.click());
    expect(shared.getAttribute("aria-checked")).toBe("true");
    expect(dedicated.getAttribute("aria-checked")).toBe("false");

    const submitButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Submit answers")!;
    await act(async () => submitButton.click());
    expect(submit).toHaveBeenCalledWith(questionInteraction, [{ questionId: "storage", optionIds: ["shared"] }]);
  });

  it("labels text answers with the rendered prompt text, without Markdown noise", () => {
    const interaction = {
      ...pendingAskUserQuestionsWithFreeTextOption,
      payload: {
        ...pendingAskUserQuestionsWithFreeTextOption.payload,
        questions: pendingAskUserQuestionsWithFreeTextOption.payload.questions.map((question) => ({
          ...question,
          prompt: "Name the **new** surface in `kebab-case`",
          allowOther: true,
          options: question.options.filter((option) => !option.freeText),
        })),
      },
    };
    const host = mount(<IssueThreadInteractionCard interaction={interaction} onSubmitInteractionAnswers={vi.fn()} />);
    const other = [...host.querySelectorAll("button")].find((b) => b.textContent === "Other")!;
    act(() => other.click());
    const textarea = host.querySelector("textarea")!;
    expect(textarea.hasAttribute("aria-label")).toBe(false);
    const name = textarea
      .getAttribute("aria-labelledby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .join(" ");
    expect(name).toBe("Other answer for Name the new surface in kebab-case");
  });

  it("renders the answered-question summary prompt as Markdown", () => {
    const interaction = {
      ...answeredAskUserQuestionsInteraction,
      payload: {
        ...answeredAskUserQuestionsInteraction.payload,
        questions: answeredAskUserQuestionsInteraction.payload.questions.map((question, index) =>
          index === 0 ? { ...question, prompt: MARKDOWN_CONTEXT } : question),
      },
    };
    const host = mount(<IssueThreadInteractionCard interaction={interaction} />);
    expectRenderedContext(host);
  });

  it("renders a Markdown confirmation prompt and checkbox option descriptions", () => {
    const confirmation = {
      ...pendingRequestConfirmationInteraction,
      payload: { ...pendingRequestConfirmationInteraction.payload, prompt: MARKDOWN_CONTEXT },
    };
    const host = mount(<IssueThreadInteractionCard interaction={confirmation} onAcceptInteraction={vi.fn()} />);
    expectRenderedContext(host.querySelector<HTMLElement>(".paperclip-markdown-compact")!);

    const checkbox = {
      ...pendingRequestCheckboxConfirmationInteraction,
      payload: {
        ...pendingRequestCheckboxConfirmationInteraction.payload,
        prompt: "Pick the **regions**",
        options: pendingRequestCheckboxConfirmationInteraction.payload.options.map((option, index) =>
          index === 0 ? { ...option, description: OPTION_MARKDOWN } : option),
      },
    };
    const checkboxHost = mount(<IssueThreadInteractionCard interaction={checkbox} onAcceptInteraction={vi.fn()} />);
    expect(checkboxHost.querySelector(".paperclip-markdown-compact strong")?.textContent).toBe("regions");
    const group = checkboxHost.querySelector('[aria-label="Selectable options"]')!;
    expect(group.querySelector("ul li code")?.textContent).toBe("cache-key");
    expect(group.textContent).not.toContain("**");
  });
});

describe("Markdown decision context on the task page (task chat)", () => {
  function taskChatItem(interaction: typeof questionInteraction | typeof genericPendingRequestConfirmationInteraction) {
    return { kind: "interaction", id: interaction.id, interaction } as unknown as Parameters<typeof TaskChatInteractionCard>[0]["item"];
  }

  it("renders a Markdown question prompt, help text and option descriptions in the question form", async () => {
    const submit = vi.fn(async () => undefined);
    const host = mount(
      <TaskChatInteractionCard item={taskChatItem(questionInteraction)} presentation="takeover" onSubmitInteractionAnswers={submit} />,
    );
    const prompt = host.querySelector<HTMLElement>('[id$="-storage-prompt"]')!;
    expect(prompt).toBeTruthy();
    expectRenderedContext(prompt);
    expect(prompt.className).not.toContain("font-medium");
    const help = prompt.parentElement!.querySelector<HTMLElement>(":scope > div:not([id])");
    expect(help?.querySelector("strong")?.textContent).toBe("one");

    const radio = host.querySelector<HTMLButtonElement>('[role="radio"][id$="-storage-shared"]')!;
    expect(radio.querySelector("a, button, .paperclip-markdown")).toBeNull();
    const description = document.getElementById(radio.getAttribute("aria-describedby")!)!;
    expect(description.querySelector("strong")?.textContent).toBe("shared");
    expect(description.querySelector("ul li code")?.textContent).toBe("cache-key");

    // Clicking the plain description selects the option; a link inside it does not.
    const link = description.querySelector("a")!;
    link.addEventListener("click", (event) => event.preventDefault());
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(radio.getAttribute("aria-checked")).toBe("false");
    act(() => description.querySelector("p")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(radio.getAttribute("aria-checked")).toBe("true");
  });

  it("renders a Markdown confirmation prompt in the compact task card", () => {
    const confirmation = {
      ...genericPendingRequestConfirmationInteraction,
      payload: { ...genericPendingRequestConfirmationInteraction.payload, prompt: MARKDOWN_CONTEXT },
    };
    const host = mount(
      <TaskChatInteractionCard item={taskChatItem(confirmation)} presentation="takeover" onAcceptInteraction={vi.fn()} />,
    );
    expectRenderedContext(host.querySelector<HTMLElement>(".paperclip-markdown-compact")!);
  });
});

describe("Markdown decision context in the Decisions resolver", () => {
  it("renders the same Markdown context when a question is answered from the Decisions view", async () => {
    vi.mocked(issuesApi.listInteractions).mockResolvedValue([questionInteraction]);
    vi.mocked(issuesApi.respondToInteraction).mockResolvedValue(questionInteraction as never);
    const host = mount(
      <AttentionInteractionResolver
        companyId={questionInteraction.companyId}
        issueId={questionInteraction.issueId}
        interactionId={questionInteraction.id}
      />,
    );
    await vi.waitFor(() => expect(host.querySelector(`[id="${questionInteraction.id}-storage-prompt"]`)).toBeTruthy());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expectRenderedContext(promptElement(host, questionInteraction.id, "storage"));
    const shared = host.querySelector<HTMLButtonElement>(`[id="${questionInteraction.id}-storage-shared"]`)!;
    act(() => shared.click());
    const submitButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Submit answers")!;
    await act(async () => submitButton.click());
    expect(issuesApi.respondToInteraction).toHaveBeenCalledWith(
      questionInteraction.issueId,
      questionInteraction.id,
      { answers: [{ questionId: "storage", optionIds: ["shared"] }] },
    );
  });

  it("renders Markdown structured-decision option descriptions outside the option button", () => {
    const decision: Decision = {
      id: "decision-md",
      companyId: "c1",
      bundleId: null,
      originAgentId: "agent-synthetic",
      originIssueId: "issue-synthetic",
      originRunId: "run-synthetic",
      ruleKey: "synthetic",
      title: "Synthetic decision",
      body: "Body text.",
      options: [{ id: "go", label: "Go ahead", description: OPTION_MARKDOWN, effects: [] }],
      inputs: null,
      status: "open",
      executionStatus: null,
      chosenOptionId: null,
      inputValues: null,
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: "2026-07-29T12:00:00Z",
      idempotencyKey: null,
      targetSnapshots: {},
      continuationPolicy: "none",
      metadata: {},
      createdAt: "2026-07-22T09:00:00Z",
      updatedAt: "2026-07-22T09:00:00Z",
    };
    const onDecide = vi.fn();
    const host = mount(<DecisionCard decision={decision} onDecide={onDecide} />);
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Go ahead"))!;
    const description = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(description.querySelector("strong")?.textContent).toBe("shared");
    expect(description.querySelector("ul li code")?.textContent).toBe("cache-key");
    expect(button.querySelector("a")).toBeNull();
    // A click on a link in the description does not run the option.
    const link = description.querySelector("a")!;
    link.addEventListener("click", (event) => event.preventDefault());
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(onDecide).not.toHaveBeenCalled();
    act(() => button.click());
    expect(onDecide).toHaveBeenCalledTimes(1);
  });
});

describe("Markdown decision context negative controls", () => {
  it("keeps plain multi-line text readable with its line breaks", () => {
    const interaction = {
      ...questionInteraction,
      payload: {
        ...questionInteraction.payload,
        questions: [{ ...questionInteraction.payload.questions[0]!, prompt: PLAIN_MULTILINE, helpText: undefined }],
      },
    };
    const host = mount(<IssueThreadInteractionCard interaction={interaction} onSubmitInteractionAnswers={vi.fn()} />);
    const prompt = promptElement(host, interaction.id, "storage");
    const paragraphs = prompt.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.querySelector("br")).toBeTruthy();
    expect(prompt.textContent?.replace(/\s+/g, " ").trim()).toBe("First plain line Second plain line");
    expect(prompt.querySelector("h1, h2, h3, strong, ul, ol, table, pre")).toBeNull();
  });

  it("does not render raw HTML as live elements or allow script and data URLs", () => {
    const interaction = {
      ...questionInteraction,
      payload: {
        ...questionInteraction.payload,
        questions: [{
          ...questionInteraction.payload.questions[0]!,
          prompt: HOSTILE_MARKDOWN,
          helpText: HOSTILE_MARKDOWN,
          options: [{ id: "shared", label: "Shared pool", description: HOSTILE_MARKDOWN }],
        }],
      },
    };
    const host = mount(<IssueThreadInteractionCard interaction={interaction} onSubmitInteractionAnswers={vi.fn()} />);
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("[onerror]")).toBeNull();
    expect((window as { __bla185Executed?: boolean }).__bla185Executed).toBeUndefined();
    const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((href) => /^\s*(javascript|data):/i.test(href))).toBe(false);
  });

  it("contains long tables and fenced code in their own scroll containers", () => {
    const interaction = {
      ...questionInteraction,
      payload: {
        ...questionInteraction.payload,
        questions: [{ ...questionInteraction.payload.questions[0]!, prompt: LONG_TABLE }],
      },
    };
    const host = mount(<IssueThreadInteractionCard interaction={interaction} onSubmitInteractionAnswers={vi.fn()} />);
    const prompt = promptElement(host, interaction.id, "storage");
    const markdown = prompt.querySelector(".paperclip-markdown")!;
    expect(markdown.className).toContain("min-w-0");
    expect(markdown.className).toContain("max-w-full");
    expect(markdown.className).toContain("overflow-hidden");
    expect(prompt.querySelector(".paperclip-markdown-table-scroll > table")).toBeTruthy();
    expect(prompt.querySelector(".paperclip-markdown-codeblock pre")).toBeTruthy();
    expect(prompt.className).toContain("min-w-0");
  });
});
