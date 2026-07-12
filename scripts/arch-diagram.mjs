#!/usr/bin/env node
// Generates the convoy architecture diagram embedded near the top of the README.
// Program-generated so we can tweak labels/layout and regenerate cleanly instead of
// hand-aligning box characters:  node scripts/arch-diagram.mjs [--width]
//
// The layering (outer -> inner):
//   convoy      the orchestrator — spawns / reconciles / respawns sessions   (~ Nomad)
//   smalltalk   the bus — a folder per agent, messages are files, dings      (~ Consul)
//   pty         the running agent processes (the harnesses themselves)       (~ pty)
//
// Paste the output into the README's fenced code block when it changes (the block is the
// source of truth readers see; this script is how we regenerate it without hand-aligning).

const AGENTS = [
  { name: "cos", harness: "claude" },
  { name: "supervisor", harness: "codex" },
  { name: "worker", harness: "claude" },
];
const CAPTION = "convoy ≈ Nomad   ·   smalltalk ≈ Consul   ·   pty ≈ pty";

const len = (s) => [...s].length; // code-point width (box/arrow glyphs are 1 col each)
const pad = (s, w) => s + " ".repeat(Math.max(0, w - len(s)));

// A framed, auto-sized box. `title` is embedded in the top border; `lines` are content
// rows ("" = blank). Content gets a symmetric one-space margin inside the bars.
function frame(title, lines) {
  const w = Math.max(len(title), ...lines.map(len)) + 2; // +2 = one space each side
  const top = "┌ " + title + " " + "─".repeat(w - len(title) - 2) + "┐";
  const body = lines.map((l) => "│ " + pad(l, w - 1) + "│");
  const bot = "└" + "─".repeat(w) + "┘";
  return [top, ...body, bot];
}

// The smalltalk bus box, nested inside convoy below.
function busBox() {
  const nameW = Math.max(...AGENTS.map((a) => len(a.name))) + len("/inbox/");
  const harnessW = Math.max(...AGENTS.map((a) => len(a.harness)));
  const rows = AGENTS.map(
    (a) => pad(a.name + "/inbox/", nameW) + "  ──  [ pty: " + pad(a.harness, harnessW) + " ]",
  );
  return frame("smalltalk — the bus", [
    "a folder per agent · messages are files",
    "",
    ...rows,
    "",
    "send  = drop a file in a peer's inbox/",
    "ding  = poke that agent's pty to read it",
  ]);
}

const convoy = frame("convoy — the orchestrator", [
  "spawn · reconcile · respawn",
  "",
  ...busBox(),
  "",
  "stop convoy → the agents keep running",
]);

const out = [...convoy, "", " " + CAPTION].join("\n");
process.stdout.write(out + "\n");
if (process.argv.includes("--width")) {
  process.stderr.write(`\n[widest line: ${Math.max(...out.split("\n").map(len))} cols]\n`);
}
