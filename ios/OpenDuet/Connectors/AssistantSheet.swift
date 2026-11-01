// The OpenDuet sheet: the mascot opens it. On the main thread it is Everything's sheet
// (Settings/EverythingSheet.swift: who OpenDuet is, About you, the assistant's computer, channels,
// activity); this init stays for the previews. M16: the apps (connected, More apps with search,
// custom connectors) moved to Settings › Apps and connectors (Account/ConnectedAppsPage.swift);
// the pieces they share stay here: the not-set-up line and the skeleton rows.
import SwiftUI

struct AssistantSheet: View {
    var assistant: AssistantAccessState
    var requests: ShellState.CardRequests
    var actions: ConnectorActions
    var onClose: () -> Void

    var body: some View {
        EverythingSheet(actions: actions, onClose: onClose)
    }
}

/// "App connections aren't set up on this server yet." under the rows (L77: optional services).
struct NotSetUpLine: View {
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13.5

    var body: some View {
        Label {
            Text("App connections aren't set up on this server yet.")
        } icon: {
            DuetIcon(glyph: .notSetUp, size: fontSize + 3, tint: Palette.secondaryText)
        }
        .font(.system(size: fontSize))
        .foregroundStyle(Palette.secondaryText)
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Skeleton rows shaped like the access / catalog rows (L184).
struct AccessRowsSkeleton: View {
    var rows = 5

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Palette.skeleton)
                        .frame(width: 32, height: 32)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 120 : 90), height: 13)
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 180 : 150), height: 10)
                    }
                    Spacer()
                    Circle().fill(Palette.skeleton).frame(width: 28, height: 28)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: Metrics.sheetRowMinHeight + 4)
            }
        }
        .cardSurface()
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading apps"))
    }
}
