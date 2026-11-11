import type { MouseEvent } from "react";

/**
 * True when a click on an option card should act like a click on its option
 * control. Option cards used to be one big button; their descriptions are now
 * rendered Markdown next to the control, so clicks on links, code-block
 * buttons and other controls inside the description, and text selection, keep
 * their own behaviour.
 */
export function isPlainOptionCardClick(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target as Element | null;
  if (target?.closest?.("a, button, input, textarea, select, summary, [role='button']")) return false;
  const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (selection && !selection.isCollapsed && selection.toString().length > 0) return false;
  return true;
}
