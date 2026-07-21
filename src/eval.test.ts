import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobOutcomeFromGrade, locateCellScript, overallOutcome, parseGradeOutput, type GradeResult, type JobVerdict } from "./eval.ts";

// ---------- pure helpers ----------

describe("parseGradeOutput", () => {
  it("counts [PASS]/[FAIL]/[WARN] rows (leading whitespace allowed) + extracts SCORE + headline", () => {
    const text = [
      "== section ==",
      "  [PASS] a is fine",
      "[FAIL] b is broken",
      "  [WARN] c is iffy",
      "[PASS] d ok",
      "",
      "SCORE (mechanical): 2 PASS / 1 FAIL / 1 WARN",
      "==> mycell: FAIL — see the [FAIL] rows.",
    ].join("\n");
    const g = parseGradeOutput(text, 1);
    expect(g.pass).toBe(2);
    expect(g.fail).toBe(1);
    expect(g.warn).toBe(1);
    expect(g.exitCode).toBe(1);
    expect(g.score).toBe("2 PASS / 1 FAIL / 1 WARN");
    expect(g.headline).toBe("mycell: FAIL — see the [FAIL] rows.");
    expect(g.rows[0]).toEqual({ level: "PASS", text: "a is fine" });
    expect(g.rows.length).toBe(4);
  });

  it("handles a clean all-pass grader with no FAIL/WARN", () => {
    const g = parseGradeOutput("[PASS] one\n[PASS] two\n==> ok: PASS\n", 0);
    expect([g.pass, g.fail, g.warn]).toEqual([2, 0, 0]);
    expect(g.exitCode).toBe(0);
    expect(g.ran).toBe(true);
  });
});

describe("jobOutcomeFromGrade", () => {
  const g = (over: Partial<GradeResult>): GradeResult => ({ ran: true, exitCode: 0, pass: 0, fail: 0, warn: 0, headline: null, score: null, rows: [], ...over });
  it("exit 0 → pass, nonzero → fail (the grader's exit code is authoritative)", () => {
    expect(jobOutcomeFromGrade(g({ exitCode: 0 }))).toBe("pass");
    expect(jobOutcomeFromGrade(g({ exitCode: 1 }))).toBe("fail");
  });
  it("a grader that never ran / has no exit code → error (not a fail)", () => {
    expect(jobOutcomeFromGrade(null)).toBe("error");
    expect(jobOutcomeFromGrade(g({ ran: false }))).toBe("error");
    expect(jobOutcomeFromGrade(g({ exitCode: null }))).toBe("error");
  });
});

describe("overallOutcome", () => {
  const j = (outcome: JobVerdict["outcome"]): JobVerdict => ({ id: "x", outcome, completion: { signalled: true, via: "explicit", status: "ok", by: null, message: null, waitedMs: 0 }, grade: null });
  it("worst-wins: error > fail > pass; empty → error", () => {
    expect(overallOutcome([])).toBe("error");
    expect(overallOutcome([j("pass"), j("pass")])).toBe("pass");
    expect(overallOutcome([j("pass"), j("fail")])).toBe("fail");
    expect(overallOutcome([j("fail"), j("error")])).toBe("error");
  });
});

describe("locateCellScript", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  it("prefers fixture/<name>, falls back to the cell root, else null", () => {
    const cell = mkdtempSync(join(tmpdir(), "convoy-cell-"));
    dirs.push(cell);
    expect(locateCellScript(cell, "spin.sh")).toBeNull();
    writeFileSync(join(cell, "spin.sh"), "#!/usr/bin/env bash\n");
    expect(locateCellScript(cell, "spin.sh")).toBe(join(cell, "spin.sh"));
    mkdirSync(join(cell, "fixture"), { recursive: true });
    writeFileSync(join(cell, "fixture", "spin.sh"), "#!/usr/bin/env bash\n");
    expect(locateCellScript(cell, "spin.sh")).toBe(join(cell, "fixture", "spin.sh")); // fixture/ wins
  });
});

// ---------- end-to-end: the orchestrator pipe through the REAL CLI ----------
// A hermetic fake cell (no real agents/pty): spin.sh does the "work" + signals done via `convoy job done`
// (which must resolve the SAME network the orchestrator polls — the crux), grade.sh checks the artifact.
// Proves launch → done-signal → grade → verdict end-to-end, deterministically, in ~seconds.

describe("convoy eval — end-to-end orchestrator pipe (real CLI)", () => {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const convoyBin = join(repoRoot, "bin", "convoy");
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function fakeCell(gradePass: boolean): string {
    const cell = mkdtempSync(join(tmpdir(), "cve-cell-"));
    dirs.push(cell);
    const fx = join(cell, "fixture");
    mkdirSync(fx, { recursive: true });
    // spin.sh: the "agent" writes an artifact + signals the batch job done through the real convoy CLI.
    writeFileSync(
      join(fx, "spin.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'SB="$1"',
        'echo "MIT" > "$SB/LICENSE.txt"',
        // resolve the completion event to the orchestrator's isolated net via ambient ST_ROOT — no --network
        '"${CONVOY_BIN:-convoy}" job done --status ok --message "artifact written"',
        "echo spun",
      ].join("\n") + "\n",
    );
    // grade.sh: authoritative pass/fail via exit code; prints the [PASS]/[FAIL] + SCORE + headline shape.
    writeFileSync(
      join(fx, "grade.sh"),
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'SB="$1"',
        "fail=0",
        `if [ "$(cat "$SB/LICENSE.txt" 2>/dev/null)" = "MIT" ]; then echo "  [PASS] license is MIT"; else echo "  [FAIL] license is not MIT"; fail=1; fi`,
        gradePass ? "echo '  [PASS] forced pass'" : "echo '  [FAIL] forced fail'; fail=1",
        'echo "SCORE (mechanical): $(( 2 - fail )) PASS / $fail FAIL / 0 WARN"',
        '[ "$fail" -eq 0 ] && echo "==> fakecell: PASS" || echo "==> fakecell: FAIL"',
        '[ "$fail" -eq 0 ]',
      ].join("\n") + "\n",
    );
    chmodSync(join(fx, "spin.sh"), 0o755);
    chmodSync(join(fx, "grade.sh"), 0o755);
    return cell;
  }

  function runEval(cell: string): { rc: number; verdict: any } {
    const sb = mkdtempSync(join(tmpdir(), "cve-sb-"));
    dirs.push(sb);
    let rc = 0;
    let stdout = "";
    try {
      stdout = execFileSync("node", [convoyBin, "eval", cell, "--sandbox", sb, "--json", "--keep", "--timeout", "20000", "--poll", "50"], {
        encoding: "utf8",
        timeout: 60000,
      });
    } catch (e: any) {
      rc = typeof e.status === "number" ? e.status : 1;
      stdout = e.stdout?.toString() ?? "";
    }
    return { rc, verdict: JSON.parse(stdout) };
  }

  it("PASS cell: launch → explicit done-signal → grade exit 0 → verdict pass (rc 0)", () => {
    const { rc, verdict } = runEval(fakeCell(true));
    expect(verdict.schema).toBe("convoy.eval.verdict/v1");
    expect(verdict.outcome).toBe("pass");
    expect(rc).toBe(0);
    expect(verdict.jobs).toHaveLength(1);
    const j = verdict.jobs[0];
    expect(j.completion.signalled).toBe(true);
    expect(j.completion.via).toBe("explicit");
    expect(j.completion.status).toBe("ok");
    expect(j.completion.message).toBe("artifact written");
    expect(j.grade.exitCode).toBe(0);
    expect(j.grade.pass).toBeGreaterThanOrEqual(2);
    expect(j.grade.fail).toBe(0);
    expect(verdict.spin.exitCode).toBe(0);
  }, 70000);

  it("FAIL cell: grade exit nonzero → verdict fail (rc 1), even though the job self-reported ok", () => {
    const { rc, verdict } = runEval(fakeCell(false));
    expect(verdict.outcome).toBe("fail");
    expect(rc).toBe(1);
    expect(verdict.jobs[0].completion.status).toBe("ok"); // agent self-report...
    expect(verdict.jobs[0].outcome).toBe("fail"); // ...but the grader is authoritative
    expect(verdict.jobs[0].grade.fail).toBeGreaterThanOrEqual(1);
  }, 70000);
});
