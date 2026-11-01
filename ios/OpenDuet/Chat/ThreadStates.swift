// The main thread's whole-screen states (prompt L184): skeleton bubbles shaped like a chat with
// a soft pulse on first load, an inline grey reason with Retry when it fails (never an alert),
// and the empty thread.
import SwiftUI

struct ThreadSkeleton: View {
    /// The assistant / user bubble widths (fractions of the 80% slot), oldest first.
    private static let rows: [(assistant: Bool, width: CGFloat, height: CGFloat)] = [
        (true, 0.9, 64), (false, 0.55, 40), (true, 0.75, 88), (true, 0.45, 40), (false, 0.65, 40),
    ]

    var body: some View {
        VStack(spacing: Metrics.groupSpacing) {
            Spacer(minLength: 0)
            ForEach(Array(Self.rows.enumerated()), id: \.offset) { _, row in
                RoundedRectangle(cornerRadius: Metrics.bubbleCorner, style: .continuous)
                    .fill(row.assistant ? Palette.skeleton : Palette.userBubble.opacity(0.5))
                    .containerRelativeFrame(.horizontal) { width, _ in width * Metrics.bubbleMaxWidthFraction * row.width }
                    .frame(height: row.height)
                    .frame(maxWidth: .infinity, alignment: row.assistant ? .leading : .trailing)
            }
        }
        .padding(.horizontal, Metrics.threadInset)
        .padding(.bottom, 12)
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading messages"))
    }
}

/// Skeleton bubbles at the top of the thread while an older page loads.
struct OlderSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing) {
            RoundedRectangle(cornerRadius: Metrics.bubbleCorner, style: .continuous)
                .fill(Palette.skeleton)
                .frame(width: 200, height: 40)
            RoundedRectangle(cornerRadius: Metrics.bubbleCorner, style: .continuous)
                .fill(Palette.skeleton)
                .frame(width: 140, height: 40)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading earlier messages"))
    }
}

/// The first load failed: the reason in grey and a Retry capsule.
struct ThreadFailedView: View {
    var reason: String
    var onRetry: () -> Void

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 15

    var body: some View {
        VStack(spacing: 14) {
            // The store's reason is already localized.
            Text(verbatim: reason)
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
            Button(action: onRetry) {
                Text("Retry")
                    .font(.system(size: fontSize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 9)
                    .background(
                        Capsule()
                            .fill(Palette.floatingSurface)
                            .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                            .floatingShadow()
                    )
            }
            .buttonStyle(PressableButtonStyle())
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// No messages yet: the still mascot and one line; the composer below is the action.
struct ThreadEmptyView: View {
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 15

    var body: some View {
        // M29: the mascot's frame keeps room for hops above and below it; 8 pt keeps the old gap.
        VStack(spacing: 8) {
            DuetMascot(pose: .idle, size: 40)
            Text("Message OpenDuet to get started.")
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
