// The chat's live browser card (prompt L143) in the look of onboarding page 3's card: the
// browser chrome, the live page in the white body (the socket runs only while the card is on
// screen), the current domain and a small "Live" label. Once the session has ended it holds
// still and drops the label. Tapping it opens "OpenDuet's computer".
import SwiftUI

struct LiveBrowserCardView: View {
    var payload: LiveBrowserPayload
    var actions: ComputerActions

    @Environment(\.computerScene) private var scene

    private var live: Bool { payload.state == .live }

    /// While live, the page the assistant is on now; afterwards the one the card was posted for.
    private var domain: String {
        if live, let current = scene.view.computer?.domain, !current.isEmpty { return current }
        return payload.domain
    }

    var body: some View {
        Button(action: actions.open) {
            BrowserWindow {
                VStack(spacing: 0) {
                    LiveScreenImage(screen: actions.screen, live: live)
                        .aspectRatio(16.0 / 10.0, contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .clipped()
                    Divider().overlay(Palette.cardBorder)
                    LiveBrowserFooter(domain: domain, tag: live ? .live : .ended)
                }
            }
            .frame(maxWidth: 360)
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cardCorner, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeInOut(duration: 0.3), value: live)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityHint(Text("Opens OpenDuet's computer"))
        .accessibilityAddTraits(.isButton)
    }

    private var label: Text {
        guard live else { return Text("OpenDuet's browser, \(domain), ended") }
        if scene.view.isUserInControl { return Text("OpenDuet's browser, \(domain), live, you're in control") }
        return Text("OpenDuet's browser, \(domain), live, it is in control")
    }
}
