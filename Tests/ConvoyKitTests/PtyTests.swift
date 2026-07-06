import XCTest
@testable import ConvoyKit
import Foundation

final class PtyTests: XCTestCase {

    private func decode(_ json: String) throws -> [PtySession] {
        try JSONDecoder().decode([PtySession].self, from: Data(json.utf8))
    }

    func testDecodesRegistryTolerantly() throws {
        // Sessions may omit displayName (e.g. a bare command session).
        let sessions = try decode("""
        [{"name":"abc","displayName":"build-wk-claude","cwd":"/w","status":"running","command":"claude"},
         {"name":"def","status":"running"}]
        """)
        XCTAssertEqual(sessions.count, 2)
        XCTAssertEqual(sessions[0].displayName, "build-wk-claude")
        XCTAssertNil(sessions[1].displayName)
    }

    func testMatchingByIdentity() throws {
        let sessions = try decode("""
        [{"name":"1","displayName":"build-wk-claude"},
         {"name":"2","displayName":"build-wk-ding"},
         {"name":"3","displayName":"build-wk"},
         {"name":"4","displayName":"build-wk-2-claude"},
         {"name":"5","displayName":"cos-claude"},
         {"name":"6"}]
        """)
        let mine = Pty.matching(sessions, identity: "build-wk").map { $0.name }
        // Exact identity + `<id>-…` sidecars, but NOT a different agent that merely shares a prefix.
        XCTAssertEqual(Set(mine), ["1", "2", "3"])
        XCTAssertFalse(mine.contains("4")) // build-wk-2 is a different agent
        XCTAssertFalse(mine.contains("5"))
        XCTAssertFalse(mine.contains("6")) // no displayName → not matched
    }

    func testNoMatchIsEmpty() throws {
        let sessions = try decode(#"[{"name":"1","displayName":"cos-claude"}]"#)
        XCTAssertTrue(Pty.matching(sessions, identity: "build-wk").isEmpty)
    }
}
