// convoy CLI — hand-rolled argv dispatch (like pty's src/cli.ts). The full surface (add/cos/init/ls/
// doctor/remove/personas) lands in M4–M6; `up` — the load-bearing host verb — is wired now, with its
// e2e guardrail (scripts/e2e-convoy-up.sh CONVOY_BIN=./bin/convoy).

import { up, type UpOptions } from "./up.ts";

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case "up":
      process.exit(await cmdUp(rest));
      break;
    case undefined:
    case "-h":
    case "--help":
      printHelp();
      break;
    default:
      process.stderr.write(`convoy (TS): '${cmd}' is not ported yet — see notes/TS-PORT-PLAN.md (M4/M6).\n`);
      process.exit(2);
  }
}

async function cmdUp(args: string[]): Promise<number> {
  const opts: UpOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--json": opts.json = true; break;
      case "--once": opts.once = true; break;
      case "--keep-sessions": opts.keepSessions = true; break;
      case "--reconcile-interval": opts.reconcileInterval = Number(args[++i]); break;
      case "--fast-fail-window": opts.fastFailWindow = Number(args[++i]); break;
      case "--fast-fail-limit": opts.fastFailLimit = Number(args[++i]); break;
      default:
        if (a !== undefined && !a.startsWith("-")) positional.push(a);
        break;
    }
  }
  opts.network = positional[0];
  return up(opts);
}

function printHelp(): void {
  process.stdout.write(
    "convoy — TypeScript port (in progress; notes/TS-PORT-PLAN.md).\n" +
      "Wired: convoy up <network> [--reconcile-interval N] [--fast-fail-window N]\n" +
      "                          [--fast-fail-limit N] [--json] [--once] [--keep-sessions]\n",
  );
}
