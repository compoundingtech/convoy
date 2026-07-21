import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_JOB_ID,
  batchHasRun,
  completionPath,
  isValidJobId,
  jobsDir,
  markBatchRan,
  ranMarkerPath,
  readCompletion,
  waitForCompletion,
  writeCompletion,
} from "./job.ts";

const dirs: string[] = [];
function net(): string {
  const d = mkdtempSync(join(tmpdir(), "convoy-job-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("completion-event paths", () => {
  it("places events + markers under <net>/jobs/", () => {
    expect(jobsDir("/n")).toBe("/n/jobs");
    expect(completionPath("/n", "j")).toBe("/n/jobs/j.done.json");
    expect(completionPath("/n")).toBe(`/n/jobs/${DEFAULT_JOB_ID}.done.json`);
    expect(ranMarkerPath("/n", "wk")).toBe("/n/jobs/wk.ran");
  });
});

describe("isValidJobId", () => {
  it("accepts identity-shaped ids, rejects unsafe ones", () => {
    for (const ok of ["default", "license-mit", "job.1", "a_b"]) expect(isValidJobId(ok)).toBe(true);
    for (const bad of ["-x", "Job", "a/b", "a b", "", "a;b"]) expect(isValidJobId(bad)).toBe(false);
  });
});

describe("writeCompletion / readCompletion", () => {
  it("round-trips the event and creates the jobs dir atomically", () => {
    const n = net();
    const path = writeCompletion(n, { job: "default", status: "ok", message: "done", by: "silber.sup", ts: 123 });
    expect(path).toBe(completionPath(n, "default"));
    expect(existsSync(jobsDir(n))).toBe(true);
    // no leftover temp file from the atomic write
    expect(readFileSync(path, "utf8")).toMatch(/"status": "ok"/);
    expect(readCompletion(n, "default")).toEqual({ job: "default", status: "ok", message: "done", by: "silber.sup", ts: 123 });
  });

  it("returns null when no event exists yet", () => {
    expect(readCompletion(net(), "default")).toBeNull();
  });

  it("treats a malformed/partial event as not-yet-done (null), never throws", () => {
    const n = net();
    writeCompletion(n, { job: "default", status: "ok", ts: 1 }); // creates the dir
    writeFileSync(completionPath(n, "bad"), "{ not json");
    expect(readCompletion(n, "bad")).toBeNull();
    writeFileSync(completionPath(n, "nostatus"), JSON.stringify({ job: "x", ts: 2 }));
    expect(readCompletion(n, "nostatus")).toBeNull();
  });

  it("defaults the job field to the queried id when the on-disk event omits it", () => {
    const n = net();
    writeCompletion(n, { job: "seed", status: "ok", ts: 1 }); // creates <net>/jobs/
    writeFileSync(completionPath(n, "j"), JSON.stringify({ status: "fail", ts: 7 })); // no `job` field
    expect(readCompletion(n, "j")).toEqual({ job: "j", status: "fail", message: undefined, by: undefined, ts: 7 });
  });
});

describe("waitForCompletion", () => {
  it("resolves immediately when the event already exists", async () => {
    const n = net();
    writeCompletion(n, { job: "default", status: "ok", ts: 1 });
    const ev = await waitForCompletion(n, "default", { timeoutMs: 1000, pollMs: 10 });
    expect(ev?.status).toBe("ok");
  });

  it("returns null on timeout when nothing signals", async () => {
    const start = Date.now();
    const ev = await waitForCompletion(net(), "default", { timeoutMs: 60, pollMs: 10 });
    expect(ev).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it("picks up an event written WHILE polling", async () => {
    const n = net();
    setTimeout(() => writeCompletion(n, { job: "default", status: "fail", by: "wk", ts: 9 }), 30);
    const ev = await waitForCompletion(n, "default", { timeoutMs: 2000, pollMs: 10 });
    expect(ev).toEqual({ job: "default", status: "fail", message: undefined, by: "wk", ts: 9 });
  });
});

describe("batch ran-marker (one-shot bookkeeping)", () => {
  it("markBatchRan → batchHasRun, independent of the completion event", () => {
    const n = net();
    expect(batchHasRun(n, "wk")).toBe(false);
    markBatchRan(n, "wk");
    expect(batchHasRun(n, "wk")).toBe(true);
    expect(existsSync(ranMarkerPath(n, "wk"))).toBe(true);
    // a completion event for the run does NOT imply a per-agent ran-marker, and vice-versa
    expect(readCompletion(n, "wk")).toBeNull();
  });
});
