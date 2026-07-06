import XCTest
@testable import ConvoyKit

final class AgentSpecTests: XCTestCase {

    // AC-1: permission mode is DERIVED from role, never hand-set.
    func testPermissionModeDerivedFromRole() {
        XCTAssertEqual(Role.chiefOfStaff.permissionMode, .bypassPermissions)
        XCTAssertEqual(Role.supervisor.permissionMode, .bypassPermissions)
        XCTAssertEqual(Role.technicalManager.permissionMode, .bypassPermissions)
        XCTAssertEqual(Role.worker.permissionMode, .auto)
    }

    func testSpawnerClassification() {
        XCTAssertTrue(Role.chiefOfStaff.isSpawner)
        XCTAssertTrue(Role.supervisor.isSpawner)
        XCTAssertTrue(Role.technicalManager.isSpawner)
        XCTAssertFalse(Role.worker.isSpawner)
    }

    func testOnlyChiefOfStaffIsPermanentByDefault() {
        XCTAssertTrue(Role.chiefOfStaff.permanent)
        XCTAssertFalse(Role.worker.permanent)
        XCTAssertFalse(Role.supervisor.permanent)
    }

    func testRoleAliases() {
        XCTAssertEqual(Role.parse("cos"), .chiefOfStaff)
        XCTAssertEqual(Role.parse("spawner"), .chiefOfStaff)
        XCTAssertEqual(Role.parse("tm"), .technicalManager)
        XCTAssertEqual(Role.parse("wk"), .worker)
        XCTAssertEqual(Role.parse("Supervisor"), .supervisor)
        XCTAssertNil(Role.parse("overlord"))
    }

    func testIdentityValidation() {
        XCTAssertTrue(AgentSpec.isValidIdentity("convoy-claude"))
        XCTAssertTrue(AgentSpec.isValidIdentity("coord-claude.bak"))
        XCTAssertTrue(AgentSpec.isValidIdentity("build-wk-1"))
        XCTAssertFalse(AgentSpec.isValidIdentity(""))
        XCTAssertFalse(AgentSpec.isValidIdentity("-leading-dash"))
        XCTAssertFalse(AgentSpec.isValidIdentity("Has Spaces"))
        XCTAssertFalse(AgentSpec.isValidIdentity("UPPER"))
        XCTAssertFalse(AgentSpec.isValidIdentity("bad/slash"))
    }

    // The derived st launch argv must faithfully carry the correct-by-construction wiring.
    func testStLaunchArgsForCoS() {
        let spec = AgentSpec(role: .chiefOfStaff, identity: "cos", personaOverride: "/tmp/cos.md")
        let args = spec.stLaunchArgs()
        XCTAssertEqual(args.prefix(3).map { $0 }, ["launch", "claude", "--identity"])
        XCTAssertTrue(args.contains("cos"))
        XCTAssertTrue(containsPair(args, "--permission-mode", "bypassPermissions"))
        XCTAssertTrue(args.contains("--permanent"))
        XCTAssertTrue(containsPair(args, "--persona", "/tmp/cos.md"))
        XCTAssertFalse(args.contains("--ding")) // mcp transport by default
    }

    func testStLaunchArgsForDingWorker() {
        let spec = AgentSpec(role: .worker, identity: "build-wk", transport: .ding)
        let args = spec.stLaunchArgs()
        XCTAssertTrue(containsPair(args, "--permission-mode", "auto"))
        XCTAssertTrue(args.contains("--ding"))
        XCTAssertFalse(args.contains("--permanent"))
    }

    func testDryRunFlagAppended() {
        let spec = AgentSpec(role: .worker, identity: "wk")
        XCTAssertTrue(spec.stLaunchArgs(dryRun: true).contains("--dry-run"))
        XCTAssertFalse(spec.stLaunchArgs(dryRun: false).contains("--dry-run"))
    }

    func testNetworkEnvOverlay() {
        let spec = AgentSpec(role: .worker, identity: "wk", networkRoot: "/nets/demo")
        let env = spec.launchEnv()
        XCTAssertEqual(env?["ST_ROOT"], "/nets/demo")
        XCTAssertEqual(env?["PTY_ROOT"], "/nets/demo/pty")
    }

    // Agent JSON binder tolerates both `identity` and the planned `agent` key.
    func testAgentDecodesBothIdentityKeys() throws {
        let a = try JSONDecoder().decode(Agent.self, from: Data(#"{"identity":"x","status":"available"}"#.utf8))
        XCTAssertEqual(a.identity, "x")
        let b = try JSONDecoder().decode(Agent.self, from: Data(#"{"agent":"y","status":"busy"}"#.utf8))
        XCTAssertEqual(b.identity, "y")
    }

    func testAgentDecodesUnknownStatusGracefully() throws {
        let a = try JSONDecoder().decode(Agent.self, from: Data(#"{"identity":"x","status":"quantum"}"#.utf8))
        XCTAssertEqual(a.status, .unknown)
    }

    private func containsPair(_ args: [String], _ flag: String, _ value: String) -> Bool {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return false }
        return args[i + 1] == value
    }
}
