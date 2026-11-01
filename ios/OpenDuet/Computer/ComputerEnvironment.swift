// What the computer views read besides their arguments: the computer's state and the run's
// status (for sheets that only get ConnectorActions, like the OpenDuet sheet's row and the
// "OpenDuet's computer" detail), the live actions and frames, and the modifier that keeps the
// stream socket open while a live screen is on screen. Set once by `computerOverlays`.
import SwiftUI
import UIKit

struct ComputerScene: Hashable, Sendable {
    var view = ComputerViewState()
    /// the run's live status (the full-screen pill while the assistant works)
    var status: StatusKey?
}

/// The computer's actions for views deep in sheets (an environment value must be Sendable).
@MainActor
final class ComputerLink {
    let actions: ComputerActions

    init(actions: ComputerActions) {
        self.actions = actions
    }

    var screen: LiveScreen? { actions.screen }
}

extension EnvironmentValues {
    @Entry var computerScene = ComputerScene()
    @Entry var computerLink: ComputerLink? = nil
}

extension View {
    /// Keeps the live stream open while this view is on screen (cards scrolled away let it go).
    func liveScreenDemand(_ screen: LiveScreen?, active: Bool = true) -> some View {
        task(id: active ? screen.map(ObjectIdentifier.init) : nil) {
            guard active, let screen else { return }
            screen.attach()
            defer { screen.detach() }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3600))
            }
        }
    }
}

enum LiveFrameDecoder {
    /// A frame decoded off the main thread, ready to draw.
    nonisolated static func decode(_ data: Data) async -> UIImage? {
        guard let image = UIImage(data: data) else { return nil }
        return await image.byPreparingForDisplay() ?? image
    }
}
