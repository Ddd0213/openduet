// M11 "Who OpenDuet is" (the soul, Everything) and a channel's "Here, OpenDuet also…" (soulExtra):
// the user's own description of how the assistant should be. Save sends only what changed (PUT /api/soul,
// PATCH /api/channels/:id); the server's reason shows inline on failure. The assistant can only propose
// a change in chat; nothing changes until the user taps Apply there.
// M22: "Set up in chat" (POST /api/soul/intro) starts the chat setup in the main thread; the sheet
// closes and the chat opens there (`onOpenChat`, the channel from the response). The soul loads
// again when the page appears (the settings sheet keeps its model between presentations) and
// after a soul_setup card's Apply (SoulRevision).
import SwiftUI

struct SoulPage: View {
    var model: EverythingModel
    var onBack: () -> Void
    /// M22: closes the sheet and opens this channel link (nil: no "Set up in chat" row)
    var onOpenChat: ((URL) -> Void)? = nil

    @State private var draft = SoulDraft()
    @State private var base: Soul?
    @State private var busy = false
    @State private var failure: String?
    @State private var saved = false
    @State private var introBusy = false
    @State private var introFailure: String?
    @Environment(\.apiClient) private var api

    private var soul: Soul? { model.soul.value }
    private var dirty: Bool { base.map { draft.request(from: $0) != nil } ?? false }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Who OpenDuet is"), leading: .back, onLeading: onBack)
            ScrollView {
                content
                    .padding(.horizontal, 16)
                    .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .onChange(of: soul, initial: true) { _, soul in
            guard let soul, !dirty else { return }
            draft = SoulDraft(soul)
            base = soul
        }
        .onChange(of: draft) { _, _ in if dirty { saved = false } }
        .task { await reloadIfStale() }
        .onChange(of: SoulRevision.shared.count) { _, _ in
            Task {
                await model.loadSoul()
                SoulRevision.shared.markSeen(model)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: introFailure)
        .sensoryFeedback(.warning, trigger: introFailure) { _, new in new != nil }
    }

    /// On appear: the soul again when this model hasn't seen the latest Apply (or has none yet).
    /// Attaches the client first (a no-op when the sheet already did): a link can open the page
    /// before the sheet's own task ran.
    private func reloadIfStale() async {
        model.attach(api)
        let revision = SoulRevision.shared
        guard model.soul.value == nil || revision.isStale(model) else { return }
        if !model.soul.loading { await model.loadSoul() }
        revision.markSeen(model)
    }

    @ViewBuilder private var content: some View {
        switch model.soul.display {
        case .loading:
            MemorySkeleton().padding(.top, 8)
        case .failed(let reason):
            InlineRetryLine(reason: reason) { Task { await model.loadSoul() } }
        case .loaded:
            VStack(alignment: .leading, spacing: 14) {
                SettingsNote(text: Text("How OpenDuet talks with you, in your own words. Leave a field empty for the default."))
                if onOpenChat != nil { setUpInChat }
                CardSection {
                    field(.name, label: Text("Name in replies"), prompt: Text(verbatim: "OpenDuet"))
                    field(.addressAs, label: Text("How to address you"), prompt: Text("Your first name"))
                    field(.identity, label: Text("Who OpenDuet is"), prompt: Text("Who OpenDuet is for you, in a sentence or two"))
                    field(.persona, label: Text("Persona"), prompt: Text("Character and habits"))
                    field(.tone, label: Text("Tone"), prompt: Text("Warm and brief, plain words"))
                }
                SettingsNote(text: Text("This shapes how OpenDuet talks, not what it may do: it still asks before acting for you. It can suggest a change in chat; nothing changes until you tap Apply."))
                SettingsSaveRow(busy: busy, enabled: dirty && draft.isValid, saved: saved && !dirty, failure: failure, status: nil, onSave: save)
            }
            .padding(.top, 4)
        }
    }

    /// M22: the assistant asks in the main thread (one question at a time) and ends with a card to Apply.
    private var setUpInChat: some View {
        let action: (() -> Void)? = introBusy ? nil : { startInChat() }
        return VStack(alignment: .leading, spacing: 0) {
            CardSection(dividerInset: Metrics.settingsTileInset) {
                SheetRow(
                    title: Text("Set up in chat"),
                    subtitle: Text("OpenDuet asks a few questions in the chat, then shows what it would save."),
                    action: action
                ) {
                    RowSymbol(systemImage: "bubble.left.and.bubble.right")
                } trailing: {
                    if introBusy { BusySpinner(busy: true) } else { RowChevron() }
                }
            }
            if let introFailure {
                SettingsReasonLine(reason: introFailure)
                    .padding(.horizontal, 6)
                    .padding(.top, 8)
                    .transition(.opacity)
            }
        }
    }

    private func startInChat() {
        guard !introBusy, let onOpenChat else { return }
        introBusy = true
        introFailure = nil
        Task {
            do {
                let started = try await model.client().startSoulIntro()
                if let url = URL(string: "duet://channels/\(started.channelId.pathSegment)") {
                    onOpenChat(url)
                }
            } catch {
                introFailure = SettingsReason.line(for: error)
            }
            introBusy = false
        }
    }

    private func field(_ field: SoulDraft.Field, label: Text, prompt: Text) -> some View {
        SettingsField(
            label: label, text: $draft[field], prompt: prompt, limit: field.limit,
            lines: field.multiline ? 2...8 : nil
        )
        .disabled(busy)
    }

    private func save() {
        guard let base, let body = draft.request(from: base) else { return }
        busy = true
        failure = nil
        Task {
            do {
                let sent = draft
                try await model.saveSoul(body)
                if let soul = model.soul.value {
                    if draft == sent { draft = SoulDraft(soul) }
                    self.base = soul
                }
                saved = true
            } catch {
                failure = SettingsReason.line(for: error)
            }
            busy = false
        }
    }
}

/// M22: bumped when a soul_setup card is applied in the chat, so a Who OpenDuet is page on screen
/// (or the settings sheet's kept model, the next time the page opens) loads the soul again.
@MainActor @Observable
final class SoulRevision {
    static let shared = SoulRevision()

    private(set) var count = 0
    /// the count each Everything model last loaded the soul at
    @ObservationIgnored private var seen: [ObjectIdentifier: Int] = [:]

    func applied() { count += 1 }

    func isStale(_ model: EverythingModel) -> Bool {
        (seen[ObjectIdentifier(model)] ?? 0) != count
    }

    func markSeen(_ model: EverythingModel) {
        seen[ObjectIdentifier(model)] = count
    }
}

/// A channel's "Here, OpenDuet also…": what the assistant should also be or do in this channel, on top of
/// "Who OpenDuet is".
struct SoulExtraPage: View {
    var model: ChannelSettingsModel
    var channelName: String
    var onBack: () -> Void

    static let limit = 4000

    @State private var draft = ""
    @State private var base: String?
    @State private var busy = false
    @State private var failure: String?
    @State private var saved = false

    private func clean(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var dirty: Bool { base.map { clean(draft) != clean($0) } ?? false }
    private var valid: Bool { clean(draft).utf16.count <= Self.limit }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Here, OpenDuet also…"), leading: .back, onLeading: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    SettingsNote(text: Text("Anything else OpenDuet should be or do in #\(channelName), on top of who it is everywhere."))
                    CardSection {
                        SettingsField(
                            label: Text("Here, OpenDuet also…"), text: $draft,
                            prompt: Text("Keeps answers short and checks the numbers twice"),
                            limit: Self.limit, lines: 3...12
                        )
                        .disabled(busy)
                    }
                    SettingsSaveRow(busy: busy, enabled: dirty && valid, saved: saved && !dirty, failure: failure, status: nil, onSave: save)
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .onChange(of: model.soulExtra, initial: true) { _, text in
            guard !dirty else { return }
            draft = text
            base = text
        }
        .onChange(of: draft) { _, _ in if dirty { saved = false } }
    }

    private func save() {
        let sent = draft
        busy = true
        failure = nil
        Task {
            do {
                try await model.saveSoulExtra(clean(sent))
                base = model.soulExtra
                if draft == sent { draft = model.soulExtra }
                saved = true
            } catch {
                failure = SettingsReason.line(for: error)
            }
            busy = false
        }
    }
}
