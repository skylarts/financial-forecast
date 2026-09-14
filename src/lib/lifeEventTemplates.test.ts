import { describe, expect, it } from "vitest";
import { LIFE_EVENT_TEMPLATES, LIFE_EVENT_GROUPS, resolveTemplate, searchTemplates, type TemplateContext } from "./lifeEventTemplates";
import type { Account, Person } from "@/domain";

const alex: Person = { id: "alex", name: "Alex", birthDate: "1990-05-15", retirementAge: 60, planningEndAge: 95 };
const brokerage = { id: "brk", name: "Brokerage", class: "taxable_investment", category: "asset" } as Account;
const plan529 = { id: "529", name: "College fund", class: "education_529", category: "asset" } as Account;
const ctx: TemplateContext = { people: [alex], accounts: [brokerage, plan529], planStartDate: "2026-01-01" };
const byId = (id: string) => LIFE_EVENT_TEMPLATES.find((t) => t.id === id)!;

describe("life-event templates", () => {
  it("every template has a unique id and a known group", () => {
    const ids = LIFE_EVENT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of LIFE_EVENT_TEMPLATES) expect(LIFE_EVENT_GROUPS).toContain(t.group);
  });

  it("a fixed-length expense ends N years after it starts", () => {
    const r = resolveTemplate(byId("baby"), ctx);
    expect(r.kind).toBe("expense");
    if (r.kind !== "expense") return;
    expect(r.seed.category).toBe("childcare");
    expect(r.seed.startDate).toBe("2026-01-01");
    expect(r.seed.endDate).toBe("2031-01-01");
    expect(r.seed.startAnchor).toBeNull();
  });

  it("an age-based expense starts on the owner's birthday at that age", () => {
    const r = resolveTemplate(byId("long-term-care"), ctx);
    if (r.kind !== "expense") throw new Error();
    expect(r.seed.startDate).toBe("2072-05-15"); // Alex turns 82
    expect(r.seed.endDate).toBeNull();
    expect(r.seed.growthRatePct).toBe(0.05);
  });

  it("a retirement-relative window is written as anchors, not dates, so it follows the age", () => {
    const r = resolveTemplate(byId("travel"), ctx);
    if (r.kind !== "expense") throw new Error();
    expect(r.seed.startAnchor).toEqual({ personId: "alex", point: "retirement", offsetMonths: 0 });
    expect(r.seed.endAnchor).toEqual({ personId: "alex", point: "retirement", offsetMonths: 180 });
    expect(r.seed.startDate).toBe(""); // the drawer fills it from the anchor
  });

  it("a new salary ends the day before retirement via an end anchor", () => {
    const r = resolveTemplate(byId("new-job"), ctx);
    if (r.kind !== "income") throw new Error();
    expect(r.seed.ownerId).toBe("alex");
    expect(r.seed.endAnchor).toEqual({ personId: "alex", point: "retirement", offsetMonths: 0 });
    expect(r.seed.startDate).toBe("2026-01-01");
  });

  it("Social Security claims at 67 and a pension at the owner's retirement age", () => {
    const ss = resolveTemplate(byId("social-security"), ctx);
    if (ss.kind !== "income") throw new Error();
    expect(ss.seed.claimAge).toBe(67);
    expect(ss.seed.startDate).toBe("2057-05-15");
    const p = resolveTemplate(byId("pension"), ctx);
    if (p.kind !== "income") throw new Error();
    expect(p.seed.claimAge).toBe(60);
    expect(p.seed.startDate).toBe("2050-05-15");
    expect(p.seed.growthRatePct).toBe(0);
  });

  it("prefers the matching account class for where money lands or is paid from", () => {
    const inh = resolveTemplate(byId("inheritance"), ctx);
    if (inh.kind !== "income") throw new Error();
    expect(inh.seed.depositAccountId).toBe("brk");
    const col = resolveTemplate(byId("college"), ctx);
    if (col.kind !== "expense") throw new Error();
    expect(col.seed.paymentAccountId).toBe("529");
    // ...and falls back to the hub (null) when there is no such account.
    const bare = resolveTemplate(byId("college"), { ...ctx, accounts: [] });
    if (bare.kind !== "expense") throw new Error();
    expect(bare.seed.paymentAccountId).toBeNull();
  });

  it("a career break is a 12-month pause; part-time is an open-ended half", () => {
    const brk = resolveTemplate(byId("career-break"), ctx);
    if (brk.kind !== "adjustment") throw new Error();
    expect(brk.adjustment.multiplier).toBe(0);
    expect(brk.adjustment.startDate).toBe("2026-01-01");
    expect(brk.adjustment.endDate).toBe("2027-01-01");
    const pt = resolveTemplate(byId("part-time"), ctx);
    if (pt.kind !== "adjustment") throw new Error();
    expect(pt.adjustment.multiplier).toBe(0.5);
    expect(pt.adjustment.endDate).toBeNull();
  });

  it("survives a household with nobody in it", () => {
    const r = resolveTemplate(byId("long-term-care"), { ...ctx, people: [] });
    if (r.kind !== "expense") throw new Error();
    expect(r.seed.startDate).toBe("2026-01-01");
    const t = resolveTemplate(byId("travel"), { ...ctx, people: [] });
    if (t.kind !== "expense") throw new Error();
    expect(t.seed.startAnchor).toBeNull();
  });

  it("search matches label, hint and keywords", () => {
    expect(searchTemplates("daycare").map((t) => t.id)).toEqual(["baby"]);
    expect(searchTemplates("HELOC").map((t) => t.id)).toContain("heloc");
    expect(searchTemplates("").length).toBe(LIFE_EVENT_TEMPLATES.length);
    expect(searchTemplates("zzzz")).toEqual([]);
  });
});
