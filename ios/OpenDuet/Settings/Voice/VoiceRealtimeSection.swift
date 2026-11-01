// M27 the Voice page's Realtime voice section, Codync's order: Provider (the user's Gemini /
// StepFun providers, "Add <kind>" for a kind with none), StepFun's Region (mainland China /
// international with its host; a change PATCHes the region and a key for the other site says so),
// the key (VoiceKeyArea), Model (added realtime models, then the provider's remote realtime rows:
// picking one adds it) and Voice (Default + the provider's own voices). Without a key Model and
// Voice are grey and can't be opened ("Add a key to choose from <name>'s models.").
import SwiftUI

struct VoiceRealtimeSection: View {
    var voice: VoiceSettingsModel
    var settings: VoiceSettings
    var choice: VoiceProviderChoice?
    var onPick: (VoiceProviderChoice) -> Void

    /// The region a provider being added will use (nil: the server's default for this phone)
    @State private var pendingRegion: ProviderRegion?
    @State private var regionBusy = false
    @State private var regionFailure: String?

    private var provider: VoiceProvider? { VoicePageRules.provider(choice, in: settings) }
    private var kind: VoiceEngineKind? { choice.flatMap { VoicePageRules.kind($0, in: settings) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Realtime voice"))
            if let choice, let kind {
                let layout = VoicePageRules.layout(choice, in: settings)
                VStack(alignment: .leading, spacing: 14) {
                    CardSection {
                        providerRow(choice)
                        if layout.rows.contains(.region) { regionRow(kind) }
                    }
                    VoiceKeyArea(
                        voice: voice, provider: provider, kind: kind, region: shownRegion(kind),
                        onAdded: { onPick(.add(kind)) }
                    )
                    .id(choice)
                    VStack(alignment: .leading, spacing: 8) {
                        CardSection {
                            modelRow(enabled: layout.choicesEnabled)
                            voiceRow(enabled: layout.choicesEnabled)
                        }
                        if let failure = voice.failure {
                            SettingsReasonLine(reason: failure)
                                .padding(.horizontal, 6)
                                .transition(.opacity)
                        }
                        if layout.showsKeyFootnote {
                            SettingsNote(text: Text(verbatim: VoicePageRules.keyFootnote(kind)))
                                .transition(.opacity)
                        }
                        SettingsNote(text: Text("The voice listens and speaks; OpenDuet does the work. Start a call with the waveform in a chat."))
                        if layout.showsStepNote {
                            SettingsNote(text: Text("StepFun has no short-lived keys, so during a call the phone holds this key in memory. Consider a separate key for OpenDuet."))
                        }
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: layout)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: voice.failure)
        .animation(.easeInOut(duration: 0.2), value: choice)
        .sensoryFeedback(.warning, trigger: voice.failure) { _, new in new != nil }
        // A remote list for the provider shown (with a key): the Model row's not-added rows.
        .task(id: provider.map { "\($0.id):\($0.key.set)" }) {
            guard let provider, provider.key.set else { return }
            await voice.loadRemote(provider.id)
        }
        .onChange(of: choice) { _, _ in regionFailure = nil }
    }

    // MARK: - Provider

    private func providerRow(_ choice: VoiceProviderChoice) -> some View {
        InlineChoiceRow(
            title: Text("Provider"),
            current: providerTitle(choice),
            options: VoicePageRules.providerChoices(settings).map { option in
                ChoiceOption(value: option, title: providerTitle(option), subtitle: providerLine(option))
            },
            selection: choice,
            busy: voice.busy,
            onSelect: pick
        )
    }

    private func providerTitle(_ choice: VoiceProviderChoice) -> Text {
        switch choice {
        case .existing(let id):
            Text(verbatim: settings.providers.first { $0.id == id }?.name ?? "")
        case .add(let kind):
            Text("Add \(String(localized: kind.title))")
        }
    }

    private func providerLine(_ choice: VoiceProviderChoice) -> Text? {
        guard let provider = VoicePageRules.provider(choice, in: settings) else { return nil }
        var parts: [String] = []
        if let region = provider.region { parts.append(String(localized: region.label)) }
        parts.append(String(localized: ProviderCopy.keyLine(provider.key)))
        return Text(verbatim: parts.joined(separator: " · "))
    }

    /// Picking a provider that can take calls switches calls to it (its first model).
    private func pick(_ next: VoiceProviderChoice) {
        onPick(next)
        regionFailure = nil
        let picked = VoicePageRules.provider(next, in: settings)
        guard let model = VoicePageRules.modelOnPick(picked, in: settings) else { return }
        Task { await voice.setModel(model) }
    }

    // MARK: - Region (StepFun)

    private func shownRegion(_ kind: VoiceEngineKind) -> ProviderRegion {
        if let region = provider?.region { return region }
        let preset = ProviderRegionRules.presetDefault(for: kind.providerKind, presets: settings.presets)
        return ProviderRegionRules.shownRegion(pendingRegion, preset: preset)
    }

    private func regionRow(_ kind: VoiceEngineKind) -> some View {
        ProviderRegionRow(
            options: ProviderRegionRules.options(for: kind.providerKind, presets: settings.presets),
            selection: shownRegion(kind), busy: regionBusy, failure: regionFailure,
            onSelect: { region in setRegion(region) }
        )
    }

    private func setRegion(_ region: ProviderRegion) {
        regionFailure = nil
        guard let provider else {
            pendingRegion = region
            return
        }
        regionBusy = true
        Task {
            do {
                try await voice.updateProvider(provider.id, region: region)
            } catch {
                if let wrong = ProviderRegionRules.wrongSite(error, tried: region, saved: provider.region) {
                    regionFailure = ProviderRegionRules.wrongSiteText(wrong)
                } else {
                    regionFailure = SettingsReason.line(for: error)
                }
            }
            regionBusy = false
        }
    }

    // MARK: - Model and Voice

    @ViewBuilder private func modelRow(enabled: Bool) -> some View {
        let chosen = VoicePageRules.chosenModel(provider, in: settings)
        let choices = enabled ? VoicePageRules.modelChoices(provider, remote: remoteRows) : []
        InlineChoiceRow(
            title: Text("Model"),
            current: chosen.map { Text(verbatim: $0.label) } ?? Text("Not set"),
            options: choices.map { choice in
                ChoiceOption(value: choice.id, title: Text(verbatim: choice.label), subtitle: modelSubtitle(choice))
            },
            selection: chosen.map { "added:" + $0.id } ?? "",
            busy: voice.busy,
            onSelect: { id in
                guard let provider, let picked = choices.first(where: { $0.id == id }) else { return }
                Task { await voice.chooseModel(picked, providerId: provider.id) }
            }
        )
        .opacity(enabled ? 1 : 0.45)
        .allowsHitTesting(enabled)
    }

    private func modelSubtitle(_ choice: VoiceModelChoice) -> Text? {
        switch choice {
        case .added(let row): row.label == row.modelId ? nil : Text(verbatim: row.modelId)
        case .remote(let model): Text("Adds \(model.modelId)")
        }
    }

    @ViewBuilder private func voiceRow(enabled: Bool) -> some View {
        let names = enabled ? VoicePageRules.voices(provider, in: settings) : []
        let current = VoicePageRules.voice(provider, in: settings)
        InlineChoiceRow(
            title: Text("Voice"),
            current: current.map { Text(verbatim: $0) } ?? Text("Default"),
            options: names.isEmpty ? [] : [ChoiceOption(value: nil, title: Text("Default"))]
                + names.map { ChoiceOption(value: Optional($0), title: Text(verbatim: $0)) },
            selection: current,
            busy: voice.busy,
            onSelect: { name in Task { await voice.setVoice(name) } }
        )
        .opacity(enabled ? 1 : 0.45)
        .allowsHitTesting(enabled)
    }

    private var remoteRows: [RemoteModel] {
        guard let provider else { return [] }
        return voice.remote[provider.id]?.value ?? []
    }
}

/// The Region row (StepFun): "Mainland China" / "International", each with its host; a change
/// is saved at once (Voice page, a provider's page) or kept for the provider being added.
struct ProviderRegionRow: View {
    var options: [ProviderRegionOption]
    var selection: ProviderRegion
    var busy = false
    var failure: String?
    var onSelect: (ProviderRegion) -> Void

    var body: some View {
        InlineChoiceRow(
            title: Text("Region"),
            current: Text(selection.label),
            options: options.map { option in
                ChoiceOption(value: option.region, title: Text(option.region.label), subtitle: option.host.map { Text(verbatim: $0) })
            },
            selection: selection,
            busy: busy,
            failure: failure,
            onSelect: onSelect
        )
    }
}
