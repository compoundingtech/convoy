import Foundation

/// A pty session as reported by `pty list --json`. convoy reads pty's registry to find an agent's
/// sessions for teardown; pty owns session lifecycle, convoy just drives it.
public struct PtySession: Decodable, Sendable {
    public let name: String            // pty's session id — what `pty kill` takes
    public let displayName: String?    // human label: `<prefix>-<sessionKey>` (e.g. `build-wk-claude`)
    public let cwd: String?
    public let status: String?
    public let command: String?
}

/// Drive the `pty` CLI (session manager). convoy reimplements none of it.
public enum Pty {
    private static func env(root: String?) -> [String: String]? {
        guard let root else { return nil }
        var e = ProcessInfo.processInfo.environment
        e["PTY_ROOT"] = root + "/pty"
        return e
    }

    /// All sessions in pty's registry. `root` pins a non-default network.
    public static func sessions(root: String? = nil) throws -> [PtySession] {
        let result = try Shell.run("pty", ["list", "--json"], env: env(root: root))
        // The deprecation notice pty may print goes to stderr; stdout is clean JSON.
        let data = Data(result.stdout.utf8)
        return (try? JSONDecoder().decode([PtySession].self, from: data)) ?? []
    }

    /// The session suffixes `st launch` emits: the main session's key is the harness name, the
    /// sidecar is `ding`. Matching against this fixed set (not a loose prefix) avoids treating a
    /// different agent that merely shares a name prefix (e.g. `build-wk-2`) as `build-wk`'s.
    static let sessionSuffixes = ["claude", "codex", "ding"]

    /// Which of these sessions belong to an agent: display name IS the identity, or is exactly
    /// `<identity>-<suffix>` for a known session suffix. Pure — unit-testable.
    public static func matching(_ sessions: [PtySession], identity: String) -> [PtySession] {
        sessions.filter { s in
            guard let dn = s.displayName else { return false }
            return dn == identity || sessionSuffixes.contains { dn == identity + "-" + $0 }
        }
    }

    /// The sessions that belong to an agent, read live from pty's registry.
    public static func sessions(for identity: String, root: String? = nil) -> [PtySession] {
        matching((try? sessions(root: root)) ?? [], identity: identity)
    }

    /// Stop a session by its pty id. Best-effort (a already-exited session is fine).
    @discardableResult
    public static func kill(_ name: String, root: String? = nil) -> Bool {
        (try? Shell.run("pty", ["kill", name], env: env(root: root), check: false))?.ok ?? false
    }
}
