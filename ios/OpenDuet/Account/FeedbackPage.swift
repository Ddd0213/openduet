// Profile > Send feedback (prompt L127): one text field and Send (spinner while sending, the
// reason + Retry on failure). On success the page turns into a confirmation with a green check;
// the server's "Thanks for the feedback" also lands in the chat.
import SwiftUI

struct FeedbackPage: View {
    /// cardRequests[RequestKey.feedback]
    var request: CardRequest?
    var onSend: (String) -> Void
    var onBack: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var text = ""
    @State private var sent = false
    @State private var sends = 0
    @FocusState private var focused: Bool
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 16
    @ScaledMetric(relativeTo: .title2) private var thanksSize: CGFloat = 24
    @ScaledMetric(relativeTo: .subheadline) private var noteSize: CGFloat = 15

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Send feedback"), leading: .back, onLeading: onBack)
            ZStack {
                if sent {
                    confirmation
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.94)))
                } else {
                    form
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 0.8), value: sent)
        .onAppear { focused = true }
        .onChange(of: request) { old, new in
            guard old == .inFlight, new == nil else { return }
            focused = false
            sent = true
        }
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .sensoryFeedback(.success, trigger: sent) { _, new in new }
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text("What's working, what isn't, what you'd like OpenDuet to do")
                        .font(.system(size: textSize))
                        .foregroundStyle(Palette.secondaryText)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 8)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $text)
                    .font(.system(size: textSize))
                    .scrollContentBackground(.hidden)
                    .focused($focused)
                    .disabled(request == .inFlight)
                    .accessibilityLabel(Text("Feedback"))
            }
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: 180, maxHeight: 320)
            .cardSurface()
            if let reason = request?.failureReason {
                InlineFailure(reason: reason) { onSend(trimmed) }
                    .padding(.horizontal, 6)
                    .transition(.opacity)
            }
            CapsuleButton(title: Text("Send"), busy: request == .inFlight) {
                sends += 1
                onSend(trimmed)
            }
            .disabled(trimmed.isEmpty || request == .inFlight)
            Spacer(minLength: 0)
        }
        .animation(.easeInOut(duration: 0.2), value: request)
    }

    private var confirmation: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(Palette.success)
                .symbolEffect(.bounce, value: sent)
                .accessibilityHidden(true)
            Text("Thanks for the feedback")
                .font(Typography.serifTitle(thanksSize))
                .foregroundStyle(Palette.primaryText)
                .multilineTextAlignment(.center)
            Text("It's on its way.")
                .font(.system(size: noteSize))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
            CapsuleButton(title: Text("Back"), style: .outline, fullWidth: false, action: onBack)
                .padding(.top, 6)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}
