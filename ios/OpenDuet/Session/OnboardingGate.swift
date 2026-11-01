// When onboarding shows and when it is reported to the server (L77). The server's
// `user.onboardedAt` decides: nil = the flow shows after sign-in. Finishing the first run
// POSTs /api/onboarding/complete once (the assistant's welcome and the first-day scan start there); if
// that fails, the user still goes on to the chat, a local marker keeps the flow from showing
// again on this device, and the POST is retried in the background until the server has it. A
// long-press replay is local only: it never posts, never deletes server data, never rescans.
// Foundation only, so the Mac host tests drive it.
import Foundation

struct OnboardingGate: Hashable, Sendable {
    enum Mode: Hashable, Sendable {
        case hidden
        /// The real first run: finishing reports it to the server.
        case firstRun
        /// Long-press on the initials: the pages again, nothing sent.
        case replay
    }

    private(set) var mode: Mode
    /// The server has onboardedAt for this user.
    private(set) var serverOnboarded: Bool
    /// Finished on this device (UserDefaults marker) while the server may not know yet.
    private(set) var finishedLocally: Bool

    init(onboardedAt: Date?, finishedLocally: Bool) {
        serverOnboarded = onboardedAt != nil
        self.finishedLocally = finishedLocally
        mode = (onboardedAt == nil && !finishedLocally) ? .firstRun : .hidden
    }

    var isShowing: Bool { mode != .hidden }

    /// M12: the first page "Add a model" shows on the real first run while the server has no
    /// usable model (features.models false). A replay and users already onboarded never see it.
    func showsModelStep(modelsConfigured: Bool) -> Bool {
        mode == .firstRun && !modelsConfigured
    }

    /// The first run was finished here but POST /api/onboarding/complete hasn't succeeded yet.
    var needsCompletePost: Bool { finishedLocally && !serverOnboarded }

    /// After the celebration. Returns true when POST /api/onboarding/complete should go out (the
    /// first run only; a replay never posts).
    mutating func finish() -> Bool {
        let wasFirstRun = mode == .firstRun
        mode = .hidden
        guard wasFirstRun else { return false }
        finishedLocally = true
        return !serverOnboarded
    }

    /// Long-press on the initials.
    mutating func replay() {
        mode = .replay
    }

    /// POST /api/onboarding/complete succeeded, or GET /api/me came back with onboardedAt.
    mutating func serverConfirmed() {
        serverOnboarded = true
    }

    /// Any fresh copy of the user (GET /api/me, PATCH answers).
    mutating func userRefreshed(onboardedAt: Date?) {
        if onboardedAt != nil { serverOnboarded = true }
    }
}
