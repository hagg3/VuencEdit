import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ErrorBoundary from "./ErrorBoundary";
import { FailureChip } from "./PanelBoundary";
import { RootFallback } from "./RootErrorBoundary";
import { registerRootSave, hasRootSave, runRootSave } from "./rootSave";

/** The vitest env has no DOM and SSR never runs error boundaries, so these drive the class's own
 *  contract directly: getDerivedStateFromError, then render() in the errored state. */
function erroredRender(props: ConstructorParameters<typeof ErrorBoundary>[0], err: Error) {
  const b = new ErrorBoundary(props);
  b.state = ErrorBoundary.getDerivedStateFromError(err);
  return b;
}

describe("ErrorBoundary containment contract", () => {
  it("passes children through until something throws", () => {
    const b = new ErrorBoundary({ children: "kid" });
    expect(b.render()).toBe("kid");
  });

  it("hands the fallback error, retry and dismiss", () => {
    let got: unknown[] = [];
    const b = erroredRender({ children: "kid", fallback: (...a) => { got = a; return "fb"; } }, new Error("boom"));
    expect(b.render()).toBe("fb");
    expect((got[0] as Error).message).toBe("boom");
    expect(typeof got[1]).toBe("function");
    expect(typeof got[2]).toBe("function");
  });
});

describe("FailureChip", () => {
  it("shows label, message, Retry and Close", () => {
    const html = renderToStaticMarkup(createElement(FailureChip, {
      label: "Lens", message: "bad thing", onRetry: () => {}, onClose: () => {},
    }));
    expect(html).toContain("Lens failed");
    expect(html).toContain("bad thing");
    expect(html).toContain("Retry");
    expect(html).toContain("Close");
  });
});

describe("root fallback keeps Save reachable", () => {
  it("offers Save only when App registered a save handler", async () => {
    registerRootSave(null);
    expect(hasRootSave()).toBe(false);
    expect(await runRootSave()).toBe(false);
    let h = renderToStaticMarkup(createElement(RootFallback, { error: new Error("x"), retry: () => {} }));
    expect(h).not.toMatch(/>Save</);

    let calls = 0;
    registerRootSave(async () => { calls++; return true; });
    expect(hasRootSave()).toBe(true);
    expect(await runRootSave()).toBe(true);
    expect(calls).toBe(1);
    h = renderToStaticMarkup(createElement(RootFallback, { error: new Error("x"), retry: () => {} }));
    expect(h).toMatch(/>Save</);
    expect(h).toContain("Reload editor");
    registerRootSave(async () => false);
    expect(await runRootSave()).toBe(false);
    registerRootSave(null);
  });
});
