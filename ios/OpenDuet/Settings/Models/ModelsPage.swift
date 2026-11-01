// M12 Models (M16: pushed from the settings, the profile sheet): the Defaults (default model, default thinking, background model),
// the providers with their key and status, the chat models grouped by provider and Add
// provider. M27: realtime voice models aren't listed here (the Voice page adds and picks them),
// on an older server too. GET /api/models through `\.apiClient` (the ModelsModel the settings
// own). The pages it opens: ModelsRoute.
import SwiftUI

/// M16: the settings' "Models" row (the profile sheet's OpenDuet card): the default model, or a
/// warning while none is set up.
struct SettingsModelsRow: View {
    var models: ModelsModel
    var onOpen: () -> Void

    var body: some View {
        SheetRow(title: Text("Models"), subtitle: line, action: onOpen) {
            RowSymbol(systemImage: "cpu")
        } trailing: {
            HStack(spacing: 8) {
                if models.state.value?.configured == false {
                    DuetIcon(glyph: .warning, size: 17, tint: Palette.needsInput)
                        .accessibilityLabel(Text("No model set up yet"))
                }
                RowChevron()
            }
        }
    }

    private var line: Text? {
        guard let state = models.state.value else { return nil }
        guard state.configured, let model = ModelCatalog.defaultModel(state) else { return Text("No model set up yet") }
        return Text("Default: \(model.label)")
    }
}

struct ModelsPage: View {
    var models: ModelsModel
    var leading: SheetHeaderLeading = .back
    var onLeading: () -> Void
    var onOpen: (ModelsRoute) -> Void

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Models"), leading: leading, onLeading: onLeading)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    switch models.state.display {
                    case .loading:
                        SettingsRowsSkeleton(rows: 3)
                    case .failed(let reason):
                        InlineRetryLine(reason: reason) { Task { await models.load() } }
                            .cardSurface()
                    case .loaded(let state):
                        content(state)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .refreshable { await models.load() }
        }
    }

    @ViewBuilder private func content(_ state: ModelsState) -> some View {
        if !state.configured {
            notConfigured(state)
        }
        if !ModelCatalog.chatModels(state).isEmpty {
            ModelDefaultsCard(models: models, state: state)
        }
        ModelProvidersSection(state: state, onOpen: onOpen)
        ModelListSection(state: state, onOpen: onOpen)
        SettingsNote(text: Text("Keys go straight to your server's vault. OpenDuet and this phone never see them again."))
    }

    private func notConfigured(_ state: ModelsState) -> some View {
        HStack(alignment: .top, spacing: 10) {
            DuetIcon(glyph: .warning, size: 18, tint: Palette.needsInput)
            VStack(alignment: .leading, spacing: 4) {
                Text("No model set up yet")
                    .font(.system(.body, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                (state.providers.isEmpty
                 ? Text("OpenDuet needs a model to reply. Add a provider with its key, then pick its models.")
                 : Text("OpenDuet needs a chat model with tools from a provider that has a key."))
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
        .cardSurface()
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Defaults

struct ModelDefaultsCard: View {
    var models: ModelsModel
    var state: ModelsState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Defaults"))
            CardSection {
                InlineChoiceRow(
                    title: Text("Default model"),
                    current: defaultModelText,
                    options: DefaultsRules.modelOptions(state).map { modelOption($0) },
                    selection: state.defaults.defaultModelId,
                    busy: models.defaultsBusy,
                    onSelect: { id in set(UpdateModelDefaultsRequest(defaultModelId: Patch(id))) }
                )
                InlineChoiceRow(
                    title: Text("Default thinking"),
                    current: state.defaults.defaultThinking.map { Text($0.label) } ?? Text("Automatic"),
                    options: ModelsRoute.thinkingOptions(DefaultsRules.thinkingOptions(state), none: Text("Automatic")),
                    selection: state.defaults.defaultThinking,
                    busy: models.defaultsBusy,
                    onSelect: { level in set(UpdateModelDefaultsRequest(defaultThinking: Patch(level))) }
                )
                InlineChoiceRow(
                    title: Text("Background model"),
                    current: backgroundText,
                    options: [ChoiceOption(value: nil, title: Text("Same as default"))]
                        + DefaultsRules.backgroundOptions(state).map { modelOption($0) },
                    selection: state.defaults.utilityModelId,
                    busy: models.defaultsBusy,
                    onSelect: { id in set(UpdateModelDefaultsRequest(utilityModelId: Patch(id))) }
                )
            }
            if let failure = models.defaultsFailure {
                SettingsReasonLine(reason: failure)
                    .padding(.horizontal, 6)
                    .padding(.top, 8)
            }
            SettingsNote(text: Text("The background model writes titles, summaries and memory. Thinking applies when the model supports it."))
                .padding(.top, 8)
        }
        .animation(.easeInOut(duration: 0.2), value: models.defaultsFailure)
        .sensoryFeedback(.warning, trigger: models.defaultsFailure) { _, new in new != nil }
    }

    private var defaultModelText: Text {
        guard let model = ModelCatalog.defaultModel(state) else { return Text("Not set") }
        return Text(verbatim: model.label)
    }

    private var backgroundText: Text {
        guard let model = ModelCatalog.model(state.defaults.utilityModelId, in: state) else { return Text("Same as default") }
        return Text(verbatim: model.label)
    }

    private func modelOption(_ model: ModelEntry) -> ChoiceOption<String?> {
        let provider = ModelCatalog.provider(model.providerId, in: state)
        return ChoiceOption(value: model.id, title: Text(verbatim: model.label), subtitle: provider.map { Text(verbatim: $0.name) })
    }

    private func set(_ body: UpdateModelDefaultsRequest) {
        Task { await models.setDefaults(body) }
    }
}

// MARK: - Providers

struct ModelProvidersSection: View {
    var state: ModelsState
    var onOpen: (ModelsRoute) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Providers"))
            CardSection(dividerInset: Metrics.settingsTileInset) {
                ForEach(state.providers) { provider in
                    ModelProviderRow(provider: provider, chatModels: ModelCatalog.chatModels(of: provider.id, in: state).count) {
                        onOpen(.provider(provider.id))
                    }
                }
                SheetRow(
                    title: Text("Add provider"),
                    subtitle: state.providers.isEmpty ? Text("OpenAI, Anthropic, Google Gemini, StepFun or your own") : nil,
                    action: { onOpen(.addProvider) },
                    leading: { RowSymbol(systemImage: "plus", tint: Palette.secondaryText) },
                    trailing: { RowChevron() }
                )
            }
        }
        .animation(.easeInOut(duration: 0.2), value: state.providers.map(\.id))
    }
}

struct ModelProviderRow: View {
    var provider: ModelProvider
    /// M27: its chat models only (a Gemini / StepFun provider's realtime ones are on Voice)
    var chatModels: Int
    var onOpen: () -> Void

    var body: some View {
        SheetRow(
            title: Text(verbatim: provider.name),
            subtitle: subtitle,
            action: onOpen,
            leading: { ProviderTile(name: provider.name) },
            trailing: {
                HStack(spacing: 8) {
                    if provider.status == .failed {
                        DuetIcon(glyph: .warning, size: 17, tint: Palette.failure)
                            .accessibilityLabel(Text("Can't connect"))
                    }
                    RowChevron()
                }
            }
        )
    }

    private var subtitle: Text {
        if let failure = ProviderCopy.failure(provider) {
            return Text(verbatim: failure).foregroundStyle(Palette.failure)
        }
        let parts = [String(localized: ProviderCopy.keyLine(provider.key)), String(localized: ProviderCopy.modelCount(chatModels))]
        return Text(verbatim: parts.joined(separator: " · "))
    }
}

// MARK: - Models

struct ModelListSection: View {
    var state: ModelsState
    var onOpen: (ModelsRoute) -> Void

    var body: some View {
        let chat = ModelCatalog.groups(ModelCatalog.chatModels(state), in: state)
        VStack(alignment: .leading, spacing: 18) {
            ForEach(chat) { group in
                VStack(alignment: .leading, spacing: 0) {
                    SheetSectionTitle(text: Text(verbatim: group.provider.name))
                    CardSection {
                        ForEach(group.models) { model in
                            ModelEntryRow(model: model, state: state) { onOpen(.model(model.id)) }
                        }
                    }
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: state.models.map(\.id))
    }
}

struct ModelEntryRow: View {
    var model: ModelEntry
    var state: ModelsState
    var onOpen: () -> Void

    @ScaledMetric(relativeTo: .footnote) private var idSize: CGFloat = 12.5

    var body: some View {
        SheetRow(title: Text(verbatim: model.label), subtitle: subtitle, action: onOpen) {
            HStack(spacing: 8) {
                if state.defaults.defaultModelId == model.id {
                    ModelsTag(text: Text("Default"), accent: true)
                }
                RowChevron()
            }
        }
    }

    private var subtitle: Text {
        if model.purpose == .chat, !model.tools {
            return Text("No tools: OpenDuet can't chat with it")
        }
        if model.purpose == .chat, ModelCatalog.provider(model.providerId, in: state)?.key.set != true {
            return Text("Its provider has no key")
        }
        return Text(verbatim: model.modelId).font(.system(size: idSize, design: .monospaced))
    }
}
