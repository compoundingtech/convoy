import { describe, it, expect } from "vitest";
import { decodeAgents, isLive } from "./bus.ts";

describe("Bus.decodeAgents (ported from Bus.swift Codable)", () => {
  it("decodes identity + status + enrich fields", () => {
    const a = decodeAgents(JSON.stringify([{ identity: "cos", status: "busy", name: "Chief", lastActivity: 123.5, inbox: 2 }]));
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual({ identity: "cos", status: "busy", name: "Chief", lastActivity: 123.5, inbox: 2 });
  });

  it("tolerates the identity → agent key rename", () => {
    const a = decodeAgents(JSON.stringify([{ agent: "wk1", status: "available" }]));
    expect(a[0]?.identity).toBe("wk1");
  });

  it("decodes an unknown state to 'unknown' (never throws)", () => {
    const a = decodeAgents(JSON.stringify([{ identity: "x", status: "teleporting" }]));
    expect(a[0]?.status).toBe("unknown");
  });

  it("drops entries with no identity + survives malformed json", () => {
    expect(decodeAgents(JSON.stringify([{ status: "available" }]))).toHaveLength(0);
    expect(decodeAgents("not json")).toEqual([]);
    expect(decodeAgents(JSON.stringify({ not: "an array" }))).toEqual([]);
  });

  it("isLive matches the Swift rollup", () => {
    for (const s of ["available", "busy", "away", "dnd"] as const) expect(isLive(s)).toBe(true);
    expect(isLive("offline")).toBe(false);
    expect(isLive("unknown")).toBe(false);
  });
});
