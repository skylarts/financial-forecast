"use client";

import { useEffect, useRef } from "react";

/**
 * What every overlay that takes over the page owes the keyboard.
 *
 * The portfolio grew several of these -- the position drawer, the import
 * dialog, the account settings drawer, the snapshot picker -- and each did a
 * different subset of the job: some closed on Escape, none trapped focus, none
 * put focus back where it came from. Tab from an open drawer walked the page
 * behind it, and Escape did nothing on the two overlays used most. One hook
 * now does all of it, so an overlay is a real dialog by construction rather
 * than by whoever last remembered.
 *
 * Attach the returned ref to the dialog's own box (not the backdrop). While it
 * is mounted:
 *
 * - Escape calls `onClose`. Only the topmost dialog answers: the listener is
 *   registered on mount, and a dialog opened later is registered later, so
 *   its handler runs first and stops the event.
 * - Tab and Shift+Tab cycle within the box rather than leaving it.
 * - Focus moves into the box on open -- to the first focusable element, or to
 *   the box itself if there is none -- and returns on close to whatever had it
 *   before, which is almost always the row or button that opened the dialog.
 *
 * `onClose` is read through a ref so the caller can pass a fresh closure each
 * render without re-registering listeners.
 */
export function useModalDialog<T extends HTMLElement>(onClose: () => void) {
  const box = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Something inside must be able to take focus even when the dialog has no
    // controls yet (a list still loading, say), or Tab has nowhere to land
    // and escapes to the page behind.
    if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
    const first = focusable(element)[0];
    (first ?? element).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(element);
      if (items.length === 0) {
        event.preventDefault();
        element.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      // Focus that has somehow left the box (a click on the backdrop, say)
      // is pulled back in on the next Tab rather than allowed to wander.
      const outside = !(active instanceof Node) || !element.contains(active);
      if (event.shiftKey) {
        if (outside || active === firstItem) {
          event.preventDefault();
          lastItem.focus();
        }
      } else if (outside || active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Restore only if the opener is still on the page; a row that was
      // deleted from inside the dialog has nowhere to return to.
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return box;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Everything inside `root` a Tab press can land on, in document order. */
function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("hidden") && el.getClientRects().length > 0,
  );
}
