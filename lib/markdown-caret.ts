/**
 * Caret helpers for the markdown editor.
 *
 * Two browser behaviours have to be worked around here, both verified against
 * this app's own stylesheet rather than assumed:
 *
 *   1. `html, body { overscroll-behavior: none }` (app/globals.css, needed for
 *      the app's layout) makes the Home/End keys do nothing inside a
 *      contentEditable — Chromium never issues the caret move. The editor
 *      therefore handles those keys itself instead of relying on the default.
 *   2. A click on a link inside a contentEditable block: the browser starts a
 *      link activation, and the app's own click handler calling
 *      preventDefault() cancels the caret placement too, leaving the caret at
 *      the start of the block. Links inside an editable block place the caret
 *      on mousedown and never navigate.
 */

/** Place the caret at the text position under the pointer. */
export function placeCaretFromPoint(x: number, y: number): boolean {
  const range = document.caretRangeFromPoint?.(x, y);
  const selection = window.getSelection();
  if (!range || !selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Move the caret to the very start or end of an element's contents.
 * Used for the Home/End keys, which this app cannot rely on the browser for.
 */
export function placeCaretInElement(element: HTMLElement, atStart: boolean): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(atStart);
  selection.removeAllRanges();
  selection.addRange(range);
}
