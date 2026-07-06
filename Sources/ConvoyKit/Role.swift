import Foundation

/// The transport an agent uses to reach the bus.
public enum Transport: String, Sendable, CaseIterable {
    /// MCP mode (default for claude): `.mcp.json` → `st mcp`, channel push over the transport.
    case mcp
    /// Ding mode: no MCP; an `st ding` sidecar delivers inbox; agent uses the `st` CLI.
    case ding
}

/// The claude `--permission-mode` posture. convoy DERIVES this from role — it is NEVER
/// hand-chosen (AC-1). Values pass through to claude verbatim.
public enum PermissionMode: String, Sendable {
    case bypassPermissions
    case auto
    case acceptEdits
    case plan
    case `default`
}

/// A role is high-level intent. It maps, correct-by-construction, to the persona base, the
/// permission-mode posture, and whether the agent is always-on (`--permanent`). This table is
/// the single source of truth for that derivation — the heart of AC-1. Changing how an agent is
/// wired means changing this table, not hand-editing a `pty.toml`.
///
/// Backed by smalltalk's four public persona bases: chief-of-staff, supervisor, worker,
/// technical-manager. (base+overlay *compose* is a documented follow-on; today = single base.)
public enum Role: String, Sendable, CaseIterable {
    case chiefOfStaff = "chief-of-staff"
    case supervisor
    case worker
    case technicalManager = "technical-manager"

    /// Friendly aliases so `convoy add cos …` / `convoy add tm …` just work.
    public static func parse(_ raw: String) -> Role? {
        switch raw.lowercased() {
        case "chief-of-staff", "chiefofstaff", "cos", "spawner": return .chiefOfStaff
        case "supervisor", "sup": return .supervisor
        case "worker", "wk": return .worker
        case "technical-manager", "technicalmanager", "tm", "manager": return .technicalManager
        default: return Role(rawValue: raw.lowercased())
        }
    }

    /// Whether this role spawns/manages other agents. Spawners run with elevated permissions so
    /// they can drive tools unattended; workers run with the safer `auto` posture.
    public var isSpawner: Bool {
        switch self {
        case .chiefOfStaff, .supervisor, .technicalManager: return true
        case .worker: return false
        }
    }

    /// DERIVED — never hand-set. Spawner-class roles run `bypassPermissions` (they spawn/manage
    /// other agents and must act unattended); workers run the safer `auto` posture. The three
    /// spawner-class roles share the spawner posture by design.
    public var permissionMode: PermissionMode {
        isSpawner ? .bypassPermissions : .auto
    }

    /// DERIVED — a production spawner (esp. the CoS) is always-on, so it gets `--permanent` so
    /// pty resurrects it. Workers are ephemeral by default.
    public var permanent: Bool {
        self == .chiefOfStaff
    }

    /// The persona base filename this role installs (single-file install today).
    public var personaBaseFilename: String { rawValue + ".md" }

    /// Human-facing one-liner for `convoy add --help` / dry-run output.
    public var summary: String {
        "\(rawValue) — permission-mode=\(permissionMode.rawValue)"
            + (permanent ? ", permanent" : "")
            + (isSpawner ? " (spawner)" : " (worker)")
    }
}
