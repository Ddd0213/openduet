// One message, by kind (prompt L99-L113, L179): the assistant's markdown bubble, the user's bubble with
// its attachments and Seen / Delivered, quick-reply chips, system and usage-limit lines, image
// bubbles and file cards; later milestones' cards show as PlaceholderCard for now.
import SwiftUI

struct MessageView: View {
    var message: Message
    var layout: MessageLayout
    var streaming: Bool
    var actions: ShellActions
    var onSent: () -> Void

    @Environment(\.locale) private var locale

    var body: some View {
        switch message.content {
        case .text(let payload):
            if message.role == .user {
                VStack(alignment: .trailing, spacing: 4) {
                    // M9: the text bubble's long press opens the bubble menu (Chat/BubbleMenu/).
                    UserMessageView(
                        text: message.text, attachments: payload.attachments, tail: layout.tail,
                        accessibilityLabel: Text("You, \(time)"), onOpenFile: open,
                        menu: (message, actions.chatExtras)
                    )
                    // M6 (L157): the assistant's reactions show on the badges too.
                    .messageReactions(message, actions: actions.chatExtras, alignment: .trailing)
                    // M15: what the voice passed to the assistant during a call (its words, not the user's).
                    if message.callId != nil { CallRelayLine() }
                    // M18: what the assistant passed on from the chat into this task's thread (tell_task).
                    if payload.isForwardedFromChat { ForwardedLine() }
                    receipt
                }
            } else {
                VStack(alignment: .leading, spacing: Metrics.bubbleSpacing) {
                    if let result = payload.taskResult {
                        // M18: a done task's result, "Done · title" above it and a footer that
                        // opens the task (Chat/TaskResultBubble.swift).
                        TaskResultHeader(result: result)
                        TaskResultBubble(
                            messageId: message.id, text: message.text, result: result, streaming: streaming,
                            accessibilityLabel: Text("OpenDuet, \(time)"), accessibilityText: plainText
                        ) { actions.tasks.open(result.taskId) }
                            .bubbleMenu(message, actions: actions.chatExtras, reply: reply)
                            .messageReactions(message, actions: actions.chatExtras, alignment: .leading)
                    } else if !message.text.isEmpty {
                        AssistantBubble(text: message.text, streaming: streaming)
                            .bubbleAccessibility(label: Text("OpenDuet, \(time)"), value: Text(verbatim: plainText))
                            // M9: the bubble menu (emoji bar, Reply, Copy, Select text, Share,
                            // Good / Bad response) on a long press.
                            .bubbleMenu(message, actions: actions.chatExtras, reply: reply)
                            .messageReactions(message, actions: actions.chatExtras, alignment: .leading)
                    }
                    ForEach(payload.attachments) { file in
                        if file.isImage { ImageBubble(file: file) } else { FileCard(file: file) { open(file) } }
                    }
                    // M23: the morning brief names the sources it couldn't read, so it never
                    // reads as "nothing new" for an app it didn't check.
                    if let unchecked = payload.brief?.unchecked, let line = BriefUncheckedLine.text(unchecked, locale: locale) {
                        BriefUncheckedLine(text: line)
                    }
                    // M10: the user stopped this reply; what had arrived stays, quietly marked.
                    if message.stopped {
                        StoppedLine().transition(.opacity)
                    }
                }
                .animation(.easeInOut(duration: 0.25), value: message.stopped)
            }
        case .image(let payload):
            fileStack(alignment: message.role == .user ? .trailing : .leading) {
                ImageBubble(file: payload.file)
                if !payload.caption.isEmpty { caption(payload.caption) }
            }
        case .file(let payload):
            fileStack(alignment: message.role == .user ? .trailing : .leading) {
                FileCard(file: payload.file, caption: payload.caption) { open(payload.file) }
            }
        case .quickReplies(let payload):
            // M23 (L105): the question's bubble, then one card of options (Chat/QuickReplies.swift).
            if !message.text.isEmpty || !payload.options.isEmpty {
                // M21: an earlier turn's options stay as they were but take no taps (layout.stale).
                QuickReplyBubble(
                    text: message.text, streaming: streaming, options: payload.options, chosen: payload.chosen,
                    stale: layout.stale,
                    accessibilityLabel: Text("OpenDuet, \(time)"), accessibilityText: plainText, onReply: reply
                ) { option in
                    actions.quickReply(message.id, option)
                    onSent()
                }
            }
        case .system(let phrase):
            SystemLine(phrase: phrase)
        case .usageLimit(let resumesAt):
            UsageLimitLine(resumesAt: resumesAt, onGetMore: actions.openUsage)
        case .taskSpawn(let payload):
            // M22 (L102): a plain task row on the assistant's side, under the last paragraph of the turn.
            TaskSpawnChip(task: payload.task) { actions.tasks.open(payload.task.id) }
        case .taskSuggestions(let payload):
            TaskSuggestionsCard(message: message, items: payload.items, streaming: streaming, onStart: { itemId in
                actions.cards.action(message.id, .start, itemId)
            }, onSent: onSent)
        case .proactiveSuggestion(let payload):
            ProactiveSuggestionCard(
                message: message, payload: payload, streaming: streaming,
                onStart: { actions.cards.action(message.id, .start, nil) },
                onHide: { actions.cards.action(message.id, .hide, nil) },
                onOpenTask: { actions.tasks.open($0) },
                onSent: onSent
            )
        case .approval(let approval):
            ApprovalCard(message: message, approval: approval, actions: actions.cards, onOpenRoute: actions.openRoute, onSent: onSent)
        case .confirmation(let payload):
            ConfirmationCard(message: message, payload: payload)
        case .alert(let payload):
            AlertCard(message: message, payload: payload, onAction: actions.cards.openAlert)
        case .plate(let payload):
            PlateCard(message: message, payload: payload) { prompt in
                actions.cards.sendText(prompt)
                onSent()
            }
        // M6: the assistant's computer (Chat/Cards/ComputerCards.swift) and Make and chat extras
        // (Chat/Cards/MakeCards.swift).
        case .liveBrowser(let payload):
            LiveBrowserCard(message: message, payload: payload, actions: actions, onSent: onSent)
        case .signIn(let payload):
            SignInCard(message: message, payload: payload, actions: actions, onSent: onSent)
        case .artifact(let payload):
            ArtifactCard(message: message, payload: payload, actions: actions, onSent: onSent)
        case .skillProposal(let payload):
            SkillProposalCard(message: message, payload: payload, actions: actions, onSent: onSent)
        case .spendRequest(let spend):
            SpendRequestCard(message: message, spend: spend, actions: actions, onSent: onSent)
        // M9: the assistant's form card (ask_form) and generic info card (show_card), Chat/Cards/.
        case .form(let payload):
            FormCardView(message: message, payload: payload, streaming: streaming, actions: actions, onSent: onSent)
        case .card(let payload):
            DuetCardView(message: message, payload: payload, streaming: streaming, actions: actions, onSent: onSent)
        // M11: the memory chip, the soul proposal and the connection request (Chat/Cards/).
        case .memoryNote(let payload):
            MemoryNoteChip(message: message, payload: payload, actions: actions)
        case .soulProposal(let payload):
            SoulProposalCard(message: message, payload: payload, actions: actions, onSent: onSent)
        case .connectionRequest(let payload):
            ConnectionRequestCard(message: message, payload: payload, actions: actions, onSent: onSent)
        // M12: a turn the model couldn't answer (Chat/Cards/ModelErrorCard.swift).
        case .modelError(let payload):
            ModelErrorCard(message: message, payload: payload, actions: actions)
        // M13: a finished voice call, one quiet row (Chat/Call/CallLineRow.swift).
        case .call(let payload):
            CallLineRow(payload: payload)
        // M22: the end of setting up "who OpenDuet is" in the chat (Chat/Cards/SoulSetupCard.swift).
        case .soulSetup(let payload):
            SoulSetupCard(message: message, payload: payload, actions: actions, onSent: onSent)
        case .unsupported:
            // A kind from a newer server.
            PlaceholderCard(message: message, streaming: streaming)
        }
    }

    /// The assistant's words quoted in this thread's composer (M8 quote reply); nil for the user's.
    /// M10: the quote (a markdown parse) is cut when used, not on every render of a streaming row.
    private var reply: (() -> Void)? {
        guard BubbleQuote.quotable(message) else { return nil }
        let message = message
        let setReplyTo = actions.setReplyTo
        return { setReplyTo(BubbleQuote.make(message)) }
    }

    /// M19: one cached format style (ChatTimeFormat), not a new one per row per pass.
    private var time: String {
        ChatTimeFormat.time(message.createdAt, locale: locale)
    }

    /// What VoiceOver reads for an assistant bubble: the text without markdown markers. M19: from the
    /// parse the bubble draws (MarkdownCache), joined once per text instead of parsed every pass.
    private var plainText: String {
        MarkdownCache.plainText(message.text, streaming: streaming)
    }

    @ViewBuilder
    private var receipt: some View {
        if let status = layout.receipt {
            ReceiptLine(status: status).transition(.opacity)
        }
    }

    private func fileStack<Content: View>(alignment: HorizontalAlignment, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: alignment, spacing: 4) {
            content()
            if message.role == .user { receipt }
        }
        .padding(.trailing, message.role == .user ? UserBubbleShape.tailWidth : 0)
    }

    private func caption(_ text: String) -> some View {
        Text(verbatim: text)
            .font(Typography.caption)
            .foregroundStyle(Palette.secondaryText)
            .padding(.horizontal, 4)
    }

    private func open(_ file: ChannelFile) {
        if let url = URL(string: "duet://files/\(file.id)") { actions.openRoute(url) }
    }
}

/// M15: "Passed on during a call" in small grey under a message the voice handed to the assistant.
private struct CallRelayLine: View {
    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 12

    var body: some View {
        HStack(spacing: 4) {
            DuetIcon(glyph: .voice, size: fontSize, tint: Palette.secondaryText).accessibilityHidden(true)
            Text("Passed on during a call")
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.secondaryText)
        }
        .padding(.trailing, UserBubbleShape.tailWidth + 4)
    }
}

/// M18: "From chat" in small grey under a user message the assistant passed on into a task's thread.
private struct ForwardedLine: View {
    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 12

    var body: some View {
        Text("From chat")
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.secondaryText)
            .padding(.trailing, UserBubbleShape.tailWidth + 4)
    }
}

/// M23: "Couldn't check Gmail" in small grey under the morning brief (TextPayload.brief.unchecked),
/// the apps joined for the current language ("Gmail and Google Calendar", "Gmail和Google Calendar").
struct BriefUncheckedLine: View {
    var text: String

    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 12

    var body: some View {
        let lift = fontSize * 0.3
        return HStack(alignment: .firstTextBaseline, spacing: 4) {
            DuetIcon(glyph: .info, size: fontSize + 1, tint: Palette.secondaryText)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
                .accessibilityHidden(true)
            Text(verbatim: text)
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 6)
        .accessibilityElement(children: .combine)
    }

    /// nil when every source was read (or the names are blank).
    static func text(_ unchecked: [String], locale: Locale) -> String? {
        var seen: Set<String> = []
        let apps = unchecked
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
        guard !apps.isEmpty else { return nil }
        let formatter = ListFormatter()
        formatter.locale = locale
        let list = formatter.string(from: apps) ?? apps.joined(separator: ", ")
        return String(localized: "Couldn't check \(list)", locale: locale)
    }
}

/// M10 (contract §1): "Stopped" in small grey under a reply the user stopped mid-stream.
private struct StoppedLine: View {
    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 12

    var body: some View {
        Text("Stopped")
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.secondaryText)
            .padding(.leading, 6)
    }
}
