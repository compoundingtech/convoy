import ArgumentParser
import ConvoyKit
import Foundation

/// `convoy remove <id>` — remove an agent from the convoy (the symmetric partner to `add`).
///
/// v1 teardown: stop the agent's pty session(s) and, with `--purge`, remove its membership dir.
/// Session-name resolution is best-effort pending the canonical pty recipe; message history is
/// never hard-deleted unless you pass `--purge`.
struct Remove: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Remove an agent from the convoy (teardown / decommission)."
    )

    @Argument(help: "The identity to remove.")
    var identity: String

    @Option(name: .long, help: "Network root (ST_ROOT). Defaults to st's default network.")
    var network: String?

    @Flag(name: .long, help: "Also delete the agent's membership dir (inbox/archive) — destroys message history.")
    var purge = false

    @Flag(name: .long, help: "Show what would happen; touch nothing.")
    var dryRun = false

    @Flag(name: [.short, .long], help: "Skip confirmation prompts.")
    var yes = false

    func run() throws {
        let bus = Bus(root: network)

        // Must exist to remove.
        let members = (try? bus.agents()) ?? []
        guard members.contains(where: { $0.identity == identity }) else {
            throw ConvoyError("no agent \"\(identity)\" on this network. `convoy ls\(network.map { " --network \($0)" } ?? "")` to list members.")
        }

        Out.line("convoy remove — plan:")
        Out.line("  stop pty session(s) for \(identity)")
        if purge { Out.line("  purge membership dir (\(network ?? "default")/\(identity)) — DELETES message history") }

        if dryRun {
            Out.line("\n✓ Dry run only. Re-run without --dry-run to execute.")
            return
        }

        if !yes {
            let what = purge ? "Stop and PURGE" : "Stop"
            print("\n\(what) \(identity)? [y/N] ", terminator: "")
            guard let a = readLine()?.lowercased(), a == "y" || a == "yes" else {
                Out.line("Aborted."); throw ExitCode.failure
            }
        }

        // Stop sessions. `pty kill` takes a session ref; the identity is the best-effort ref.
        // (Exact identity→session mapping is finalized once the pty recipe lands.)
        let env = envOverlay()
        let killed = try Shell.run("pty", ["kill", identity], env: env, check: false)
        if killed.ok {
            Out.line("✓ stopped pty session \(identity)")
        } else {
            Out.line("• no pty session matched \"\(identity)\" (already down, or a different session name) — check `pty list`")
        }

        if purge {
            let root = network ?? defaultNetworkRoot()
            let dir = root + "/" + identity
            if FileManager.default.fileExists(atPath: dir) {
                try FileManager.default.removeItem(atPath: dir)
                Out.line("✓ purged \(dir)")
            } else {
                Out.line("• membership dir not found at \(dir)")
            }
        }

        Out.line("✓ \(identity) removed from the convoy.")
    }

    private func envOverlay() -> [String: String]? {
        guard let network else { return nil }
        var env = ProcessInfo.processInfo.environment
        env["ST_ROOT"] = network
        env["PTY_ROOT"] = network + "/pty"
        return env
    }

    private func defaultNetworkRoot() -> String {
        ProcessInfo.processInfo.environment["ST_ROOT"]
            ?? (ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()) + "/.local/state/smalltalk"
    }
}
