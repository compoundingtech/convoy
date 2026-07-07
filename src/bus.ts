// The smalltalk bus (members / status). Ported from Sources/ConvoyKit/Bus.swift. Shells the `st` CLI
// for now — smalltalk (@myobie/coord) doesn't yet export a bus lib (its index only exports VERSION);
// migrate to native lib calls when it does. Network-pinned via ST_ROOT + nested PTY_ROOT.

import { run } from "./exec.ts";

export type AgentState = "offline" | "available" | "busy" | "away" | "dnd" | "unknown";

export interface Agent {
  identity: string;
  status: AgentState;
  name: string | null;
  lastActivity: number | null; // ms epoch, fractional; present only with --enrich
  inbox: number | null; // present only with --enrich
}

const KNOWN: readonly AgentState[] = ["offline", "available", "busy", "away", "dnd", "unknown"];
const LIVE: ReadonlySet<AgentState> = new Set<AgentState>(["available", "busy", "away", "dnd"]);

export function isLive(s: AgentState): boolean {
  return LIVE.has(s);
}

function normalizeState(s: unknown): AgentState {
  return typeof s === "string" && (KNOWN as readonly string[]).includes(s) ? (s as AgentState) : "unknown";
}

/** Decode `st agents --json` output. Tolerant of the planned `identity` → `agent` key rename and of
 *  unknown states (decode to `unknown`, never throw) — mirrors the Swift Codable. */
export function decodeAgents(json: string): Agent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Agent[] = [];
  for (const o of raw) {
    if (o === null || typeof o !== "object") continue;
    const rec = o as Record<string, unknown>;
    const identity = (rec["identity"] ?? rec["agent"]) as string | undefined;
    if (!identity) continue;
    out.push({
      identity,
      status: normalizeState(rec["status"]),
      name: typeof rec["name"] === "string" ? (rec["name"] as string) : null,
      lastActivity: typeof rec["lastActivity"] === "number" ? (rec["lastActivity"] as number) : null,
      inbox: typeof rec["inbox"] === "number" ? (rec["inbox"] as number) : null,
    });
  }
  return out;
}

export class Bus {
  readonly root: string | null;

  constructor(root: string | null) {
    this.root = root;
  }

  private env(): NodeJS.ProcessEnv | undefined {
    if (!this.root) return undefined;
    return { ...process.env, ST_ROOT: this.root, PTY_ROOT: `${this.root}/pty` };
  }

  async agents(enrich = false): Promise<Agent[]> {
    const args = ["agents", "--json"];
    if (enrich) args.push("--enrich");
    const r = await run("st", args, { env: this.env() });
    return r.ok ? decodeAgents(r.stdout) : [];
  }

  async setStatus(identity: string, state: string): Promise<void> {
    await run("st", ["status", identity, "--set", state], { env: this.env() });
  }

  async roundTrips(): Promise<boolean> {
    const r = await run("st", ["agents", "--json"], { env: this.env() });
    return r.ok;
  }
}
