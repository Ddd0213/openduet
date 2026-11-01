// The 4th tab (prompt L152): the artifact added to the tab bar, opened in the shell with the same
// viewer content and no ✕ (⋯ offers "Remove from tab bar"). It loads when the tab shows and again
// when another artifact takes its place.
import SwiftUI

struct PinnedArtifactTab: View {
    var make: MakeState
    var actions: MakeActions
    var onOpenRoute: (URL) -> Void
    var onEditing: (Bool) -> Void
    /// The page's colour for the shell's header and tab bar (one block with the viewer's row).
    var onChrome: (ViewerChrome?) -> Void = { _ in }

    private var pinned: ArtifactSummary? { make.pinned }

    var body: some View {
        Group {
            if let viewer = make.pinnedViewer, viewer.artifactId == pinned?.id {
                ArtifactViewer(viewer: viewer, make: make, actions: actions, pinned: true, onOpenRoute: onOpenRoute, onEditing: onEditing, onChrome: onChrome)
                    .id(viewer.artifactId)
            } else {
                ViewerSkeleton(type: pinned?.type ?? .dashboard)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: pinned?.id) { actions.showPinned() }
    }
}
