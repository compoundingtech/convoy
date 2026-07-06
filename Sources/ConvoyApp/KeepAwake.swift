import Foundation
import IOKit.pwr_mgt

/// Holds an IOKit power assertion so the Mac won't idle-sleep and pause/kill the network — the
/// `caffeinate` job, but owned by the app (IDEA.md Part 2, need #2). Toggle from the menubar.
final class KeepAwake: ObservableObject {
    @Published private(set) var enabled = false
    private var assertionID: IOPMAssertionID = 0

    /// Prevent idle system sleep while keep-awake is on. Display may still sleep.
    func enable() {
        guard !enabled else { return }
        let reason = "Convoy is keeping the agent network alive" as CFString
        let result = IOPMAssertionCreateWithName(
            kIOPMAssertPreventUserIdleSystemSleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            reason,
            &assertionID
        )
        if result == kIOReturnSuccess { enabled = true }
    }

    func disable() {
        guard enabled else { return }
        IOPMAssertionRelease(assertionID)
        assertionID = 0
        enabled = false
    }

    func toggle() { enabled ? disable() : enable() }

    deinit { if enabled { IOPMAssertionRelease(assertionID) } }
}
