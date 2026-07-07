import Foundation
import CryptoKit

/// The flapping-cap classifier — convoy's respawn supervisor, implementing pty's lean-core
/// supervision spec §5 **verbatim**. When pty's background daemon/supervisor is removed, the
/// foreground host (`convoy up`) owns respawn + the crash-loop cap; this is that logic.
///
/// The classifier is a **pure function** over the session's `strategy.*` tag state — no I/O, no
/// clock, no pty. That makes the contract independent of how convoy talks to pty (CLI vs client)
/// and lets us test every branch. `convoy up`'s reconcile loop reads tags, calls `classify`, and
/// persists the decision's new tags + acts (respawn / flap / skip).
///
/// Wire-formats are FROZEN (spec §8.1): convoy's writer must match pty's reader byte-for-byte.
public enum FlappingCap {

    // MARK: Frozen defaults (spec §5.1 / §5.6)

    public static let defaultWindowSeconds = 60
    public static let defaultLimit = 3

    // MARK: Command fingerprint (spec §5.1 / §8.1)

    /// `strategy.command-hash` — the 16-char lowercase-hex SHA-256 prefix of
    /// `<command>\0<args joined by \0>`. Divergence at classifier time (operator edited the stored
    /// command) resets the counter and clears the flapping flag. Reproduces pty's helper verbatim:
    /// `sha256(command + "\0" + args.join("\0")).digest("hex").slice(0, 16)`.
    public static func commandFingerprint(command: String, args: [String]) -> String {
        let joined = command + "\0" + args.joined(separator: "\0")
        let digest = SHA256.hash(data: Data(joined.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(16))
    }

    // MARK: Effective thresholds (spec §5.2 — per-session tag > CLI global > default)

    public static func effectiveWindow(tag: Int?, cliGlobal: Int?) -> Int {
        tag ?? cliGlobal ?? defaultWindowSeconds
    }

    public static func effectiveLimit(tag: Int?, cliGlobal: Int?) -> Int {
        tag ?? cliGlobal ?? defaultLimit
    }

    // MARK: The classifier (spec §5.3)

    /// The decision for one permanent-and-gone session on one reconcile tick.
    public enum Decision: Sendable, Equatable {
        /// Session is flapping and its command is unchanged — do nothing (no respawn, no mutation).
        case skip
        /// Respawn now; persist `tags` first (they carry the new stamp/counter/hash).
        case respawn(StrategyTags)
        /// Crash-loop cap hit — flip to flapping, persist `tags`, emit `event`, do NOT respawn.
        case flap(StrategyTags, FlappingEvent)
    }

    /// Classify one permanent-and-gone session. Pure: same inputs → same decision.
    ///
    /// - Parameters:
    ///   - session: the session id (for the emitted event).
    ///   - exitedAt: when the gone leaf exited (`metadata.exitedAt`). `nil` ⇒ unknown ⇒ not a fast fail.
    ///   - tags: the session's current `strategy.*` tag state.
    ///   - currentHash: fingerprint of the *declared* command (what a respawn would run).
    ///   - window: effective fast-fail window in seconds (see `effectiveWindow`).
    ///   - limit: effective fast-fail limit (see `effectiveLimit`).
    ///   - now: the tick's timestamp (stamped into `last-respawn-at` / the event).
    public static func classify(
        session: String,
        exitedAt: Date?,
        tags: StrategyTags,
        currentHash: String,
        window: Int,
        limit: Int,
        now: Date
    ) -> Decision {
        // A stored hash that differs from the current one ⇒ the operator edited the command.
        // (No stored hash ⇒ first respawn ⇒ not a "change".)
        let commandChanged = tags.commandHash != nil && tags.commandHash != currentHash

        // Flapping + unchanged command ⇒ stay parked (only a manual `pty tag --rm strategy.status`
        // or a command edit revives it).
        if tags.isFlapping && !commandChanged {
            return .skip
        }

        // Was the just-exited leaf a fast fail? (lived < window since the last respawn stamp).
        // Unknown exit time or no prior stamp ⇒ not fast (conservative: won't wrongly flap).
        let wasFastFail: Bool = {
            guard let exitedAt, let last = tags.lastRespawnAt else { return false }
            let liveMs = exitedAt.timeIntervalSince(last) * 1000.0
            return liveMs >= 0 && liveMs < Double(window) * 1000.0
        }()

        let nextCounter = commandChanged ? 0 : (wasFastFail ? tags.consecutiveFastFails + 1 : 0)

        if nextCounter >= limit {
            var flapped = tags
            flapped.status = StrategyTags.flappingStatus
            flapped.consecutiveFastFails = nextCounter
            flapped.commandHash = currentHash
            // preserve last-respawn-at as-is: it dates the last *attempt*, not this (skipped) one.
            let event = FlappingEvent(session: session, ts: now, counter: nextCounter, limit: limit, window: window)
            return .flap(flapped, event)
        }

        var respawned = tags
        respawned.lastRespawnAt = now
        respawned.consecutiveFastFails = nextCounter
        respawned.commandHash = currentHash
        respawned.status = nil // this branch never flaps
        return .respawn(respawned)
    }
}

/// The `strategy.*` tag state that is the on-disk supervision contract between pty (reader) and
/// convoy (writer). Parse/serialize match the FROZEN wire-format (spec §8.1) exactly.
public struct StrategyTags: Sendable, Equatable {
    public static let flappingStatus = "flapping"

    // Tag keys (spec §8.1).
    public static let kConsecutive = "strategy.consecutive-fast-fails"
    public static let kLastRespawn = "strategy.last-respawn-at"
    public static let kCommandHash = "strategy.command-hash"
    public static let kStatus = "strategy.status"
    public static let kWindow = "strategy.fast-fail-window"
    public static let kLimit = "strategy.fast-fail-limit"

    /// `strategy.consecutive-fast-fails` — absent tag ⇒ 0.
    public var consecutiveFastFails: Int
    /// `strategy.last-respawn-at` — ISO 8601 UTC.
    public var lastRespawnAt: Date?
    /// `strategy.command-hash` — 16 lowercase hex.
    public var commandHash: String?
    /// `strategy.status` — `"flapping"` or nil.
    public var status: String?
    /// `strategy.fast-fail-window` per-session override, seconds.
    public var fastFailWindowOverride: Int?
    /// `strategy.fast-fail-limit` per-session override, count.
    public var fastFailLimitOverride: Int?

    public init(
        consecutiveFastFails: Int = 0,
        lastRespawnAt: Date? = nil,
        commandHash: String? = nil,
        status: String? = nil,
        fastFailWindowOverride: Int? = nil,
        fastFailLimitOverride: Int? = nil
    ) {
        self.consecutiveFastFails = consecutiveFastFails
        self.lastRespawnAt = lastRespawnAt
        self.commandHash = commandHash
        self.status = status
        self.fastFailWindowOverride = fastFailWindowOverride
        self.fastFailLimitOverride = fastFailLimitOverride
    }

    public var isFlapping: Bool { status == StrategyTags.flappingStatus }

    // MARK: Frozen wire-format (spec §8.1)

    /// ISO 8601 UTC with millisecond fraction + `Z` — the `new Date(ms).toISOString()` shape.
    /// A fresh formatter per call keeps this Sendable-clean (ISO8601DateFormatter isn't Sendable);
    /// creation is negligible at the reconcile cadence.
    private static func isoFormatter() -> ISO8601DateFormatter {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }

    /// Serialize a date to the frozen ISO 8601 UTC (ms + `Z`) shape.
    public static func isoString(_ date: Date) -> String { isoFormatter().string(from: date) }

    /// Parse the frozen ISO 8601 UTC shape back to a date (nil if malformed).
    public static func isoDate(_ s: String) -> Date? { isoFormatter().date(from: s) }

    /// Parse the `strategy.*` subset out of a session's full tag map. Tolerant: unknown/missing
    /// keys use defaults; a malformed int/date is treated as absent (never throws).
    public static func parse(from tags: [String: String]) -> StrategyTags {
        StrategyTags(
            consecutiveFastFails: tags[kConsecutive].flatMap { Int($0) } ?? 0,
            lastRespawnAt: tags[kLastRespawn].flatMap { isoDate($0) },
            commandHash: tags[kCommandHash],
            status: tags[kStatus],
            fastFailWindowOverride: tags[kWindow].flatMap { Int($0) },
            fastFailLimitOverride: tags[kLimit].flatMap { Int($0) }
        )
    }

    /// The `strategy.*` tags to WRITE for this state (only the classifier-owned keys — the
    /// per-session overrides are operator-authored and left untouched). Used to compute the
    /// `pty tag` set/rm calls after a decision.
    public func writtenTags() -> [String: String] {
        var out: [String: String] = [
            StrategyTags.kConsecutive: String(consecutiveFastFails),
            StrategyTags.kCommandHash: commandHash ?? "",
        ]
        if let lastRespawnAt {
            out[StrategyTags.kLastRespawn] = StrategyTags.isoString(lastRespawnAt)
        }
        if let status {
            out[StrategyTags.kStatus] = status
        }
        return out.filter { !$0.value.isEmpty }
    }
}

/// The `session_flapping` event payload (spec §5.4 / §8.1). `convoy up` emits this to its own
/// event stream (stdout `--json`); the load-bearing on-disk signal pty reads is the
/// `strategy.status=flapping` tag.
public struct FlappingEvent: Sendable, Equatable, Codable {
    public let session: String
    public let type: String
    public let ts: Date
    public let counter: Int
    public let limit: Int
    public let window: Int

    public init(session: String, ts: Date, counter: Int, limit: Int, window: Int) {
        self.session = session
        self.type = "session_flapping"
        self.ts = ts
        self.counter = counter
        self.limit = limit
        self.window = window
    }

    /// The frozen JSON shape (spec §8.1) with the ISO `ts`.
    public func jsonObject() -> [String: Any] {
        [
            "session": session,
            "type": type,
            "ts": StrategyTags.isoString(ts),
            "counter": counter,
            "limit": limit,
            "window": window,
        ]
    }
}
