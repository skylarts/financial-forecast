import { describe, it, expect } from "vitest";
import { computeMonthlyPayment, amortizeMonth } from "./amortization";

describe("computeMonthlyPayment", () => {
  it("matches a known 30yr fixed mortgage payment", () => {
    // $500,000 @ 6% for 360 months -> ~$2,997.75/mo (standard amortization formula)
    const payment = computeMonthlyPayment(500_000, 0.06, 360);
    expect(payment).toBeCloseTo(2997.75, 1);
  });
  it("handles a zero-interest loan as a simple division", () => {
    expect(computeMonthlyPayment(12_000, 0, 12)).toBeCloseTo(1000, 6);
  });
});

describe("amortizeMonth", () => {
  it("fully pays off principal and interest across the loan term", () => {
    const principal = 100_000;
    const rate = 0.05;
    const term = 60;
    const payment = computeMonthlyPayment(principal, rate, term);
    let balance = principal;
    for (let i = 0; i < term; i++) {
      const step = amortizeMonth(balance, rate, payment);
      balance = step.newBalance;
    }
    expect(balance).toBeCloseTo(0, 2);
  });
  it("interest + principal portions sum to the payment (mid-loan)", () => {
    const step = amortizeMonth(80_000, 0.06, 2997.75);
    expect(step.interestPortion + step.principalPortion).toBeCloseTo(2997.75, 6);
  });
});
