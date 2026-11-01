// M20 (prompt L138, plan §3 W5): the assistant's computer on a server that doesn't deploy it. The
// computer detail keeps its grey "isn't set up" line and, in a card under it, says what deploying
// adds and costs, with the command in the chat's code block (Copy, then "Copied"). What can't
// work without it is greyed out (ComputerDeployDimming). Make's Describe sheet says builds need
// it, with Set up opening that detail (ComputerDetailLink, the OpenDuet sheet's own row action).
import SwiftUI

/// Opens the "OpenDuet's computer" detail sheet (ConnectorActions.openDetail for its toolkit),
/// for views that only get the environment. Set once by `computerOverlays`.
@MainActor
final class ComputerDetailLink {
    let open: () -> Void

    init(open: @escaping () -> Void) {
        self.open = open
    }
}

extension EnvironmentValues {
    @Entry var computerDetailLink: ComputerDetailLink? = nil
}

/// The computer detail on a server without the assistant's computer: the grey line, then what it adds,
/// what it costs and the command that deploys it. Nothing (no stack spacing either) once it is
/// deployed, so the detail sheet places it unconditionally and only this view reads the state.
struct ComputerDeployHint: View {
    @Environment(\.computerScene) private var scene
    @ScaledMetric(relativeTo: .footnote) private var noteSize: CGFloat = 13.5
    @ScaledMetric(relativeTo: .subheadline) private var bodySize: CGFloat = 15

    var body: some View {
        if !ComputerDeployRules.isDeployed(scene.view) {
            hint.transition(.opacity)
        }
    }

    private var hint: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text("OpenDuet's computer isn't set up on this server yet.")
            } icon: {
                DuetIcon(glyph: .notSetUp, size: noteSize + 2, tint: Palette.secondaryText)
            }
            .font(.system(size: noteSize))
            .foregroundStyle(Palette.secondaryText)
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Once it's set up, OpenDuet can browse the web, sign in to sites and run Make builds.")
                        .font(.system(size: bodySize))
                        .foregroundStyle(Palette.primaryText)
                    Text("About 2 GB to download. About 100 MB of memory while asleep, up to 2 GB while browsing.")
                        .font(.system(size: noteSize))
                        .foregroundStyle(Palette.secondaryText)
                }
                .fixedSize(horizontal: false, vertical: true)
                Text("Run this on your server:")
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.secondaryText)
                MarkdownCodeBlock(language: "sh", code: ComputerDeployRules.deployCommand)
                if ComputerDeployRules.offersHeaded {
                    Text("Add \(Text(verbatim: ComputerDeployRules.headedFlag).font(.system(size: noteSize, design: .monospaced))) to run the browser on a virtual display in the container. It uses a little more memory.")
                        .font(.system(size: noteSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()
        }
    }
}

/// What can't work without the assistant's computer (its preview card, its tool rows): the disabled
/// picker's dimmed look, and no taps.
struct ComputerDeployDimming: ViewModifier {
    @Environment(\.computerScene) private var scene

    func body(content: Content) -> some View {
        let deployed = ComputerDeployRules.isDeployed(scene.view)
        content
            .disabled(!deployed)
            .opacity(deployed ? 1 : ComputerDeployRules.dimmedOpacity)
            .animation(.easeInOut(duration: 0.25), value: deployed)
    }
}

extension View {
    func dimmedWithoutComputer() -> some View {
        modifier(ComputerDeployDimming())
    }
}

/// Make's Describe sheet on a server without the assistant's computer: "Make builds run in OpenDuet's
/// computer, which isn't set up on this server. Set up" (Set up opens the computer detail with
/// the deploy command). The look of the chat's "No model set up yet · Set up" line. Nothing once
/// it is deployed. Create isn't blocked: the server's 503 reason shows under the composer as
/// any failed Create does.
struct MakeComputerHint: View {
    /// closes the sheet this sits in; the detail comes up from the shell once it has gone
    var onClose: () -> Void

    @Environment(\.computerScene) private var scene
    @Environment(\.computerDetailLink) private var detailLink
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13.5

    var body: some View {
        if !ComputerDeployRules.isDeployed(scene.view) {
            line.transition(.opacity)
        }
    }

    private func setUp() {
        onClose()
        guard let detailLink else { return }
        Task { @MainActor in
            try? await Task.sleep(for: ComputerDeployRules.reopenDelay)
            detailLink.open()
        }
    }

    private var line: some View {
        let lift = fontSize * 0.36
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            DuetIcon(glyph: .notSetUp, size: fontSize + 2, tint: Palette.secondaryText)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
                .accessibilityHidden(true)
            Text("Make builds run in OpenDuet's computer, which isn't set up on this server.")
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: setUp) {
                Text("Set up")
                    .fontWeight(.semibold)
                    .foregroundStyle(Palette.accent)
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .accessibilityHint(Text("Opens OpenDuet's computer"))
        }
        .font(.system(size: fontSize))
        .frame(maxWidth: .infinity, alignment: .leading)
        // Above the Describe sheet's composer, inset like it (no room taken when hidden).
        .padding(.horizontal, Metrics.threadInset + 6)
        .padding(.bottom, 6)
        .accessibilityElement(children: .contain)
    }
}
