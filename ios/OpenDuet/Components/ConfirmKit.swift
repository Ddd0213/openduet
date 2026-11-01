// In-app confirmation and small controls for the M4 sheets (prompt L181, L186): a destructive
// row that expands into a question with Cancel and a red capsule (never an alert), the ⓘ that
// opens a small explanation bubble, and the dashed "+" that connects an app (spinner in flight).
import SwiftUI

extension CardRequest {
    /// The inline reason of a failed request; nil while idle or in flight.
    var failureReason: String? {
        if case .failed(let reason) = self { reason } else { nil }
    }
}

/// A red capsule for a destructive action; while `busy` a spinner replaces the title.
struct DestructiveCapsule: View {
    var title: Text
    var busy = false
    var action: () -> Void

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 16

    var body: some View {
        Button(action: action) {
            title
                .font(.system(size: fontSize, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .opacity(busy ? 0 : 1)
                .overlay { if busy { ProgressView().tint(.white).controlSize(.small) } }
                .foregroundStyle(.white)
                .padding(.horizontal, 18)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(Capsule().fill(Palette.destructive))
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.96))
        .disabled(busy)
        .accessibilityValue(busy ? Text("In progress") : Text(verbatim: ""))
    }
}

/// A destructive row ("Sign out", "Disconnect") that asks first, in place: tapping it expands
/// the question with Cancel and the red confirm capsule; a failure shows its reason with Retry.
struct InlineConfirm: View {
    var title: Text
    var question: Text
    var confirmTitle: Text
    var busy = false
    var failure: String?
    var onConfirm: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var asking = false
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var questionSize: CGFloat = 14.5

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if asking || busy || failure != nil {
                question
                    .font(.system(size: questionSize))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
                if let failure {
                    InlineFailure(reason: failure, onRetry: onConfirm)
                        .transition(.opacity)
                }
                HStack(spacing: 10) {
                    CapsuleButton(title: Text("Cancel"), style: .outline) { asking = false }
                        .disabled(busy)
                    DestructiveCapsule(title: confirmTitle, busy: busy, action: onConfirm)
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
            } else {
                Button { asking = true } label: {
                    title
                        .font(.system(size: titleSize, weight: .medium))
                        .foregroundStyle(Palette.destructive)
                        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: asking)
        .animation(.easeInOut(duration: 0.2), value: failure)
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
    }
}

/// The ⓘ next to a title: a small bubble with one explanation (a popover, never an alert).
struct InfoButton: View {
    var label: Text
    var message: Text
    var size: CGFloat = 15

    @State private var showing = false
    @ScaledMetric(relativeTo: .subheadline) private var messageSize: CGFloat = 15

    var body: some View {
        Button { showing = true } label: {
            Image(systemName: "info.circle")
                .font(.system(size: size, weight: .regular))
                .foregroundStyle(Palette.secondaryText)
                .frame(minWidth: 28, minHeight: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.9))
        .accessibilityLabel(label)
        .popover(isPresented: $showing, arrowEdge: .top) {
            message
                .font(.system(size: messageSize))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 270, alignment: .leading)
                .padding(16)
                .presentationCompactAdaptation(.popover)
                .presentationBackground(Palette.cardSurface)
        }
    }
}

/// The dashed "+" circle on a row that isn't connected yet (L125); a spinner while connecting.
struct DashedPlusButton: View {
    var busy = false
    var label: Text
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .strokeBorder(Palette.dashedRing, style: StrokeStyle(lineWidth: 1.2, dash: [3, 3]))
                    .frame(width: 32, height: 32)
                if busy {
                    ProgressView().controlSize(.small).transition(.opacity)
                } else {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .transition(.opacity)
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .animation(.easeInOut(duration: 0.2), value: busy)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.9))
        .disabled(busy)
        .accessibilityLabel(label)
        .accessibilityValue(busy ? Text("Connecting") : Text(verbatim: ""))
    }
}
