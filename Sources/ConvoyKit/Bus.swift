import Foundation

/// A member of a smalltalk network, as reported by `st agents --json [--enrich]`.
///
/// The JSON binder is deliberately tolerant of the `identity` → `agent` key rename that
/// smalltalk has flagged as upcoming (additive-then-deprecate): we accept either key so the
/// dashboard keeps working across that transition without a coordinated release.
public struct Agent: Sendable, Identifiable, Codable {
    public let identity: String
    public let status: AgentState
    public let name: String?
    public let lastActivity: Double? // ms epoch, fractional; present only with --enrich
    public let inbox: Int?           // present only with --enrich

    public var id: String { identity }

    /// Best display label: explicit name if set, else the identity.
    public var label: String { name ?? identity }

    private enum CodingKeys: String, CodingKey {
        case identity, agent, status, name, lastActivity, inbox
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Tolerate both `identity` (current) and `agent` (planned rename).
        if let id = try c.decodeIfPresent(String.self, forKey: .identity) {
            identity = id
        } else if let id = try c.decodeIfPresent(String.self, forKey: .agent) {
            identity = id
        } else {
            throw DecodingError.keyNotFound(
                CodingKeys.identity,
                .init(codingPath: c.codingPath, debugDescription: "neither `identity` nor `agent` present")
            )
        }
        status = try c.decodeIfPresent(AgentState.self, forKey: .status) ?? .unknown
        name = try c.decodeIfPresent(String.self, forKey: .name)
        lastActivity = try c.decodeIfPresent(Double.self, forKey: .lastActivity)
        inbox = try c.decodeIfPresent(Int.self, forKey: .inbox)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(identity, forKey: .identity)
        try c.encode(status, forKey: .status)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(lastActivity, forKey: .lastActivity)
        try c.encodeIfPresent(inbox, forKey: .inbox)
    }

    public init(identity: String, status: AgentState, name: String? = nil,
                lastActivity: Double? = nil, inbox: Int? = nil) {
        self.identity = identity
        self.status = status
        self.name = name
        self.lastActivity = lastActivity
        self.inbox = inbox
    }
}

/// The lifecycle/presence state of an agent. Unknown values decode to `.unknown` rather than
/// throwing — a new state added upstream must never break the dashboard.
public enum AgentState: String, Sendable, Codable, CaseIterable {
    case offline, available, busy, away, dnd, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentState(rawValue: raw) ?? .unknown
    }

    /// Whether this agent counts as "live" (reachable now) for at-a-glance rollups.
    public var isLive: Bool {
        switch self {
        case .available, .busy, .away, .dnd: return true
        case .offline, .unknown: return false
        }
    }
}

/// Read/orchestrate a smalltalk network via the `st` CLI. convoy never touches the bus's
/// on-disk layout directly — `st` is the single source of truth for the message bus.
public struct Bus: Sendable {
    /// The network root (ST_ROOT). `nil` uses st's default network.
    public let root: String?

    public init(root: String? = nil) {
        self.root = root
    }

    /// Environment overlay that pins this network for a shelled `st`/`pty` call.
    /// Mirrors smalltalk's membership convention: ST_ROOT + nested PTY_ROOT.
    public var envOverlay: [String: String] {
        guard let root else { return [:] }
        return [
            "ST_ROOT": root,
            "PTY_ROOT": root + "/pty",
        ]
    }

    private func mergedEnv() -> [String: String]? {
        guard root != nil else { return nil }
        var env = ProcessInfo.processInfo.environment
        for (k, v) in envOverlay { env[k] = v }
        return env
    }

    /// The members of the network. `enrich` adds lastActivity + inbox counts.
    public func agents(enrich: Bool = false) throws -> [Agent] {
        var args = ["agents", "--json"]
        if enrich { args.append("--enrich") }
        let result = try Shell.run("st", args, env: mergedEnv())
        let data = Data(result.stdout.utf8)
        return try JSONDecoder().decode([Agent].self, from: data)
    }

    /// Set an identity's presence state (used by boot rituals and `convoy` itself).
    public func setStatus(_ identity: String, _ state: String) throws {
        try Shell.run("st", ["status", identity, "--set", state], env: mergedEnv())
    }

    /// Round-trip probe used by `convoy doctor`: can we enumerate the bus at all?
    public func roundTrips() -> Bool {
        (try? agents()) != nil
    }
}
