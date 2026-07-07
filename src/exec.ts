// A thin promise wrapper around child_process for the few tools convoy still shells (`st`, `git`).
// Most pty interaction is native via @myobie/pty/client (src/host.ts); this is the residual seam.

import { execFile } from "node:child_process";

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
  readonly ok: boolean;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
        const status = typeof code === "number" ? code : err ? 1 : 0;
        resolve({ status, stdout: stdout ?? "", stderr: stderr ?? "", get ok() { return this.status === 0; } });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}
