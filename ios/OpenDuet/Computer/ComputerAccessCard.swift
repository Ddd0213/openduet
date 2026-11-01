// The live screen in the "OpenDuet's computer" detail sheet (PART C §1): the browser chrome over
// what the assistant's browser shows now, the page's domain and its state (Live, Waking up, Asleep ·
// Sleeps after N min idle). Tapping opens "OpenDuet's computer" full screen over the sheet, which
// wakes a sleeping browser, and where Take over / Hand back and "Let it sleep" live. A failed load
// offers Retry. M20: on a server without the assistant's computer the card is greyed out and can't be
// tapped (the detail sheet puts ComputerDeployHint above it).
import SwiftUI

struct ComputerAccessCard: View {
    @Environment(\.computerScene) private var scene
    @Environment(\.computerLink) private var link
    @State private var showing = false

    private var computer: ComputerState? { scene.view.computer }
    private var deployed: Bool { ComputerDeployRules.isDeployed(scene.view) }

    /// Follows the stream while the browser is up or waking; holds still while it sleeps.
    private var live: Bool { ComputerDeployRules.previewIsLive(scene.view) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            window
                .dimmedWithoutComputer()
            if deployed, case .failed(let reason) = scene.view.phase, computer == nil {
                InlineRetryLine(reason: reason) { link?.actions.reload() }
                    .cardSurface()
            }
        }
        .fullScreenCover(isPresented: $showing) {
            if let link {
                ComputerScreen(view: scene.view, status: scene.status, actions: link.actions, onClose: close)
            }
        }
    }

    /// M20 (user 2026-10-28): ✕, a swipe down and Escape all close through the store's
    /// `closeComputer()`, which hands back to the assistant when the user was in control. The cover
    /// stays local so closing it returns to this sheet.
    private func close() {
        showing = false
        link?.actions.close()
    }

    private var window: some View {
        Button { showing = true } label: {
            BrowserWindow {
                VStack(spacing: 0) {
                    LiveScreenImage(screen: link?.screen, live: live)
                        .aspectRatio(16.0 / 10.0, contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .clipped()
                    Divider().overlay(Palette.cardBorder)
                    ComputerPreviewFooter(domain: computer?.domain, tag: ComputerDeployRules.previewTag(scene.view))
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cardCorner, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(link == nil)
        .animation(.easeInOut(duration: 0.3), value: live)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("OpenDuet's computer"))
        .accessibilityValue(value)
        .accessibilityHint(deployed ? Text("Opens OpenDuet's computer") : Text(verbatim: ""))
        .accessibilityAddTraits(.isButton)
    }

    private var value: Text {
        guard deployed else { return Text("Isn't set up on this server yet") }
        guard let computer else { return Text("Loading") }
        if computer.controller == .user { return Text("You're in control") }
        switch computer.browser {
        case .ready:
            if let domain = computer.domain, !domain.isEmpty { return Text("Live, \(domain)") }
            return Text("Live")
        case .starting: return Text("Waking up")
        case .off: return Text("Asleep")
        }
    }
}

/// The preview card's footer: LiveBrowserFooter's look (globe, domain, quiet state on the right),
/// plus the idle time while asleep ("Asleep · Sleeps after 30 min idle"). The state never
/// truncates; the domain does, in the middle.
private struct ComputerPreviewFooter: View {
    var domain: String?
    var tag: ComputerDeployRules.PreviewTag

    @ScaledMetric(relativeTo: .footnote) private var textSize: CGFloat = 13

    var body: some View {
        HStack(spacing: 6) {
            DuetIcon(glyph: .page, size: textSize + 1, tint: Palette.secondaryText)
            Group {
                if let domain, !domain.isEmpty {
                    Text(verbatim: domain)
                } else {
                    Text("No page open")
                }
            }
            .font(.system(size: textSize, weight: .medium))
            .foregroundStyle(Palette.primaryText)
            .lineLimit(1)
            .truncationMode(.middle)
            Spacer(minLength: 8)
            state
                .layoutPriority(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .animation(.easeInOut(duration: 0.25), value: tag)
    }

    @ViewBuilder private var state: some View {
        switch tag {
        case .live:
            BrowserLiveTag().transition(.opacity)
        case .waking:
            quiet(Text("Waking up"))
        case .asleep(let minutes?):
            quiet(Text("Asleep · Sleeps after \(minutes) min idle"))
        case .asleep(nil):
            quiet(Text("Asleep"))
        case .none:
            EmptyView()
        }
    }

    private func quiet(_ text: Text) -> some View {
        text
            .font(.system(size: textSize - 1, weight: .medium))
            .foregroundStyle(Palette.secondaryText)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .transition(.opacity)
    }
}
