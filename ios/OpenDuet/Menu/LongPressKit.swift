// M9: the pieces the long-press menus share (task rows, routines, channels, archived channels,
// gallery tiles, Files rows). A destructive item never acts at once: it opens a question in place
// under (or over) what was pressed, with Cancel and the red capsule (prompt L181, L186: never an
// alert), the spinner while it runs and the reason with Retry when it fails.
import SwiftUI

/// "Delete this task? Its conversation goes too." with Cancel | Delete, in place.
struct DeleteConfirmStrip: View {
    var question: Text
    var confirmTitle: Text = Text("Delete")
    var busy = false
    var failure: String?
    /// stacked buttons for narrow places (a gallery tile)
    var compact = false
    /// what VoiceOver announces when it opens (M28: "Confirm sign out" on the devices page)
    var announcement: String.LocalizationValue = "Confirm delete"
    var onConfirm: () -> Void
    var onCancel: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var questionSize: CGFloat = 14.5

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            question
                .font(.system(size: questionSize))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let failure {
                InlineFailure(reason: failure, onRetry: onConfirm)
            }
            if compact {
                VStack(spacing: 8) {
                    DestructiveCapsule(title: confirmTitle, busy: busy, action: onConfirm)
                    CapsuleButton(title: Text("Cancel"), style: .outline, action: onCancel)
                        .disabled(busy)
                }
            } else {
                HStack(spacing: 10) {
                    CapsuleButton(title: Text("Cancel"), style: .outline, action: onCancel)
                        .disabled(busy)
                    DestructiveCapsule(title: confirmTitle, busy: busy, action: onConfirm)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Palette.cardSurface)
                .strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline)
        )
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
        .accessibilityElement(children: .contain)
        .accessibilityAction(.escape, onCancel)
        .onAppear {
            // VoiceOver hears the question as soon as it opens.
            AccessibilityNotification.Announcement(String(localized: announcement)).post()
        }
    }
}

/// The springy reveal every in-place question uses (a crossfade with Reduce Motion).
extension AnyTransition {
    static func confirmReveal(reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.97, anchor: .top))
    }
}

/// A clean, rounded preview for a row's system context menu (the row on the card surface, not
/// the list's grey press state).
extension View {
    func cleanContextPreview(corner: CGFloat = 14) -> some View {
        contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: corner, style: .continuous))
    }
}

/// M9: the floating "Task deleted" / "Channel deleted" line (ShellState.notice), drawn by the
/// shell host over everything for ShellNotice.seconds.
struct ShellNoticeToast: View {
    var notice: ShellNotice

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 15

    private var text: Text {
        switch notice.kind {
        case .taskDeleted: Text("Task deleted")
        case .channelDeleted: Text("Channel deleted. Back to Everything.")
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            DuetIcon(glyph: .delete, size: 18, tint: Palette.secondaryText)
            text
                .font(.system(size: fontSize, weight: .medium))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(2)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(
            Capsule()
                .fill(Palette.floatingSurface)
                .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                .floatingShadow()
        )
        .accessibilityElement(children: .combine)
        .onAppear {
            let line = switch notice.kind {
            case .taskDeleted: String(localized: "Task deleted")
            case .channelDeleted: String(localized: "Channel deleted. Back to Everything.")
            }
            AccessibilityNotification.Announcement(line).post()
        }
    }
}
