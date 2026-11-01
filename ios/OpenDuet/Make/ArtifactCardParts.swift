// The chat artifact card's live preview (prompt L153): a 2×2 grid of metric tiles whose numbers
// roll up to the latest value while on screen (Reduce Motion: they just show it), and the card's
// footer (type icon, title, "Updated now", pin, ›).
import SwiftUI

struct MetricGrid: View {
    var metrics: [ArtifactPayload.Metric]

    private let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(Array(metrics.prefix(4).enumerated()), id: \.offset) { _, metric in
                MetricTile(metric: metric)
            }
        }
    }
}

/// One tile: the label small and grey, the value large; the number rolls from its last value.
struct MetricTile: View {
    var metric: ArtifactPayload.Metric

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale
    @State private var shown: Double?
    @ScaledMetric(relativeTo: .title2) private var valueSize: CGFloat = 24
    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 13

    var body: some View {
        let copy = MakeCopy(format: ChatDateFormat(locale: locale))
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: metric.label)
                .font(.system(size: labelSize, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
                .lineLimit(1)
            Text(verbatim: copy.metric(shown ?? metric.value, unit: metric.unit))
                .font(.system(size: valueSize, weight: .semibold).monospacedDigit())
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .contentTransition(.numericText(value: shown ?? metric.value))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.primaryText.opacity(0.04)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(metric.label), \(copy.metric(metric.value, unit: metric.unit))"))
        .onAppear { roll(from: 0) }
        .onChange(of: metric.value) { old, _ in roll(from: old) }
    }

    /// On screen: count up to the latest value (Reduce Motion: show it).
    private func roll(from start: Double) {
        guard !reduceMotion, start != metric.value else { shown = metric.value; return }
        shown = start
        withAnimation(.easeOut(duration: 0.9)) { shown = metric.value }
    }
}

/// The card's bottom row: type icon, title, "Updated now", the pin toggle and ›. The pin is its
/// own button next to the open button (no nested buttons).
struct ArtifactCardFooter: View {
    var artifact: ArtifactSummary
    var now: Date
    var pinBusy: Bool
    var onOpen: () -> Void
    var onPin: (Bool) -> Void

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var metaSize: CGFloat = 13

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onOpen) {
                HStack(spacing: 10) {
                    ArtifactTypeIcon(type: artifact.type, size: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: artifact.title)
                            .font(.system(size: titleSize, weight: .semibold))
                            .foregroundStyle(Palette.primaryText)
                            .lineLimit(1)
                        meta
                            .font(.system(size: metaSize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.98))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(ArtifactAccessibility.label(artifact, justMade: false, now: now))
            .accessibilityHint(Text("Opens it"))
            if artifact.status == .ready {
                Button { onPin(!artifact.pinnedToTabBar) } label: {
                    // M9: the set's pin; pinned reads by its orange ink (no filled variant).
                    DuetIcon(glyph: .pin, size: 18, tint: artifact.pinnedToTabBar ? Palette.justMade : Palette.secondaryText)
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                        .opacity(pinBusy ? 0.4 : 1)
                }
                .buttonStyle(PressableButtonStyle(scale: 0.9))
                .disabled(pinBusy)
                .accessibilityLabel(artifact.pinnedToTabBar ? Text("Remove from tab bar") : Text("Add to tab bar"))
                .sensoryFeedback(.selection, trigger: artifact.pinnedToTabBar)
            }
            Button(action: onOpen) { RowChevron().frame(width: 20, height: 36).contentShape(Rectangle()) }
                .buttonStyle(PressableButtonStyle(scale: 0.9))
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private var meta: some View {
        switch artifact.status {
        case .building: Text("Making it...")
        case .failed: Text("Couldn't finish this one")
        case .ready: Text(verbatim: MakeCopy(format: ChatDateFormat(locale: locale)).updated(artifact.updatedAt, now: now))
        }
    }
}
