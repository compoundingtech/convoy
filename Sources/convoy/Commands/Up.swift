import ArgumentParser
import ConvoyKit
import Foundation

// Signal flag for graceful teardown. A file-scope C-compatible handler that only sets a flag is
// async-signal-safe; `nonisolated(unsafe)` is the accepted escape for a supervisor's stop flag.
nonisolated(unsafe) private var convoyUpStopRequested: sig_atomic_t = 0
private func convoyUpHandleSignal(_ sig: Int32) { convoyUpStopRequested = 1 }

/// `convoy up <network>` — the foreground host. It brings the network's permanent sessions up as
/// its own children (so it's the TCC anchor — the kitty-hosting mechanism) and runs the reconcile
/// loop that owns respawn + the crash-loop flapping-cap (pty's daemon is gone; the host supervises).
///
/// This is the reboot's load-bearing verb. Run it in a granted terminal (kitty) and the whole
/// hosted network inherits that terminal's TCC grants. Ctrl-C tears the network down cleanly.
struct Up: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Host a network in the foreground (TCC anchor + supervisor + respawn + flapping-cap).",
        discussion: """
        Run this in a TCC-granted terminal (kitty) — the hosted agents inherit its grants because
        `convoy up` is the process that spawns them. It reconciles every --reconcile-interval
        seconds: any permanent session that has gone is respawned (resuming its session), unless it
        is crash-looping, in which case the flapping-cap parks it.

        Examples:
          convoy up ~/.local/state/convoy
          convoy up ~/.local/state/convoy --json               # machine-readable event stream
          convoy up ~/.local/state/convoy --once               # a single reconcile tick, then exit
        """
    )

    @Argument(help: "Network root (ST_ROOT) to host. Defaults to st's default network.", completion: .directory)
    var network: String?

    @Option(name: .long, help: "Fast-fail window in seconds (default 60). Per-session tag overrides this.")
    var fastFailWindow: Int?

    @Option(name: .long, help: "Consecutive fast-fails before a session is parked as flapping (default 3).")
    var fastFailLimit: Int?

    @Option(name: .long, help: "Reconcile cadence in seconds (default 30).")
    var reconcileInterval: Int = 30

    @Flag(name: .long, help: "Emit a JSONL event stream on stdout (spawn/respawn/flapping/teardown).")
    var json = false

    @Flag(name: .long, help: "Run a single reconcile tick and exit (for tests / one-shot reconcile).")
    var once = false

    @Flag(name: .long, help: "On exit, leave the hosted sessions running instead of stopping them.")
    var keepSessions = false

    func run() throws {
        let root = network ?? Up.defaultRoot()
        let host = PtyHost(root: network)
        let pidPath = root + "/convoy.pid"

        try acquirePidLock(pidPath, root: root)
        defer { releasePidLock(pidPath) }

        signal(SIGINT, convoyUpHandleSignal)
        signal(SIGTERM, convoyUpHandleSignal)

        emit(["type": "up", "network": root, "reconcileInterval": reconcileInterval], human: "hosting \(root) (reconcile every \(reconcileInterval)s, cap \(FlappingCap.effectiveLimit(tag: nil, cliGlobal: fastFailLimit)) fails / \(FlappingCap.effectiveWindow(tag: nil, cliGlobal: fastFailWindow))s)")

        // Classifier state keyed by the STABLE logical identity (ptyfile::session), not the pty id
        // (which can churn across respawns). This is convoy's source of truth for the counter, so
        // the flapping-cap holds regardless of whether pty preserves runtime tags across a respawn.
        var state: [String: StrategyTags] = [:]
        var supervised = Set<String>()
        repeat {
            reconcileTick(host: host, state: &state, supervised: &supervised)
            if once { break }
            sleepInterruptibly(seconds: reconcileInterval)
        } while convoyUpStopRequested == 0

        teardown(host: host, supervised: supervised)
    }

    // MARK: Reconcile

    private func reconcileTick(host: PtyHost, state: inout [String: StrategyTags], supervised: inout Set<String>) {
        let now = Date()
        for s in host.permanentSessions() {
            supervised.insert(s.name)
            guard s.isGone else { continue }

            let key = s.logicalKey
            // Prior state from convoy's store; seed from the session's on-disk tags on first sight.
            let prior = state[key] ?? StrategyTags.parse(from: s.tags)
            let window = FlappingCap.effectiveWindow(tag: prior.fastFailWindowOverride, cliGlobal: fastFailWindow)
            let limit = FlappingCap.effectiveLimit(tag: prior.fastFailLimitOverride, cliGlobal: fastFailLimit)
            let decision = FlappingCap.classify(
                session: s.name, exitedAt: s.exitedAt, tags: prior,
                currentHash: s.commandHash, window: window, limit: limit, now: now
            )

            switch decision {
            case .skip:
                break // already parked as flapping; stay silent (the flap event fired on transition)

            case let .respawn(newTags):
                // Spec §5.3 order: persist bookkeeping, THEN spawn. convoy's own store is the durable
                // counter; the pty tags are written best-effort for pty's display/on-disk contract.
                state[key] = newTags
                host.setTags(s.name, newTags.writtenTags())
                host.removeTag(s.name, StrategyTags.kStatus) // respawn never flaps; clear any stale flag
                let ok = host.respawn(s.name)
                emit([
                    "type": "respawn", "identity": s.label, "session": s.name,
                    "reason": "exited", "attempt": newTags.consecutiveFastFails, "cap": limit,
                    "ok": ok, "ts": StrategyTags.isoString(now),
                ], human: "[convoy-up] respawn \(s.label) session=\(s.name) reason=exited attempt=\(newTags.consecutiveFastFails)/\(limit)\(ok ? "" : " (spawn FAILED)")")

            case let .flap(newTags, event):
                state[key] = newTags
                host.setTags(s.name, newTags.writtenTags()) // strategy.status=flapping for pty's display
                emit(event.jsonObject(),
                     human: "[convoy-up] flapping \(s.label) session=\(s.name) — parked after \(event.counter) fast fails (cap \(event.limit)/\(event.window)s). `pty tag \(s.name) --rm strategy.status` to retry.")
            }
        }
    }

    private func teardown(host: PtyHost, supervised: Set<String>) {
        if keepSessions {
            emit(["type": "teardown", "stopped": 0, "kept": supervised.count],
                 human: "[convoy-up] stopping host; leaving \(supervised.count) session(s) running (--keep-sessions).")
            return
        }
        var stopped = 0
        for name in supervised where host.kill(name) { stopped += 1 }
        emit(["type": "teardown", "stopped": stopped],
             human: "[convoy-up] stopped host; tore down \(stopped) session(s).")
    }

    // MARK: pid lock (one convoy per network — <root>/convoy.pid)

    private func acquirePidLock(_ path: String, root: String) throws {
        if let raw = try? String(contentsOfFile: path, encoding: .utf8),
           let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
            if pid != getpid() && kill(pid, 0) == 0 {
                throw ConvoyError("a convoy is already hosting \(root) (pid \(pid) — \(path)). Stop it first, or remove the stale pid file.")
            }
        }
        // Ensure the root exists before writing the lock.
        try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        try String(getpid()).write(toFile: path, atomically: true, encoding: .utf8)
    }

    private func releasePidLock(_ path: String) {
        // Only remove the lock if it's still ours.
        if let raw = try? String(contentsOfFile: path, encoding: .utf8),
           Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)) == getpid() {
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    // MARK: helpers

    /// Sleep up to `seconds`, waking early if a stop signal arrives (checked every 250ms).
    private func sleepInterruptibly(seconds: Int) {
        var remaining = max(0, seconds) * 4
        while remaining > 0 && convoyUpStopRequested == 0 {
            usleep(250_000)
            remaining -= 1
        }
    }

    /// Emit an event: the human line always goes to stderr (operator visibility). stdout carries the
    /// JSONL stream when --json, else the human line (so a plain run still shows progress on stdout).
    private func emit(_ object: [String: Any], human: String) {
        FileHandle.standardError.write(Data((human + "\n").utf8))
        if json {
            if let data = try? JSONSerialization.data(withJSONObject: object),
               let line = String(data: data, encoding: .utf8) {
                print(line)
            }
        } else {
            print(human)
        }
    }

    static func defaultRoot() -> String {
        if let r = ProcessInfo.processInfo.environment["ST_ROOT"], !r.isEmpty { return r }
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        return home + "/.local/state/smalltalk"
    }
}
