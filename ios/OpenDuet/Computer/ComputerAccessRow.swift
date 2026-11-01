// The "OpenDuet's computer" row in the OpenDuet sheet (PART C §1; M16: its own card, it belongs to the assistant):
// a computer tile, the name and a one-line state (the page the assistant is on, "You're in control",
// waking, asleep, or not set up on this server). Tapping opens its detail sheet, which shows
// the live screen with Take over / Hand back. The state comes from the environment the shell
// sets, so the OpenDuet sheet needs no new parameters.
import SwiftUI

struct ComputerAccessRow: View {
    var onOpen: () -> Void

    @Environment(\.computerScene) private var scene

    var body: some View {
        SheetRow(title: Text("OpenDuet's computer"), subtitle: subtitle, action: onOpen) {
            RowSymbol(systemImage: DuetGlyph.computer.symbol)
        } trailing: {
            HStack(spacing: 8) {
                if live {
                    BrowserLiveTag()
                }
                RowChevron()
            }
        }
        .accessibilityHint(Text("Shows OpenDuet's own browser"))
    }

    private var live: Bool {
        guard ComputerDeployRules.isDeployed(scene.view), let computer = scene.view.computer else { return false }
        return computer.browser == .ready
    }

    /// M20: not deployed (Me.features.computerMode off, or GET /api/computer says it isn't
    /// available) reads "Isn't set up on this server yet" before the computer has loaded too.
    private var subtitle: Text {
        guard ComputerDeployRules.isDeployed(scene.view) else { return Text("Isn't set up on this server yet") }
        guard let computer = scene.view.computer else { return Text("OpenDuet's own browser") }
        if computer.controller == .user { return Text("You're in control") }
        switch computer.browser {
        case .ready:
            if let domain = computer.domain, !domain.isEmpty { return Text(verbatim: domain) }
            return Text("OpenDuet's own browser")
        case .starting: return Text("Waking up")
        case .off: return Text("Asleep")
        }
    }
}
