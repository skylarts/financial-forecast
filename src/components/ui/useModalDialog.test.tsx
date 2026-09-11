// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModalDialog } from "./useModalDialog";

/**
 * The hook exercised through a tiny dialog, the way every real overlay uses
 * it: a box with a couple of buttons, mounted next to an opener that already
 * has focus.
 */
function Dialog({ onClose, empty = false }: { onClose: () => void; empty?: boolean }) {
  const box = useModalDialog<HTMLDivElement>(onClose);
  return (
    <div ref={box} role="dialog" data-testid="box">
      {!empty && (
        <>
          <button type="button" data-testid="first">
            First
          </button>
          <input data-testid="middle" />
          <button type="button" data-testid="last">
            Last
          </button>
        </>
      )}
    </div>
  );
}

let host: HTMLDivElement;
let opener: HTMLButtonElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  opener = document.createElement("button");
  opener.textContent = "Open";
  document.body.appendChild(opener);
  opener.focus();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // jsdom has no layout, so every element reports no client rects; the hook
  // uses those to skip hidden controls. Report one for anything attached.
  Element.prototype.getClientRects = function () {
    return [{}] as unknown as DOMRectList;
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  opener.remove();
});

function press(key: string, shiftKey = false) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  });
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe("useModalDialog", () => {
  it("moves focus to the first control on open and back to the opener on close", () => {
    const onClose = vi.fn();
    act(() => root.render(<Dialog onClose={onClose} />));
    expect(document.activeElement).toBe(byId("first"));

    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    act(() => root.render(<Dialog onClose={onClose} />));
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the latest onClose without re-registering", () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => root.render(<Dialog onClose={first} />));
    act(() => root.render(<Dialog onClose={second} />));
    press("Escape");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab from the last control to the first, and Shift+Tab the other way", () => {
    act(() => root.render(<Dialog onClose={() => {}} />));
    byId("last").focus();
    press("Tab");
    expect(document.activeElement).toBe(byId("first"));
    press("Tab", true);
    expect(document.activeElement).toBe(byId("last"));
  });

  it("pulls focus back in when it has escaped the box", () => {
    act(() => root.render(<Dialog onClose={() => {}} />));
    opener.focus();
    press("Tab");
    expect(document.activeElement).toBe(byId("first"));
  });

  it("keeps focus on the box itself when it holds no controls", () => {
    act(() => root.render(<Dialog onClose={() => {}} empty />));
    expect(document.activeElement).toBe(byId("box"));
    press("Tab");
    expect(document.activeElement).toBe(byId("box"));
  });
});
