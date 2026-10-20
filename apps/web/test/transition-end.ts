import { act } from "@testing-library/react";

/** Dispatches a `transitionend` for `propertyName` (default: Curtain's grid-template-rows).
 * fireEvent.transitionEnd can't set it: jsdom has no TransitionEvent constructor. */
export function endTransition(element: Element, propertyName = "grid-template-rows") {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  act(() => {
    element.dispatchEvent(event);
  });
}
