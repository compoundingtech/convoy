// Ported 1:1 from Tests/ConvoyKitTests/FlappingCapTests.swift (which ported pty's gc-flapping.test.ts).
// These pin the §5 flapping-cap contract convoy implements verbatim — the highest-fidelity port.

import { describe, it, expect } from "vitest";
import {
  classify,
  commandFingerprint,
  effectiveLimit,
  effectiveWindow,
  emptyStrategyTags,
  parseStrategyTags,
  TAG,
  writtenTags,
  type Decision,
  type StrategyTags,
} from "./flapping-cap.ts";

const t0 = new Date(1_000_000 * 1000);
const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";
const WINDOW = 60;
const LIMIT = 3;

function tags(over: Partial<StrategyTags> = {}): StrategyTags {
  return { ...emptyStrategyTags(), ...over };
}
function run(t: StrategyTags, exitedAt: Date | null, currentHash = HASH_A, now = new Date(t0.getTime() + 1000_000)): Decision {
  return classify({ session: "wk1", exitedAt, tags: t, currentHash, window: WINDOW, limit: LIMIT, now });
}
const at = (secs: number) => new Date(t0.getTime() + secs * 1000);

describe("FlappingCap classifier", () => {
  it("1. first respawn: no prior state → respawn, counter 0, stamps hash + last-respawn-at", () => {
    const now = at(500);
    const d = run(tags(), null, HASH_A, now);
    expect(d.kind).toBe("respawn");
    if (d.kind !== "respawn") return;
    expect(d.tags.consecutiveFastFails).toBe(0);
    expect(d.tags.commandHash).toBe(HASH_A);
    expect(d.tags.lastRespawnAt).toEqual(now);
    expect(d.tags.status).toBeNull();
  });

  it("2. fast fail increments the counter", () => {
    const d = run(tags({ consecutiveFastFails: 1, lastRespawnAt: t0, commandHash: HASH_A }), at(10));
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(2);
  });

  it("3. reaching the limit flaps (no respawn) + emits event; last-respawn-at preserved", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), at(5));
    expect(d.kind).toBe("flap");
    if (d.kind !== "flap") return;
    expect(d.tags.status).toBe("flapping");
    expect(d.tags.consecutiveFastFails).toBe(3);
    expect(d.tags.lastRespawnAt).toEqual(t0); // flap preserves the last attempt's stamp
    expect(d.event.counter).toBe(3);
    expect(d.event.limit).toBe(3);
    expect(d.event.window).toBe(60);
    expect(d.event.type).toBe("session_flapping");
  });

  it("4. flapping + unchanged command → skip", () => {
    const d = run(tags({ consecutiveFastFails: 3, lastRespawnAt: t0, commandHash: HASH_A, status: "flapping" }), at(5));
    expect(d.kind).toBe("skip");
  });

  it("5. flapping + command changed → reset + respawn (counter 0, status cleared)", () => {
    const d = run(tags({ consecutiveFastFails: 9, lastRespawnAt: t0, commandHash: HASH_A, status: "flapping" }), at(5), HASH_B);
    expect(d.kind).toBe("respawn");
    if (d.kind !== "respawn") return;
    expect(d.tags.consecutiveFastFails).toBe(0);
    expect(d.tags.status).toBeNull();
    expect(d.tags.commandHash).toBe(HASH_B);
  });

  it("6. slow fail resets the counter to 0", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), at(120));
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(0);
  });

  it("7. §5.6.1 manual kill of a long-lived agent is a SLOW fail (not a flap footgun)", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), at(3600));
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(0);
  });

  it("8. window boundary: lived == window is a SLOW fail (< window is fast)", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), at(60));
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(0);
  });

  it("9. unknown exit time → not a fast fail (conservative reset)", () => {
    const d = run(tags({ consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: HASH_A }), null);
    expect(d.kind).toBe("respawn");
    if (d.kind === "respawn") expect(d.tags.consecutiveFastFails).toBe(0);
  });

  it("10. effective-threshold precedence: per-session tag > CLI global > default", () => {
    expect(effectiveWindow(10, 30)).toBe(10);
    expect(effectiveWindow(null, 30)).toBe(30);
    expect(effectiveWindow(null, null)).toBe(60);
    expect(effectiveLimit(5, 2)).toBe(5);
    expect(effectiveLimit(null, 2)).toBe(2);
    expect(effectiveLimit(null, null)).toBe(3);
  });

  it("11. command fingerprint: 16 lowercase hex, deterministic, sensitive to args", () => {
    const a = commandFingerprint("claude", ["--resume", "x"]);
    const b = commandFingerprint("claude", ["--resume", "x"]);
    const c = commandFingerprint("claude", ["--resume", "y"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("12. wire-format round-trip (spec §8.1): parse ⇄ writtenTags, ISO shape, string int", () => {
    const now = new Date(1_783_446_612_345); // ms with .345 fraction
    const t = tags({ consecutiveFastFails: 2, lastRespawnAt: now, commandHash: HASH_A, status: "flapping" });
    const w = writtenTags(t);
    expect(w[TAG.consecutive]).toBe("2");
    expect(w[TAG.commandHash]).toBe(HASH_A);
    expect(w[TAG.status]).toBe("flapping");
    expect(w[TAG.lastRespawn]).toMatch(/\.\d{3}Z$/); // ISO with ms fraction + Z
    const re = parseStrategyTags(w);
    expect(re.consecutiveFastFails).toBe(2);
    expect(re.commandHash).toBe(HASH_A);
    expect(re.status).toBe("flapping");
    expect(re.lastRespawnAt?.getTime()).toBe(now.getTime());
  });

  it("13. absent tags parse to sane defaults (counter 0, no status)", () => {
    const t = parseStrategyTags({});
    expect(t.consecutiveFastFails).toBe(0);
    expect(t.status).toBeNull();
    expect(t.commandHash).toBeNull();
    expect(t.lastRespawnAt).toBeNull();
  });
});
