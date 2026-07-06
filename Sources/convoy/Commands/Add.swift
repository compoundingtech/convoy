import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy add <role> --identity <id>` — add an agent to the convoy, correct-by-construction.
///
/// This is the footgun-proof front door (AC-1). You supply high-level intent; convoy derives ALL
/// wiring (permission mode from role, ST_AGENT, network tag, transport, hooks), validates it, and
/// only launches if the wiring is coherent. No hand-authored pty.toml; no way to fumble an env var.
struct Add: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Add an agent to the convoy (correct-by-construction; was `st launch`).",
        discussion: """
        Roles map to a fixed, reviewable wiring — you never hand-set the permission mode or ENV:
          chief-of-staff (cos) → bypassPermissions, permanent (spawner)
          supervisor           → bypassPermissions            (spawner)
          technical-manager    → bypassPermissions            (spawner)
          worker               → auto                         (worker)

        Examples:
          convoy add cos --identity cos
          convoy add worker --identity build-wk --transport ding
          convoy add supervisor --identity sup --network ~/nets/demo --dry-run
        """
    )

    @Argument(help: "Role: chief-of-staff|cos, supervisor, worker, technical-manager|tm.")
    var role: String

    @Option(name: .long, help: "The agent's identity (ST_AGENT is derived from this — never hand-set).")
    var identity: String

    @Option(name: .long, help: "Transport: mcp (default) or ding.")
    var transport: String = "mcp"

    @Option(name: .long, help: "Network root (ST_ROOT). Defaults to st's default network.")
    var network: String?

    @Option(name: .long, help: "Persona file to install. Defaults to the role's base persona.")
    var persona: String?

    @Option(name: .long, help: "Harness binary: claude (default) or codex.")
    var harness: String = "claude"

    @Flag(name: .long, help: "Validate + show the derived wiring and dry-run, but don't launch.")
    var dryRun = false

    @Flag(name: [.short, .long], help: "Skip the confirmation prompt.")
    var yes = false

    func run() throws {
        // Parse intent into typed values — reject unknowns loudly.
        guard let role = Role.parse(self.role) else {
            throw ConvoyError("unknown role \"\(self.role)\". Valid: "
                + Role.allCases.map { $0.rawValue }.joined(separator: ", "))
        }
        guard let harness = Harness(rawValue: self.harness.lowercased()) else {
            throw ConvoyError("unknown harness \"\(self.harness)\". Valid: claude, codex")
        }
        guard let transport = Transport(rawValue: self.transport.lowercased()) else {
            throw ConvoyError("unknown transport \"\(self.transport)\". Valid: mcp, ding")
        }

        let spec = AgentSpec(
            harness: harness,
            role: role,
            identity: identity,
            transport: transport,
            networkRoot: network,
            personaOverride: persona
        )

        // Preflight: derive + validate. Fail loud before touching anything.
        let bus = Bus(root: network)
        let pf = spec.preflight(bus: bus)

        Out.line("convoy add — derived wiring (correct-by-construction):")
        for (k, v) in pf.derived {
            Out.line("  \(k.padding(toLength: 16, withPad: " ", startingAt: 0)) \(v)")
        }
        for w in pf.warnings { Out.line("  ! \(w)") }

        guard pf.ok else {
            Out.line()
            for e in pf.errors { Out.err(e) }
            throw ExitCode.failure
        }

        // Final wiring check: dry-run st launch and surface exactly what it will write.
        Out.line()
        Out.line("Preflight (st launch --dry-run):")
        let dry = try spec.dryRun()
        let dryText = (dry.stdout + dry.stderr).trimmingCharacters(in: .whitespacesAndNewlines)
        for l in dryText.split(separator: "\n", omittingEmptySubsequences: false) {
            Out.line("  " + l)
        }
        if !dry.ok {
            Out.line()
            Out.err("st launch --dry-run reported a problem — not launching. Resolve the above first.")
            throw ExitCode.failure
        }

        if dryRun {
            Out.line()
            Out.line("✓ Dry run only. Re-run without --dry-run to launch \(identity).")
            return
        }

        // Confirm (unless -y). This is a spawn — outward-facing enough to confirm by default.
        if !yes {
            Out.line()
            print("Launch \(identity) as \(role.rawValue) (\(spec.permissionMode.rawValue))? [y/N] ", terminator: "")
            guard let answer = readLine(), answer.lowercased() == "y" || answer.lowercased() == "yes" else {
                Out.line("Aborted.")
                throw ExitCode.failure
            }
        }

        Out.line("Launching \(identity)…")
        let result = try spec.launch()
        if !result.stdout.isEmpty { print(result.stdout, terminator: "") }
        if !result.ok {
            Out.err("st launch failed: \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
            throw ExitCode.failure
        }
        Out.line("✓ \(identity) added to the convoy. `convoy ls\(network.map { " --network \($0)" } ?? "")` to see it.")
    }
}
