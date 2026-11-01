// M12 a model's editor: label, context window, max output; the thinking levels as chips in
// ladder order, the default level and (advanced) how thinking is sent; the tools / images / web
// search / prompt caching switches. Fields changed by hand before carry "Edited". Save sends only
// what changed (PATCH /api/models/:id); Delete asks in place (a 409 reason stays inline).
import SwiftUI

struct ModelDetailPage: View {
    var models: ModelsModel
    var modelId: String
    var onBack: () -> Void

    @State private var last: ModelEntry?

    private var model: ModelEntry? { models.model(modelId) ?? last }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: model.map { Text(verbatim: $0.label) }, leading: .back, onLeading: onBack)
            ScrollView {
                if let model {
                    ModelEditor(models: models, model: model, onDeleted: onBack)
                        .id(model.id)
                        .padding(.horizontal, 16)
                        .padding(.top, 4)
                        .padding(.bottom, 32)
                } else {
                    SettingsRowsSkeleton(rows: 3).padding(16)
                }
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .onChange(of: models.model(modelId), initial: true) { _, model in
            if let model { last = model }
        }
    }
}

struct ModelEditor: View {
    var models: ModelsModel
    var model: ModelEntry
    var onDeleted: () -> Void

    @State private var draft: ModelEditDraft
    @State private var saving = false
    @State private var saved = false
    @State private var failure: String?
    @State private var deleting = false
    @State private var deleteFailure: String?

    @ScaledMetric(relativeTo: .footnote) private var idSize: CGFloat = 13

    init(models: ModelsModel, model: ModelEntry, onDeleted: @escaping () -> Void) {
        self.models = models
        self.model = model
        self.onDeleted = onDeleted
        _draft = State(initialValue: ModelEditDraft(model))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            identity
            thinking
            capabilities
            SettingsSaveRow(busy: saving, enabled: draft.request != nil, saved: saved, failure: failure, status: nil, onSave: save)
            InlineConfirm(
                title: Text("Delete model"),
                question: Text("Delete \(model.label)? Channels that use it go back to the default model."),
                confirmTitle: Text("Delete"),
                busy: deleting,
                failure: deleteFailure,
                onConfirm: { remove() }
            )
            .cardSurface()
        }
        .disabled(saving)
        .onChange(of: draft.request) { _, new in if new != nil { saved = false } }
        .onChange(of: model) { _, fresh in
            if !saving, draft.request == nil { draft = ModelEditDraft(fresh) }
        }
    }

    private func edited(_ field: String) -> Text? {
        draft.wasEdited(field) ? Text("Edited") : nil
    }

    // MARK: - Name and sizes

    private var identity: some View {
        VStack(alignment: .leading, spacing: 8) {
            CardSection {
                SettingsField(
                    label: Text("Name"), text: $draft.label, prompt: Text("Required"),
                    limit: ModelEditDraft.labelLimit,
                    problem: draft.problems.contains(.label) ? Text("Between 1 and 80 characters.") : nil,
                    footnote: edited("label")
                )
                SettingsField(
                    label: Text("Context window"), text: $draft.contextWindow, prompt: Text(verbatim: "200000"),
                    plain: true, keyboard: .numberPad,
                    problem: draft.problems.contains(.contextWindow) ? Text("A number of tokens, like 200000.") : nil,
                    footnote: edited("contextWindow") ?? tokensNote(draft.contextWindow)
                )
                SettingsField(
                    label: Text("Max output"), text: $draft.maxOutputTokens, prompt: Text(verbatim: "8192"),
                    plain: true, keyboard: .numberPad,
                    problem: draft.problems.contains(.maxOutput) ? Text("A number of tokens, like 8192.") : nil,
                    footnote: edited("maxOutputTokens") ?? tokensNote(draft.maxOutputTokens)
                )
            }
            HStack(spacing: 6) {
                Text("Sent as")
                Text(verbatim: model.modelId).font(.system(size: idSize, design: .monospaced))
            }
            .font(.system(size: idSize))
            .foregroundStyle(Palette.secondaryText)
            .padding(.horizontal, 6)
            .accessibilityElement(children: .combine)
            if model.purpose == .realtime {
                SettingsNote(text: Text("A realtime voice model, for voice calls. It can't be picked for chat."))
            }
        }
    }

    private func tokensNote(_ text: String) -> Text? {
        ModelEditDraft.number(text).map { Text("\(ModelCatalog.tokens($0)) tokens") }
    }

    // MARK: - Thinking

    private var thinking: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SheetSectionTitle(text: Text("Thinking"))
                if draft.wasEdited("thinkingLevels") { ModelsTag(text: Text("Edited")).padding(.bottom, 6) }
            }
            .padding(.bottom, -6)
            SettingsNote(text: Text("The levels this model accepts. Pick none if it doesn't think."))
            LeadingFlowLayout(spacing: 8, lineSpacing: 8) {
                ForEach(ThinkingLevel.allCases, id: \.self) { level in
                    ThinkingChip(level: level, on: draft.isOn(level)) { draft.toggle(level) }
                }
            }
            .padding(.horizontal, 2)
            CardSection {
                InlineChoiceRow(
                    title: Text("Default thinking"),
                    current: draft.defaultThinking.map { Text($0.label) } ?? Text("Automatic"),
                    options: ModelsRoute.thinkingOptions(draft.levels, none: Text("Automatic")),
                    selection: draft.defaultThinking,
                    onSelect: { draft.setDefault($0) }
                )
            }
            .padding(.top, 4)
            SheetSectionTitle(text: Text("How thinking is sent (advanced)"))
                .padding(.top, 6)
                .padding(.bottom, -6)
            SettingsSegmented(
                options: ThinkingFormat.allCases.map { ($0, Text($0.label)) },
                selection: draft.thinkingFormat,
                onSelect: { draft.setFormat($0) }
            )
            SettingsNote(text: Text("Effort sends a level, Budget a number of tokens. Change it only if the provider refuses thinking."))
        }
        .animation(.easeInOut(duration: 0.2), value: draft.levels)
    }

    // MARK: - Capabilities

    private var capabilities: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("What it can do"))
            CardSection {
                SettingsToggleRow(
                    title: Text("Tools"),
                    subtitle: edited("tools") ?? Text("Needed to chat: OpenDuet works through tools"),
                    on: draft.tools, onChange: { draft.tools = $0 }
                )
                SettingsToggleRow(
                    title: Text("Images"), subtitle: edited("vision") ?? Text("Can look at photos and screenshots"),
                    on: draft.vision, onChange: { draft.vision = $0 }
                )
                SettingsToggleRow(
                    title: Text("Web search"), subtitle: edited("serverWebTools") ?? Text("The provider's own search and fetch"),
                    on: draft.serverWebTools, onChange: { draft.serverWebTools = $0 }
                )
                SettingsToggleRow(
                    title: Text("Prompt caching"), subtitle: edited("promptCaching") ?? Text("Cheaper repeated context"),
                    on: draft.promptCaching, onChange: { draft.promptCaching = $0 }
                )
            }
        }
    }

    // MARK: - Save and delete

    private func save() {
        guard let body = draft.request else { return }
        saving = true
        failure = nil
        Task {
            do {
                try await models.updateModel(model.id, body)
                if let fresh = models.model(model.id) { draft = ModelEditDraft(fresh) }
                saving = false
                saved = true
            } catch {
                failure = SettingsReason.line(for: error)
                saving = false
            }
        }
    }

    private func remove() {
        deleting = true
        deleteFailure = nil
        Task {
            do {
                try await models.deleteModel(model.id)
                onDeleted()
            } catch {
                deleteFailure = ModelsReason.deleteLine(error)
            }
            deleting = false
        }
    }
}

/// One level of the ladder: on (filled) or off (outline).
struct ThinkingChip: View {
    var level: ThinkingLevel
    var on: Bool
    var onToggle: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14

    var body: some View {
        Button(action: onToggle) {
            Text(level.label)
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundStyle(on ? Palette.primaryText : Palette.secondaryText)
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .background(Capsule().fill(on ? Palette.floatingSurface : Palette.tile))
                .overlay(Capsule().strokeBorder(on ? Palette.accent : Palette.cardBorder, lineWidth: on ? 1.5 : Metrics.hairline))
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.95))
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .sensoryFeedback(.selection, trigger: on)
    }
}
