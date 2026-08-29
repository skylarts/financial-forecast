import { describe, expect, it } from "vitest";
import { fromSchwabSymbol, toSchwabSymbol } from "./schwabSymbol";

/**
 * These translations are the difference between Schwab pricing a holding and
 * shrugging at it. A shrug is survivable -- the fallback feed picks it up --
 * but it means the connected brokerage silently prices less of the portfolio
 * than it could.
 */
describe("toSchwabSymbol", () => {
  it("leaves an ordinary ticker alone", () => {
    expect(toSchwabSymbol("AAPL")).toBe("AAPL");
    expect(toSchwabSymbol("vti")).toBe("VTI");
  });

  it("rewrites an index to Schwab's own root, not just its prefix", () => {
    // ^GSPC is $SPX, not $GSPC -- the root changes, so this cannot be done by
    // swapping the leading character.
    expect(toSchwabSymbol("^GSPC")).toBe("$SPX");
    expect(toSchwabSymbol("^IXIC")).toBe("$COMPX");
  });

  it("pads an option root to six characters, which Schwab requires", () => {
    expect(toSchwabSymbol("AAPL260116C00150000")).toBe("AAPL  260116C00150000");
    expect(toSchwabSymbol("GOOGL260116P00100000")).toBe("GOOGL 260116P00100000");
  });

  it("writes a share class with a slash", () => {
    expect(toSchwabSymbol("BRK-B")).toBe("BRK/B");
  });

  it("leaves a hyphen that isn't a share class suffix alone", () => {
    expect(toSchwabSymbol("XYZ-AB")).toBe("XYZ-AB");
  });
});

describe("fromSchwabSymbol", () => {
  it("round-trips everything it rewrote", () => {
    for (const symbol of ["AAPL", "^GSPC", "^VIX", "BRK-B", "AAPL260116C00150000"]) {
      expect(fromSchwabSymbol(toSchwabSymbol(symbol))).toBe(symbol);
    }
  });

  it("collapses the padding Schwab prints on a contract", () => {
    expect(fromSchwabSymbol("AAPL  260116C00150000")).toBe("AAPL260116C00150000");
  });
});
