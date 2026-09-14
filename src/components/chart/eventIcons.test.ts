import { describe, expect, it } from "vitest";
import { EVENT_TYPE_ICONS, TEMPLATE_ICONS, eventIconFor, iconForTemplate } from "./eventIcons";
import { LIFE_EVENT_TEMPLATES } from "@/lib/lifeEventTemplates";
import { EVENT_TYPE_LABELS } from "@/lib/timelineFormat";

describe("marker icons", () => {
  it("every life-event template has its own icon", () => {
    const missing = LIFE_EVENT_TEMPLATES.filter((t) => !TEMPLATE_ICONS[t.id]).map((t) => t.id);
    expect(missing).toEqual([]);
  });

  it("has no icon for a template that no longer exists", () => {
    const ids = new Set(LIFE_EVENT_TEMPLATES.map((t) => t.id));
    expect(Object.keys(TEMPLATE_ICONS).filter((id) => !ids.has(id))).toEqual([]);
  });

  it("every event type has an icon and a label", () => {
    for (const [type, icon] of Object.entries(EVENT_TYPE_ICONS)) {
      expect(icon, type).toBeTruthy();
      expect(EVENT_TYPE_LABELS[type as keyof typeof EVENT_TYPE_LABELS], type).toBeTruthy();
    }
  });

  it("distinguishes the templates that share an underlying record type", () => {
    // These all become one open_loan / sell_home / buy_home underneath; the
    // whole point of templateId is that they don't look identical.
    const pairs = [
      ["car-loan", "loan"],
      ["car-loan", "heloc"],
      ["downsize", "sell-home"],
      ["rental-property", "buy-home"],
      ["car-cash", "car-loan"],
    ];
    for (const [a, b] of pairs) expect(TEMPLATE_ICONS[a], `${a} vs ${b}`).not.toBe(TEMPLATE_ICONS[b]);
  });

  it("prefers a template's icon over the record's own, and falls back cleanly", () => {
    expect(iconForTemplate("wedding", "💳")).toBe(TEMPLATE_ICONS.wedding);
    expect(iconForTemplate(undefined, "💳")).toBe("💳");
    // A plan written before this feature, or hand-edited, names nothing we know.
    expect(iconForTemplate("no-such-template", "💳")).toBe("💳");
  });

  it("an event falls back through template, then loan kind, then type", () => {
    expect(eventIconFor({ type: "open_loan", templateId: "car-loan" })).toBe(TEMPLATE_ICONS["car-loan"]);
    expect(eventIconFor({ type: "open_loan", loanKind: "heloc" })).toBe("🏡");
    expect(eventIconFor({ type: "open_loan" })).toBe(EVENT_TYPE_ICONS.open_loan);
  });

  it("drawn icons are marked so, and named art that exists", () => {
    const drawn = Object.values(TEMPLATE_ICONS).filter((i) => i.startsWith("art:"));
    expect(drawn.length).toBeGreaterThan(0);
    // MarkerIcon draws exactly these; a typo here would render an empty box.
    const known = new Set(["refinance", "downsize", "part_time", "car_loan"]);
    for (const icon of drawn) expect(known.has(icon.slice(4)), icon).toBe(true);
  });
});
