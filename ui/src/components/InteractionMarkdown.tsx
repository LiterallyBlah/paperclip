import { cn } from "../lib/utils";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";

/**
 * Markdown for short agent-authored interaction text: question prompts, help
 * text, option descriptions and confirmation prompts. Agents write their
 * decision context there, often in Markdown.
 *
 * It reuses the shared MarkdownBody renderer, which does not render raw HTML
 * and sanitises link URLs. Images stay inert references, as for question-set
 * context. The compact style takes the container's font size and line height,
 * so plain text looks as it did as plain text, and headings, lists, tables and
 * code stay in proportion inside a card.
 */
export function InteractionMarkdown({
  children,
  externalReferences,
  inheritColor = false,
  className,
}: {
  children: string;
  externalReferences?: MarkdownExternalReferenceMap;
  /** Take the text colour of the container (muted or selected states). */
  inheritColor?: boolean;
  className?: string;
}) {
  return (
    <MarkdownBody
      className={cn("paperclip-markdown-compact", inheritColor && "paperclip-markdown-on-accent", className)}
      externalReferences={externalReferences}
      mediaMode="reference"
    >
      {children}
    </MarkdownBody>
  );
}
