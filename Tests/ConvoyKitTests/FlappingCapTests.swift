import XCTest
@testable import ConvoyKit

/// Ported from pty's `tests/gc-flapping.test.ts` (the 10-case starter kit) + convoy-specific
/// wire-format round-trips. These pin the §5 flapping-cap contract convoy implements verbatim.
final class FlappingCapTests: XCTestCase {

    // A fixed clock so every case is deterministic.
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    let hashA = "aaaaaaaaaaaaaaaa"     // 16 hex
    let hashB = "bbbbbbbbbbbbbbbb"
    let window = 60
    let limit = 3

    func classify(_ tags: StrategyTags, exitedAt: Date?, currentHash: String? = nil, now: Date? = nil) -> FlappingCap.Decision {
        FlappingCap.classify(
            session: "wk1", exitedAt: exitedAt, tags: tags,
            currentHash: currentHash ?? hashA, window: window, limit: limit,
            now: now ?? t0.addingTimeInterval(1000)
        )
    }

    // 1. First respawn: no prior state → respawn, counter 0, stamps hashA + last-respawn-at.
    func testFirstRespawn() {
        let now = t0.addingTimeInterval(500)
        guard case let .respawn(t) = classify(StrategyTags(), exitedAt: nil, now: now) else {
            return XCTFail("expected respawn")
        }
        XCTAssertEqual(t.consecutiveFastFails, 0)
        XCTAssertEqual(t.commandHash, hashA)
        XCTAssertEqual(t.lastRespawnAt, now)
        XCTAssertNil(t.status)
    }

    // 2. Fast fail increments the counter.
    func testFastFailIncrements() {
        let tags = StrategyTags(consecutiveFastFails: 1, lastRespawnAt: t0, commandHash: hashA)
        guard case let .respawn(t) = classify(tags, exitedAt: t0.addingTimeInterval(10)) else {
            return XCTFail("expected respawn")
        }
        XCTAssertEqual(t.consecutiveFastFails, 2)
    }

    // 3. Reaching the limit flips to flapping (no respawn) + emits the event; last-respawn-at preserved.
    func testReachLimitFlaps() {
        let tags = StrategyTags(consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: hashA)
        guard case let .flap(t, ev) = classify(tags, exitedAt: t0.addingTimeInterval(5)) else {
            return XCTFail("expected flap")
        }
        XCTAssertEqual(t.status, "flapping")
        XCTAssertEqual(t.consecutiveFastFails, 3)
        XCTAssertEqual(t.lastRespawnAt, t0, "flap preserves the last attempt's stamp, not now")
        XCTAssertEqual(ev.counter, 3)
        XCTAssertEqual(ev.limit, 3)
        XCTAssertEqual(ev.window, 60)
        XCTAssertEqual(ev.type, "session_flapping")
    }

    // 4. Flapping + unchanged command → skip (parked).
    func testFlappingSkips() {
        let tags = StrategyTags(consecutiveFastFails: 3, lastRespawnAt: t0, commandHash: hashA, status: "flapping")
        XCTAssertEqual(classify(tags, exitedAt: t0.addingTimeInterval(5)), .skip)
    }

    // 5. Flapping + command changed → reset + respawn (counter 0, status cleared).
    func testCommandChangeRevivesFlapping() {
        let tags = StrategyTags(consecutiveFastFails: 9, lastRespawnAt: t0, commandHash: hashA, status: "flapping")
        guard case let .respawn(t) = classify(tags, exitedAt: t0.addingTimeInterval(5), currentHash: hashB) else {
            return XCTFail("expected respawn after command change")
        }
        XCTAssertEqual(t.consecutiveFastFails, 0)
        XCTAssertNil(t.status)
        XCTAssertEqual(t.commandHash, hashB)
    }

    // 6. Slow fail resets the counter to 0 (lived past the window).
    func testSlowFailResets() {
        let tags = StrategyTags(consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: hashA)
        guard case let .respawn(t) = classify(tags, exitedAt: t0.addingTimeInterval(120)) else {
            return XCTFail("expected respawn")
        }
        XCTAssertEqual(t.consecutiveFastFails, 0)
    }

    // 7. §5.6.1 — a manual kill of a long-lived agent is a SLOW fail (not a flap footgun).
    func testManualKillOfLongLivedIsNotAFlap() {
        let tags = StrategyTags(consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: hashA)
        guard case let .respawn(t) = classify(tags, exitedAt: t0.addingTimeInterval(3600)) else {
            return XCTFail("expected respawn (slow fail)")
        }
        XCTAssertEqual(t.consecutiveFastFails, 0)
    }

    // 8. Window boundary: lived == window is a SLOW fail (< window is fast).
    func testWindowBoundaryIsSlow() {
        let tags = StrategyTags(consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: hashA)
        guard case let .respawn(t) = classify(tags, exitedAt: t0.addingTimeInterval(60)) else {
            return XCTFail("expected respawn")
        }
        XCTAssertEqual(t.consecutiveFastFails, 0)
    }

    // 9. Unknown exit time → not a fast fail (conservative reset).
    func testUnknownExitIsNotFast() {
        let tags = StrategyTags(consecutiveFastFails: 2, lastRespawnAt: t0, commandHash: hashA)
        guard case let .respawn(t) = classify(tags, exitedAt: nil) else {
            return XCTFail("expected respawn")
        }
        XCTAssertEqual(t.consecutiveFastFails, 0)
    }

    // 10. Effective-threshold precedence: per-session tag > CLI global > default.
    func testThresholdPrecedence() {
        XCTAssertEqual(FlappingCap.effectiveWindow(tag: 10, cliGlobal: 30), 10)
        XCTAssertEqual(FlappingCap.effectiveWindow(tag: nil, cliGlobal: 30), 30)
        XCTAssertEqual(FlappingCap.effectiveWindow(tag: nil, cliGlobal: nil), 60)
        XCTAssertEqual(FlappingCap.effectiveLimit(tag: 5, cliGlobal: 2), 5)
        XCTAssertEqual(FlappingCap.effectiveLimit(tag: nil, cliGlobal: 2), 2)
        XCTAssertEqual(FlappingCap.effectiveLimit(tag: nil, cliGlobal: nil), 3)
    }

    // 11. Command fingerprint: 16 lowercase hex, deterministic, sensitive to args.
    func testCommandFingerprint() {
        let a = FlappingCap.commandFingerprint(command: "claude", args: ["--resume", "x"])
        let b = FlappingCap.commandFingerprint(command: "claude", args: ["--resume", "x"])
        let c = FlappingCap.commandFingerprint(command: "claude", args: ["--resume", "y"])
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
        XCTAssertEqual(a.count, 16)
        XCTAssertTrue(a.allSatisfy { "0123456789abcdef".contains($0) })
    }

    // 12. Wire-format round-trip (spec §8.1): parse ⇄ writtenTags, ISO shape, string int.
    func testWireFormatRoundTrip() {
        let now = Date(timeIntervalSince1970: 1_783_446_612.345) // .345 → ms fraction
        let tags = StrategyTags(consecutiveFastFails: 2, lastRespawnAt: now, commandHash: hashA, status: "flapping")
        let written = tags.writtenTags()
        XCTAssertEqual(written[StrategyTags.kConsecutive], "2")
        XCTAssertEqual(written[StrategyTags.kCommandHash], hashA)
        XCTAssertEqual(written[StrategyTags.kStatus], "flapping")
        let iso = written[StrategyTags.kLastRespawn]
        XCTAssertNotNil(iso)
        XCTAssertTrue(iso!.hasSuffix("Z"))
        XCTAssertTrue(iso!.contains("."), "ISO must carry the millisecond fraction")

        let reparsed = StrategyTags.parse(from: written)
        XCTAssertEqual(reparsed.consecutiveFastFails, 2)
        XCTAssertEqual(reparsed.commandHash, hashA)
        XCTAssertEqual(reparsed.status, "flapping")
        XCTAssertEqual(reparsed.lastRespawnAt?.timeIntervalSince1970 ?? 0, now.timeIntervalSince1970, accuracy: 0.001)
    }

    // 13. Absent tags parse to sane defaults (counter 0, no status).
    func testEmptyTagsParse() {
        let t = StrategyTags.parse(from: [:])
        XCTAssertEqual(t.consecutiveFastFails, 0)
        XCTAssertNil(t.status)
        XCTAssertNil(t.commandHash)
        XCTAssertNil(t.lastRespawnAt)
        XCTAssertFalse(t.isFlapping)
    }
}
