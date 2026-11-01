// M12 a provider's page: its status ("Can't connect: <error>") with "Check again", its models
// with "Add models", the edit form (name, a new key in a SecureField, base URL, how the key is
// sent, headers; blank key keeps the one in the vault) and Delete (asks in place; a 409 reason
// stays inline). M27: chat models only (realtime ones are on Voice); StepFun's Region (saved at
// once, the key checked against the new site); no Base URL for Gemini / StepFun (a proxy set
// before M27 shows read-only).
import SwiftUI

struct ProviderDetailPage: View {
    var models: ModelsModel
    var providerId: String
    /// M27: the regions and their hosts (VoiceSettings.presets; empty on an older server)
    var presets: [VoiceProviderPreset] = []
    var onBack: () -> Void
    var onOpen: (ModelsRoute) -> Void

    /// kept while the page pops after Delete (the provider is gone from the list by then)
    @State private var last: ModelProvider?
    @State private var checking = false
    @State private var checkFailure: String?
    @State private var deleting = false
    @State private var deleteFailure: String?
    @State private var regionBusy = false
    @State private var regionFailure: String?

    private var provider: ModelProvider? { models.provider(providerId) ?? last }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: provider.map { Text(verbatim: $0.name) }, leading: .back, onLeading: onBack)
            ScrollView {
                if let provider, let state = models.state.value {
                    VStack(alignment: .leading, spacing: 22) {
                        status(provider)
                        if !regions(provider).isEmpty { regionCard(provider) }
                        modelsCard(provider, state: state)
                        ProviderEditSection(models: models, provider: provider, regions: regions(provider))
                            .id(provider.id)
                        delete(provider)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 32)
                } else {
                    SettingsRowsSkeleton(rows: 2).padding(16)
                }
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .onChange(of: models.provider(providerId), initial: true) { _, provider in
            if let provider { last = provider }
        }
    }

    // MARK: - Status

    private func status(_ provider: ModelProvider) -> some View {
        let active = provider.status == .active
        return VStack(alignment: .leading, spacing: 8) {
            CardSection(dividerInset: Metrics.settingsTileInset) {
                statusRow(provider)
                checkRow
            }
            if let checkFailure {
                SettingsReasonLine(reason: checkFailure).padding(.horizontal, 6)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: active)
        .sensoryFeedback(.warning, trigger: checkFailure) { (_: String?, new: String?) in new != nil }
        .sensoryFeedback(.success, trigger: active) { (old: Bool, new: Bool) in !old && new }
    }

    private func statusRow(_ provider: ModelProvider) -> some View {
        let failed = provider.status == .failed
        let title = failed ? Text("Can't connect") : Text("Connected")
        return SheetRow(title: title, subtitle: statusLine(provider), action: nil) {
            ProviderTile(name: provider.name)
        } trailing: {
            if failed {
                DuetIcon(glyph: .warning, size: 17, tint: Palette.failure).accessibilityHidden(true)
            }
        }
    }

    private var checkRow: some View {
        let action: (() -> Void)? = checking ? nil : { check() }
        return SheetRow(title: Text("Check again"), subtitle: Text("Tries the key against the provider"), action: action) {
            RowSymbol(systemImage: "arrow.clockwise", tint: Palette.secondaryText)
        } trailing: {
            BusySpinner(busy: checking)
        }
    }

    private func statusLine(_ provider: ModelProvider) -> Text {
        if provider.status == .failed {
            let reason = provider.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !reason.isEmpty { return Text(verbatim: reason).foregroundStyle(Palette.failure) }
        }
        let parts = [String(localized: provider.wireProtocol.label), ProviderCopy.address(provider.baseUrl), String(localized: ProviderCopy.keyLine(provider.key))]
        return Text(verbatim: parts.joined(separator: " · "))
    }

    private func check() {
        checking = true
        checkFailure = nil
        Task {
            do { try await models.testProvider(providerId) } catch { checkFailure = SettingsReason.line(for: error) }
            checking = false
        }
    }

    // MARK: - Models

    /// M27: chat models only (a Gemini / StepFun provider's realtime ones are added on Voice).
    private func modelsCard(_ provider: ModelProvider, state: ModelsState) -> some View {
        let chat = ModelCatalog.chatModels(of: provider.id, in: state)
        return VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Models"))
            CardSection {
                ForEach(chat) { model in
                    ModelEntryRow(model: model, state: state) { onOpen(.model(model.id)) }
                }
                SheetRow(
                    title: Text("Add models"),
                    subtitle: chat.isEmpty ? Text("Pick from the models this provider offers") : nil,
                    action: { onOpen(.remoteModels(provider.id)) },
                    leading: { RowSymbol(systemImage: "plus", tint: Palette.secondaryText) },
                    trailing: { RowChevron() }
                )
            }
        }
        .animation(.easeInOut(duration: 0.2), value: chat.map(\.id))
    }

    // MARK: - Region (StepFun)

    private func regions(_ provider: ModelProvider) -> [ProviderRegionOption] {
        ProviderRegionRules.options(for: provider.kind, presets: presets)
    }

    /// Saved at once: the server checks the saved key against the new site (nothing changes when
    /// it's refused; a key for the other site says so).
    private func regionCard(_ provider: ModelProvider) -> some View {
        let saved = provider.region ?? .cn
        return VStack(alignment: .leading, spacing: 8) {
            CardSection {
                ProviderRegionRow(
                    options: regions(provider), selection: saved, busy: regionBusy, failure: regionFailure,
                    onSelect: { region in setRegion(region, provider: provider) }
                )
            }
            SettingsNote(text: Text("Changing it checks the saved key against the other site."))
        }
    }

    private func setRegion(_ region: ProviderRegion, provider: ModelProvider) {
        regionBusy = true
        regionFailure = nil
        Task {
            do {
                try await models.updateProvider(provider.id, UpdateModelProviderRequest(region: region))
            } catch {
                if let wrong = ProviderRegionRules.wrongSite(error, tried: region, saved: provider.region ?? .cn) {
                    regionFailure = ProviderRegionRules.wrongSiteText(wrong)
                } else {
                    regionFailure = SettingsReason.line(for: error)
                }
            }
            regionBusy = false
        }
    }

    // MARK: - Delete

    private func delete(_ provider: ModelProvider) -> some View {
        InlineConfirm(
            title: Text("Delete provider"),
            question: Text("Delete \(provider.name)? Its key and its models are removed. Channels that used them go back to the default model."),
            confirmTitle: Text("Delete"),
            busy: deleting,
            failure: deleteFailure,
            onConfirm: { remove() }
        )
        .cardSurface()
    }

    private func remove() {
        deleting = true
        deleteFailure = nil
        Task {
            do {
                try await models.deleteProvider(providerId)
                onBack()
            } catch {
                deleteFailure = ModelsReason.deleteLine(error)
            }
            deleting = false
        }
    }
}

/// "Edit": name, a new key, base URL, how the key is sent, headers. Save sends only what changed.
struct ProviderEditSection: View {
    var models: ModelsModel
    var provider: ModelProvider
    /// M27: the kind's regions (a proxy is told apart from its region's own host)
    var regions: [ProviderRegionOption]

    @State private var draft: ProviderEditDraft
    @State private var saving = false
    @State private var saved = false
    @State private var failure: String?
    @State private var keyDropped = false
    /// the save in flight makes the server check the provider again
    @State private var checksKey = false

    init(models: ModelsModel, provider: ModelProvider, regions: [ProviderRegionOption] = []) {
        self.models = models
        self.provider = provider
        self.regions = regions
        _draft = State(initialValue: ProviderEditDraft(provider))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 0) {
                SheetSectionTitle(text: Text("Edit"))
                CardSection {
                    SettingsField(
                        label: Text("Name"), text: $draft.name, prompt: Text("Required"),
                        limit: ProviderFormRules.nameLimit,
                        problem: draft.problems.contains(.name) ? Text("Between 1 and 60 characters.") : nil
                    )
                    SettingsSecretField(
                        label: Text("New API key"), text: $draft.key, prompt: Text("Leave blank to keep it"),
                        footnote: draft.problems.contains(.keyForNewURL)
                            ? Text("A new address needs the key again: the saved one is never sent to a different address.")
                            : Text(ProviderCopy.keyLine(provider.key))
                    )
                    if draft.showsBaseURL {
                        SettingsField(
                            label: Text("Base URL"), text: $draft.baseUrl, prompt: Text(verbatim: "https://llm.example.com/v1"),
                            limit: ProviderFormRules.urlLimit, plain: true, keyboard: .URL,
                            problem: ProviderFormCopy.urlProblem(draft.problems),
                            footnote: provider.kind == .custom ? nil : Text("Change it only to go through your own proxy.")
                        )
                    } else if ProviderFormLayout.isProxy(provider, regions: regions) {
                        SheetRow(
                            title: Text("Address"),
                            subtitle: Text(verbatim: provider.baseUrl).font(.system(size: 13, design: .monospaced)),
                            action: nil
                        ) {
                            EmptyView()
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .disabled(saving)
                if !draft.showsBaseURL, ProviderFormLayout.isProxy(provider, regions: regions) {
                    SettingsNote(text: Text("A proxy set before regions came in. It stays as it is."))
                        .padding(.top, 8)
                }
            }
            if draft.asksAuth {
                VStack(alignment: .leading, spacing: 10) {
                    SheetSectionTitle(text: Text("Send the key as"))
                        .padding(.bottom, -6)
                    SettingsSegmented(
                        options: ProviderAuth.allCases.map { ($0, Text($0.label)) },
                        selection: draft.auth, disabled: saving,
                        onSelect: { draft.auth = $0 }
                    )
                }
            }
            ProviderHeaderFields(headers: $draft.headers, disabled: saving)
            SettingsSaveRow(
                busy: saving, enabled: draft.request != nil, saved: saved,
                failure: failure, status: status, onSave: save
            )
        }
        .onChange(of: draft.request) { _, new in if new != nil { saved = false } }
        .onChange(of: provider) { _, fresh in
            // A newer copy (Check again, an event): taken unless the user is editing.
            if !saving, draft.request == nil { draft = ProviderEditDraft(fresh) }
        }
    }

    private var status: Text? {
        if saving { return checksKey ? Text("Checking the key…") : nil }
        if keyDropped, failure != nil { return Text("Paste the key again to retry.") }
        return nil
    }

    private func save() {
        guard let body = draft.request else { return }
        let sendsKey = body.key != nil
        checksKey = draft.rechecks
        // Sent once: the new key leaves this page's state now.
        draft.dropSecrets()
        saving = true
        failure = nil
        keyDropped = false
        Task {
            do {
                try await models.updateProvider(provider.id, body)
                if let fresh = models.provider(provider.id) { draft = ProviderEditDraft(fresh) }
                saving = false
                saved = true
            } catch {
                failure = SettingsReason.line(for: error)
                keyDropped = sendsKey
                saving = false
            }
        }
    }
}
