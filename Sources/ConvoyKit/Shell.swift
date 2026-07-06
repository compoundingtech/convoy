import Foundation

/// A thin wrapper around `Process` for shelling out to the tools convoy orchestrates
/// (`st`, `pty`, `brew`, `codesign`, …). convoy is an orchestrator: it does not reimplement
/// these tools, it drives them — so every external call funnels through here.
public struct Shell {

    /// The result of running a command.
    public struct Result: Sendable {
        public let status: Int32
        public let stdout: String
        public let stderr: String

        public var ok: Bool { status == 0 }

        /// stdout with trailing newline trimmed — the common case for a single value.
        public var out: String {
            stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    /// Error thrown by `run(...)` when `check: true` and the command exits non-zero.
    public struct CommandError: Error, CustomStringConvertible {
        public let command: String
        public let status: Int32
        public let stderr: String

        public var description: String {
            let trimmed = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            let detail = trimmed.isEmpty ? "" : ": \(trimmed)"
            return "`\(command)` exited \(status)\(detail)"
        }
    }

    public init() {}

    /// An enriched PATH resolved once from the user's login shell, unioned with common tool
    /// locations and the current PATH. A GUI-launched `.app` inherits only a minimal PATH
    /// (`/usr/bin:/bin:…`), so `st`/`pty` (installed under nvm etc.) wouldn't resolve — this makes
    /// shelling out work identically from the terminal CLI and the menubar app.
    public static let enrichedPath: String = {
        var dirs: [String] = []
        // The login shell's PATH is the source of truth for where the user's tools live.
        if let login = try? capture("/bin/zsh", ["-lc", "printf %s \"$PATH\""]), login.ok {
            dirs += login.stdout.split(separator: ":").map(String.init)
        }
        if let current = ProcessInfo.processInfo.environment["PATH"] {
            dirs += current.split(separator: ":").map(String.init)
        }
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        dirs += [
            "/opt/homebrew/bin", "/usr/local/bin",
            home + "/.local/bin", home + "/bin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ]
        // De-dupe, preserving first-seen order.
        var seen = Set<String>()
        return dirs.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }()

    /// Build the child environment: the caller's overlay (or the inherited env) with PATH forced
    /// to the enriched value so tool resolution is deterministic regardless of launch context.
    static func childEnv(_ overlay: [String: String]?) -> [String: String] {
        var env = overlay ?? ProcessInfo.processInfo.environment
        env["PATH"] = enrichedPath
        return env
    }

    /// Whether an executable is resolvable on the current PATH.
    public static func which(_ tool: String) -> String? {
        let result = try? Shell.capture("/usr/bin/env", ["which", tool], env: childEnv(nil))
        guard let result, result.ok, !result.out.isEmpty else { return nil }
        return result.out
    }

    /// Run a command, capturing stdout/stderr. Never throws on non-zero exit — inspect `.status`.
    /// Pass `stdin` to feed the process input (used for `st message send` bodies, etc.).
    @discardableResult
    public static func capture(
        _ launchPath: String,
        _ arguments: [String],
        cwd: URL? = nil,
        env: [String: String]? = nil,
        stdin: String? = nil
    ) throws -> Result {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        if let cwd { process.currentDirectoryURL = cwd }
        if let env { process.environment = env }

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        let inPipe: Pipe?
        if let stdin {
            let pipe = Pipe()
            process.standardInput = pipe
            inPipe = pipe
            // Write stdin fully before launch-drain to avoid deadlock on large bodies:
            // schedule the write after run() below.
            _ = stdin
        } else {
            inPipe = nil
        }

        try process.run()

        if let stdin, let inPipe {
            let handle = inPipe.fileHandleForWriting
            handle.write(Data(stdin.utf8))
            try? handle.close()
        }

        // Read to end before waitUntilExit to avoid pipe-buffer deadlock on large output.
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        return Result(
            status: process.terminationStatus,
            stdout: String(decoding: outData, as: UTF8.self),
            stderr: String(decoding: errData, as: UTF8.self)
        )
    }

    /// Run a tool found on PATH via `/usr/bin/env`, throwing `CommandError` on non-zero exit when
    /// `check` is true. This is the ergonomic path for "run `st agents --json` and give me stdout".
    @discardableResult
    public static func run(
        _ tool: String,
        _ arguments: [String],
        cwd: URL? = nil,
        env: [String: String]? = nil,
        stdin: String? = nil,
        check: Bool = true
    ) throws -> Result {
        let result = try capture("/usr/bin/env", [tool] + arguments, cwd: cwd, env: childEnv(env), stdin: stdin)
        if check && !result.ok {
            throw CommandError(
                command: ([tool] + arguments).joined(separator: " "),
                status: result.status,
                stderr: result.stderr
            )
        }
        return result
    }
}
