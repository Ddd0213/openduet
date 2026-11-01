// The run records' environment entry (M8): ShellHost injects the ChatStore's RunsContext, so the
// OpenDuet sheet's Activity and the task detail's Run details reach it without new parameters.
// Kept apart from RunsContract.swift so the contract stays Foundation-only (Mac host tests).
import SwiftUI

extension EnvironmentValues {
    /// Set by ShellHost from the ChatStore; previews get an empty one.
    @Entry var runs = RunsContext()
}
