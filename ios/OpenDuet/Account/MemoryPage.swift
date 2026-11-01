// Profile > Memory (prompt L127) and, M11, every memory layer's page: "About you" in Everything,
// a channel's own memory in its OpenDuet sheet, and a channel's memory read-only from Everything.
// The document (Save once it changes: spinner, "Saved" with a success haptic, the reason on
// failure) and the facts with their source (MemoryFactsSection). The profile keeps its
// store-driven init; the M11 init takes a MemoryLayerModel that loads through `\.apiClient`.
import SwiftUI

struct MemoryPage: View {
    private enum Source {
        /// Profile > Memory: the store loads and saves the document (cardRequests[saveMemory])
        case store(phase: TasksState.Phase, memory: MemoryState?, request: CardRequest?, onLoad: () -> Void, onSave: (String) -> Void)
        case layer(MemoryLayerModel)
    }

    private let source: Source
    private let title: Text
    private let intro: Text
    private let readOnly: Bool
    private let linkChannelId: String?
    private let onOpenChannel: ((URL) -> Void)?
    private let onBack: () -> Void

    /// Profile > Memory.
    init(phase: TasksState.Phase, memory: MemoryState?, request: CardRequest?,
         onLoad: @escaping () -> Void, onSave: @escaping (String) -> Void, onBack: @escaping () -> Void) {
        source = .store(phase: phase, memory: memory, request: request, onLoad: onLoad, onSave: onSave)
        title = Text("Memory")
        intro = Text("What OpenDuet remembers about you. Edit anything that's wrong or out of date.")
        readOnly = false
        linkChannelId = nil
        onOpenChannel = nil
        self.onBack = onBack
    }

    /// M11: one layer. `readOnly` with `onOpenChannel`: a channel's memory seen from Everything
    /// ("Open channel", and its facts link to the channel's thread).
    init(model: MemoryLayerModel, title: Text, intro: Text, readOnly: Bool = false,
         linkChannelId: String? = nil, onOpenChannel: ((URL) -> Void)? = nil, onBack: @escaping () -> Void) {
        source = .layer(model)
        self.title = title
        self.intro = intro
        self.readOnly = readOnly
        self.linkChannelId = linkChannelId
        self.onOpenChannel = onOpenChannel
        self.onBack = onBack
    }

    @Environment(\.apiClient) private var api
    @Environment(\.locale) private var locale
    /// Profile > Memory's facts (the store loads the document; facts change through the API).
    @State private var storeFacts = MemoryLayerModel(layer: .aboutYou)
    @State private var draft = ""
    /// The document the draft started from (a newer server copy replaces an unedited draft).
    @State private var base: String?
    @State private var saved = false
    @State private var layerSaving = false
    @State private var layerFailure: String?
    @FocusState private var editing: Bool
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 16

    private var facts: MemoryLayerModel {
        if case .layer(let model) = source { model } else { storeFacts }
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: title, leading: .back, onLeading: onBack)
            ScrollView {
                content
                    .padding(.horizontal, 16)
                    .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear {
            facts.attach(api)
            load()
        }
        .onChange(of: storeMemory, initial: true) { _, memory in
            if let memory { storeFacts.seed(memory) }
        }
        .onChange(of: document, initial: true) { _, document in
            guard let document, !dirty else { return }
            draft = document
            base = document
        }
        .onChange(of: storeRequest) { old, new in
            guard old == .inFlight, new == nil else { return }
            base = draft
            saved = true
        }
        .onChange(of: draft) { _, _ in if dirty { saved = false } }
    }

    @ViewBuilder private var content: some View {
        if let reason = loadFailure, document == nil {
            InlineRetryLine(reason: reason, onRetry: load)
        } else if document == nil {
            MemorySkeleton()
        } else {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    SettingsNote(text: intro)
                    if let onOpenChannel, let url = FactList.channelRoute(linkChannelId) {
                        CapsuleButton(title: Text("Open channel"), style: .outline, fullWidth: false) { onOpenChannel(url) }
                    }
                    if readOnly {
                        readOnlyDocument
                    } else {
                        editor
                    }
                }
                MemoryFactsSection(model: facts, readOnly: readOnly, linkChannelId: linkChannelId, onOpenSource: onOpenChannel)
            }
            .padding(.top, 4)
        }
    }

    private var placeholder: Text {
        if case .layer(let model) = source, model.layer != .aboutYou {
            return Text("Nothing here yet. OpenDuet keeps notes about this channel as you work in it.")
        }
        return Text("Nothing here yet. OpenDuet adds what it learns about you as you work together.")
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                if draft.isEmpty {
                    placeholder
                        .font(.system(size: textSize))
                        .foregroundStyle(Palette.secondaryText)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 8)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                TextEditor(text: $draft)
                    .font(.system(size: textSize))
                    .foregroundStyle(Palette.primaryText)
                    .scrollContentBackground(.hidden)
                    .focused($editing)
                    .disabled(saving)
                    .accessibilityLabel(title)
            }
            .padding(12)
            .frame(minHeight: 160, maxHeight: 320)
            .cardSurface()
            SettingsSaveRow(busy: saving, enabled: dirty, saved: saved && !dirty, failure: saveFailure, status: updatedLine, onSave: save)
        }
    }

    private var readOnlyDocument: some View {
        Group {
            if draft.isEmpty {
                placeholder.foregroundStyle(Palette.secondaryText)
            } else {
                Text(verbatim: draft).foregroundStyle(Palette.primaryText).textSelection(.enabled)
            }
        }
        .font(.system(size: textSize))
        .fixedSize(horizontal: false, vertical: true)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }

    private var updatedLine: Text? {
        guard let updatedAt else { return nil }
        return Text("Updated \(ChatDateFormat(locale: locale).relativeDayAndTime(updatedAt))")
    }

    // MARK: - One source, two owners

    private var storeMemory: MemoryState? {
        if case .store(_, let memory, _, _, _) = source { memory } else { nil }
    }

    private var storeRequest: CardRequest? {
        if case .store(_, _, let request, _, _) = source { request } else { nil }
    }

    private var document: String? {
        switch source {
        case .store(_, let memory, _, _, _): memory?.document
        case .layer(let model): model.state.value?.document
        }
    }

    private var updatedAt: Date? {
        switch source {
        case .store(_, let memory, _, _, _): memory?.updatedAt
        case .layer(let model): model.state.value?.updatedAt
        }
    }

    private var loadFailure: String? {
        switch source {
        case .store(let phase, _, _, _, _): if case .failed(let reason) = phase { reason } else { nil }
        case .layer(let model): model.state.value == nil && !model.state.loading ? model.state.failure : nil
        }
    }

    private var saving: Bool {
        if case .store = source { storeRequest == .inFlight } else { layerSaving }
    }

    private var saveFailure: String? {
        if case .store = source { storeRequest?.failureReason } else { layerFailure }
    }

    private var dirty: Bool { base != nil && draft != base }

    private func load() {
        switch source {
        case .store(_, _, _, let onLoad, _): onLoad()
        case .layer(let model): Task { await model.load() }
        }
    }

    private func save() {
        editing = false
        switch source {
        case .store(_, _, _, _, let onSave):
            onSave(draft)
        case .layer(let model):
            let text = draft
            layerSaving = true
            layerFailure = nil
            Task {
                do {
                    try await model.saveDocument(text)
                    let stored = model.state.value?.document ?? text
                    base = stored
                    if draft == text { draft = stored }
                    saved = true
                } catch {
                    layerFailure = SettingsReason.line(for: error)
                }
                layerSaving = false
            }
        }
    }
}

/// Skeleton lines while a memory page loads.
struct MemorySkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(0..<6, id: \.self) { index in
                RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                    .frame(height: 13)
                    .padding(.trailing, CGFloat([30, 70, 10, 110, 50, 150][index]))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading memory"))
    }
}
