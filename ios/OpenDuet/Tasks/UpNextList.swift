// "Up next" (prompt L119): "From your connectors" suggestions, each with an outline "Add" (makes
// it a task) and a ✕ to hide it; the empty state with three app icons, "What can I take off your
// plate?", one line and a white "Show me" capsule that runs a scan (`tasks.scan`); while it runs
// the capsule reads "Checking your tools…", and a failed scan shows a grey line with Retry.
// M22: the Show me answer line (ShowMeFeedback) and a "You asked" caption on suggestions saved
// from the + sheet (Suggestion.fromUser).
import SwiftUI

struct UpNextList: View {
    var state: UpNextState
    var requests: ShellState.CardRequests
    var actions: TaskActions

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var headerSize: CGFloat = 15

    var body: some View {
        switch state.phase {
        case .loading where state.suggestions.isEmpty:
            TaskRowsSkeleton(rows: 3).padding(.top, 8)
        case .failed(let reason) where state.suggestions.isEmpty:
            InlineRetryLine(reason: reason, onRetry: actions.refresh)
        default:
            if state.suggestions.isEmpty {
                UpNextEmpty(
                    scanning: state.scanning || requests[ShellState.RequestKey.scan] == .inFlight,
                    scanStartedAt: state.scanStartedAt,
                    foundNothing: state.scanFoundNothing,
                    failure: requests[ShellState.RequestKey.scan]?.failureReason,
                    onShowMe: actions.scan
                )
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    Text("From your connectors")
                        .font(.system(size: headerSize, weight: .semibold))
                        .foregroundStyle(Palette.secondaryText)
                        .padding(.vertical, 6)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(Array(state.suggestions.enumerated()), id: \.element.id) { index, suggestion in
                        if index > 0 { Divider().overlay(Palette.cardBorder).padding(.leading, Metrics.iconTile + 12) }
                        SuggestionRow(
                            suggestion: suggestion, request: requests[suggestion.id],
                            onAdd: { actions.addSuggestion(suggestion.id) },
                            onHide: { actions.hideSuggestion(suggestion.id) }
                        )
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .leading)))
                    }
                }
                .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.35, dampingFraction: 0.86), value: state.suggestions.map(\.id))
            }
        }
    }
}

private struct SuggestionRow: View {
    var suggestion: Suggestion
    var request: CardRequest?
    var onAdd: () -> Void
    var onHide: () -> Void

    private enum Tap { case add, hide }
    @State private var lastTap: Tap = .add
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var bodySize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                IconTile(app: suggestion.app, systemImage: "tray")
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: suggestion.title)
                        .font(.system(size: titleSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    // M22: one saved from the + sheet ("Save for Up next") says whose it is.
                    if suggestion.fromUser == true {
                        Text("You asked")
                            .font(.system(size: bodySize - 1))
                            .foregroundStyle(Palette.secondaryText)
                    }
                    if !suggestion.body.isEmpty {
                        Text(verbatim: suggestion.body)
                            .font(.system(size: bodySize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(3)
                    }
                }
                Spacer(minLength: 6)
                CapsuleButton(title: Text("Add"), style: .outline, busy: request == .inFlight && lastTap == .add, fullWidth: false) {
                    lastTap = .add
                    onAdd()
                }
                .accessibilityLabel(Text("Add \(suggestion.title)"))
                Button {
                    lastTap = .hide
                    onHide()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.secondaryText)
                        .frame(width: 30, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.9))
                .accessibilityLabel(Text("Hide \(suggestion.title)"))
            }
            .disabled(request == .inFlight)
            if case .failed(let reason) = request {
                InlineFailure(reason: reason) { lastTap == .add ? onAdd() : onHide() }
                    .padding(.leading, Metrics.iconTile + 12)
            }
        }
        .padding(.vertical, 10)
        .animation(.easeInOut(duration: 0.2), value: request)
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }
}

/// The empty Up next (L119): three app icons, the question, one line and "Show me". While the scan
/// runs the capsule becomes a spinner with "Checking your tools"; M22 (review-ux §14): a line
/// under it always answers the tap (ShowMeFeedback): slow after 60 s, nothing new when the scan
/// ended empty, or "Couldn't check just now." + the reason with Retry (RequestKey.scan).
private struct UpNextEmpty: View {
    var scanning: Bool
    var scanStartedAt: Date?
    var foundNothing: Bool
    var failure: String?
    var onShowMe: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Moved on when a running scan turns slow (the line is read against it).
    @State private var now = Date.now

    private var feedback: ShowMeFeedback {
        ShowMeFeedback.line(scanning: scanning, startedAt: scanStartedAt, foundNothing: foundNothing, failure: failure, now: max(now, scanStartedAt ?? now))
    }

    @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = 22
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 15

    var body: some View {
        VStack(spacing: 16) {
            HStack(spacing: -10) {
                IconTile(app: "Gmail", size: 52).rotationEffect(.degrees(-8))
                IconTile(app: "Google Calendar", size: 56).zIndex(1)
                IconTile(app: "Slack", size: 52).rotationEffect(.degrees(8))
            }
            .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
            .padding(.bottom, 4)
            .accessibilityHidden(true)
            Text("What can I take off your plate?")
                .font(Typography.serifTitle(titleSize))
                .foregroundStyle(Palette.primaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("I'll check your tools for work I can handle and bring you a short list.")
                .font(.system(size: bodySize))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onShowMe) {
                HStack(spacing: 8) {
                    if scanning {
                        // M10: the hand-drawn spinner, in the label's ink.
                        SpinnerArc(size: 15, color: Palette.primaryText, lineWidth: 1.8).transition(.opacity)
                        Text("Checking your tools…").transition(.opacity)
                    } else {
                        Text("Show me").transition(.opacity)
                    }
                }
                .font(.system(size: bodySize + 1, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .padding(.horizontal, 22)
                .padding(.vertical, 11)
                .background(
                    Capsule()
                        .fill(Palette.floatingSurface)
                        .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                        .floatingShadow()
                )
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(scanning)
            .padding(.top, 4)
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.85), value: scanning)
            .accessibilityValue(scanning ? Text("In progress") : Text(verbatim: ""))
            switch feedback {
            case .none:
                EmptyView()
            case .slow:
                feedbackLine(Text("This is taking a while. New tasks show up here."))
            case .nothingNew:
                feedbackLine(Text("Nothing new right now. I'll keep checking."))
            case .failed(let reason):
                InlineFailure(reason: String(localized: "Couldn't check just now. \(reason)"), onRetry: onShowMe)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: feedback)
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
        // The slow line comes 60 s into the scan (a scan already that old shows it at once).
        .task(id: scanStartedAt) {
            now = .now
            guard let at = ShowMeFeedback.slowAt(scanning: scanning, startedAt: scanStartedAt, now: now) else { return }
            try? await Task.sleep(for: .seconds(at.timeIntervalSinceNow + 0.1))
            guard !Task.isCancelled else { return }
            now = .now
        }
        // VoiceOver hears the answer too (the line appears away from the focused button).
        .onChange(of: feedback) { _, new in
            switch new {
            case .nothingNew: AccessibilityNotification.Announcement(String(localized: "Nothing new right now. I'll keep checking.")).post()
            case .slow: AccessibilityNotification.Announcement(String(localized: "This is taking a while. New tasks show up here.")).post()
            case .none, .failed: break
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }

    private func feedbackLine(_ text: Text) -> some View {
        text
            .font(.system(size: bodySize))
            .foregroundStyle(Palette.secondaryText)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .transition(.opacity)
    }
}
