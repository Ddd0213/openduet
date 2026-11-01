// A finished call's conversation (from its line in the chat): GET /api/calls/:id through
// `\.apiClient`. When and how long, the title, the transcript as two-sided bubbles by time, and
// a collapsed "Handed to OpenDuet" with what the call sent to the assistant and the assistant's replies, read-only
// (cards stay in the chat, where they can be answered). Loading, empty and error states inline.
import SwiftUI

struct CallDetailSheet: View {
    var callId: String
    var onClose: () -> Void

    @Environment(\.apiClient) private var api
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model = CallDetailModel()
    @State private var handedOpen = false

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Voice call"), leading: .close, onLeading: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    switch model.detail.display {
                    case .loading:
                        SettingsRowsSkeleton(rows: 3)
                    case .failed(let reason):
                        InlineRetryLine(reason: reason) { reload() }
                            .cardSurface()
                    case .loaded(let detail):
                        content(detail)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .refreshable { await model.load(api, callId: callId) }
        }
        .task { await model.load(api, callId: callId) }
        .animation(.easeInOut(duration: 0.2), value: model.detail.value != nil)
    }

    @ViewBuilder private func content(_ detail: CallDetail) -> some View {
        summary(detail.call)
        if detail.lines.isEmpty {
            SettingsNote(text: Text("Nothing was said on this call."))
        } else {
            VStack(spacing: 10) {
                ForEach(detail.lines.sorted { $0.at < $1.at }) { line in
                    CallTranscriptBubble(line: line)
                }
            }
        }
        if !detail.messages.isEmpty {
            handed(detail.messages)
        }
    }

    private func summary(_ call: Call) -> some View {
        let dates = ChatDateFormat(locale: locale)
        let length = PhraseFormatter.duration(Double(call.seconds), locale: locale)
        return VStack(alignment: .leading, spacing: 4) {
            if !call.title.isEmpty {
                Text(verbatim: call.title)
                    .font(Typography.serifTitle(22))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            Text(verbatim: "\(dates.relativeDayAndTime(call.startedAt)) · \(length)")
                .font(.subheadline)
                .foregroundStyle(Palette.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Handed to the assistant

    private func handed(_ messages: [Message]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.86)) {
                    handedOpen.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Text("Handed to OpenDuet")
                        .font(.system(.subheadline, weight: .semibold))
                        .foregroundStyle(Palette.secondaryText)
                    Text(verbatim: "\(messages.count)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(Palette.secondaryText)
                    Spacer(minLength: 0)
                    RowChevron()
                        .rotationEffect(.degrees(handedOpen ? 90 : 0))
                }
                .padding(.horizontal, 6)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityHint(handedOpen ? Text("Hides the messages") : Text("Shows the messages"))
            if handedOpen {
                VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 4) {
                    ForEach(messages) { message in
                        handedMessage(message)
                    }
                }
                .transition(.opacity)
            }
        }
    }

    @ViewBuilder private func handedMessage(_ message: Message) -> some View {
        let time = ChatDateFormat(locale: locale).time(message.createdAt)
        switch message.content {
        case .text(let payload) where message.role == .user:
            UserMessageView(
                text: message.text, attachments: payload.attachments, tail: true,
                accessibilityLabel: Text("You, \(time)"), onOpenFile: { _ in }
            )
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .system(let phrase):
            SystemLine(phrase: phrase)
        default:
            if message.text.isEmpty {
                // A card: it's answered in the chat, not here.
                Text("A card in the chat")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.secondaryText)
                    .padding(.horizontal, 6)
            } else {
                AssistantBubble(text: message.text)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(Text("OpenDuet, \(time)"))
            }
        }
    }

    private func reload() {
        Task { await model.load(api, callId: callId) }
    }
}
