// What the chat's M6 pieces read besides their message (set by MainShellView): the Make state
// (artifact cards follow the live summary, build status and pin), the chat extras (skills,
// ratings, reaction failures) and the artifact types for inline duet://artifacts/<id> pills.
import SwiftUI

extension EnvironmentValues {
    @Entry var makeState = MakeState()
    @Entry var chatExtras = ChatExtrasState()
    /// artifact id -> type, for "Your ◈ Monday brief is ready" pills in markdown.
    @Entry var artifactTypes: [String: ArtifactType] = [:]
}

extension ArtifactType: Identifiable {
    var id: String { rawValue }
}
