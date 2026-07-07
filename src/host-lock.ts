// The single-owner guard for a hosted network — `<root>/convoy.pid`. One convoy (CLI `convoy up` OR
// the menubar app) may host a network at a time; two hosts double-spawn every agent. Ported 1:1 from
// Sources/ConvoyKit/HostLock.swift. Both the CLI and the app go through this so the check + the
// warning are identical (symmetric).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class HostLock {
  // (explicit field + assign, not a parameter property — erasable-syntax-only, node-strip-types-safe)
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get pidPath(): string {
    return join(this.root, "convoy.pid");
  }

  /** The pid of a *live* convoy already hosting this network, or null (no lock, stale lock, or us). */
  liveOwner(): number | null {
    let raw: string;
    try {
      raw = readFileSync(this.pidPath, "utf8");
    } catch {
      return null;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid === process.pid) return null;
    try {
      // signal 0 sends nothing — it just probes whether the process exists.
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  }

  /** True if a lock file exists but its owner is dead (a crashed host left it behind). */
  hasStaleLock(): boolean {
    return existsSync(this.pidPath) && this.liveOwner() === null;
  }

  /** Write our pid as the owner. Call only after `liveOwner() === null`. Creates root if missing. */
  acquire(): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.pidPath, String(process.pid));
  }

  /** Remove the lock — but only if it is still ours (never clobber a live successor's lock). */
  release(): void {
    try {
      const pid = Number.parseInt(readFileSync(this.pidPath, "utf8").trim(), 10);
      if (pid === process.pid) rmSync(this.pidPath);
    } catch {
      // no lock / not ours — nothing to do
    }
  }

  /** The one clear, actionable warning shown by BOTH the CLI and the app when another host owns this. */
  busyWarning(ownerPid: number): string {
    return (
      `another convoy is already hosting this network (pid ${ownerPid}) — refusing to start.\n` +
      `Two hosts on one network double-spawn every agent. Stop the other host first.\n` +
      `If it is already gone, clear the stale lock:  rm ${this.pidPath}`
    );
  }
}
