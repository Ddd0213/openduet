// The app's voice call (Voice/CallSession.swift) for the views that show or start it: the call
// bar under the header, the composer's circle and its notes. ShellHost sets it next to `runs` /
// `apiClient`; previews leave it nil (no call, the circle's notes stay local).
import SwiftUI

extension EnvironmentValues {
    @Entry var call: CallSession? = nil
}
