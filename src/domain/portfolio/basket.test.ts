import { describe, expect, it } from "vitest";
import { basketBySymbol, normalizeBasketName, type Basket } from "./basket";

const basket = (patch: Partial<Basket> & { id: string }): Basket => ({
  name: patch.id,
  symbols: [],
  ...patch,
});

describe("normalizeBasketName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeBasketName("  AI   core  ")).toBe("AI core");
  });
});

describe("basketBySymbol", () => {
  it("maps every member to its basket", () => {
    const ai = basket({ id: "b1", name: "AI", symbols: ["NVDA", "AVGO"] });
    const map = basketBySymbol([ai, basket({ id: "b2", name: "Bonds", symbols: ["BND"] })]);
    expect(map.get("NVDA")).toBe(ai);
    expect(map.get("BND")?.name).toBe("Bonds");
    expect(map.get("VTI")).toBeUndefined();
  });

  it("gives a symbol claimed twice to the first basket only", () => {
    // The store keeps membership exclusive on write; this is the read side
    // holding the line for a hand-edited backup that doesn't.
    const map = basketBySymbol([
      basket({ id: "b1", name: "AI", symbols: ["NVDA"] }),
      basket({ id: "b2", name: "Chips", symbols: ["NVDA"] }),
    ]);
    expect(map.get("NVDA")?.name).toBe("AI");
  });
});
