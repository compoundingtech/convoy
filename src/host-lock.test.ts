import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostLock } from "./host-lock.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "convoy-lock-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("HostLock (single-owner guard, ported from HostLock.swift)", () => {
  it("acquire writes our pid; liveOwner returns null for our own lock", () => {
    const lock = new HostLock(tmp());
    expect(lock.liveOwner()).toBeNull();
    lock.acquire();
    expect(existsSync(lock.pidPath)).toBe(true);
    expect(lock.liveOwner()).toBeNull(); // our own pid isn't a foreign owner
  });

  it("release removes the lock only if it's ours", () => {
    const lock = new HostLock(tmp());
    lock.acquire();
    lock.release();
    expect(existsSync(lock.pidPath)).toBe(false);
  });

  it("release leaves a foreign pid's lock intact", () => {
    const lock = new HostLock(tmp());
    lock.acquire();
    writeFileSync(lock.pidPath, "999999999"); // pretend someone else owns it
    lock.release();
    expect(existsSync(lock.pidPath)).toBe(true);
  });

  it("a dead pid is a stale lock, not a live owner", () => {
    const lock = new HostLock(tmp());
    writeFileSync(lock.pidPath, "999999999"); // not a live process
    expect(lock.liveOwner()).toBeNull();
    expect(lock.hasStaleLock()).toBe(true);
  });

  it("a live foreign pid is reported as the owner", () => {
    const lock = new HostLock(tmp());
    // process.ppid is alive and (in test) not our pid → a valid 'foreign live owner' stand-in.
    writeFileSync(lock.pidPath, String(process.ppid));
    expect(lock.liveOwner()).toBe(process.ppid);
    expect(lock.hasStaleLock()).toBe(false);
  });

  it("busyWarning is clear + actionable (what / why / how-to-fix)", () => {
    const lock = new HostLock("/tmp/net");
    const w = lock.busyWarning(4242);
    expect(w).toContain("pid 4242");
    expect(w).toContain("double-spawn");
    expect(w).toContain("rm /tmp/net/convoy.pid");
  });
});
