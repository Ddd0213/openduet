// M12 Add provider: the presets (OpenAI / Anthropic / Google Gemini / StepFun / Custom), then
// the form. Custom asks for the protocol, the base URL and, Anthropic-compatible, how the key is
// sent. Every kind has the key (SecureField: sent once, never kept) and optional headers. The
// server checks the key before saving (up to ~15 s: "Checking the key…"); a refusal keeps the
// form except the key and shows its reason inline. Onboarding's "Add a model" uses both.
import SwiftUI

/// The presets as rows; tapping one opens its form.
struct ProviderPresetList: View {
    var onPick: (ProviderKind) -> Void

    var body: some View {
        CardSection(dividerInset: Metrics.settingsTileInset) {
            ForEach(ProviderKind.allCases, id: \.self) { kind in
                SheetRow(
                    title: Text(kind.title),
                    subtitle: Text(kind.blurb),
                    action: { onPick(kind) },
                    leading: {
                        if kind == .custom {
                            RowSymbol(systemImage: "server.rack", tint: Palette.secondaryText)
                        } else {
                            ProviderTile(name: String(localized: kind.title))
                        }
                    },
                    trailing: { RowChevron() }
                )
            }
        }
    }
}

struct AddProviderPage: View {
    var leading: SheetHeaderLeading = .back
    var onLeading: () -> Void
    var onPick: (ProviderKind) -> Void

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Add provider"), leading: leading, onLeading: onLeading)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    SettingsNote(text: Text("Pick where your models come from. You'll need an API key from that provider."))
                    ProviderPresetList(onPick: onPick)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
        }
    }
}

/// The provider's form as a page.
struct ProviderFormPage: View {
    var models: ModelsModel
    var kind: ProviderKind
    /// M27: the regions and their hosts (VoiceSettings.presets), when the caller has them
    var presets: [VoiceProviderPreset] = []
    var onBack: () -> Void
    var onAdded: (ModelProvider) -> Void

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text(kind.title), leading: .back, onLeading: onBack)
            ScrollView {
                ProviderForm(models: models, kind: kind, presets: presets, onAdded: onAdded)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
    }
}

/// Add provider's fields and Add. M27: StepFun's Region (mainland China / international, from the
/// server's presets; none on an older server, then nothing is sent and the server picks).
struct ProviderForm: View {
    var models: ModelsModel
    var kind: ProviderKind
    var presets: [VoiceProviderPreset]
    var onAdded: (ModelProvider) -> Void

    @State private var draft: ProviderDraft
    @State private var saving = false
    @State private var failure: String?
    /// a refused save dropped the key
    @State private var keyDropped = false
    /// the presets fetched here when the caller had none (onboarding, Models opened first)
    @State private var fetched: [VoiceProviderPreset] = []

    init(models: ModelsModel, kind: ProviderKind, presets: [VoiceProviderPreset] = [], onAdded: @escaping (ModelProvider) -> Void) {
        self.models = models
        self.kind = kind
        self.presets = presets
        self.onAdded = onAdded
        _draft = State(initialValue: ProviderDraft(kind: kind))
    }

    private var regions: [ProviderRegionOption] {
        ProviderRegionRules.options(for: kind, presets: presets.isEmpty ? fetched : presets)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if draft.isCustom { customFields }
            if ProviderFormLayout.addRows(kind, regions: regions).contains(.region) {
                CardSection {
                    ProviderRegionRow(
                        options: regions,
                        selection: ProviderRegionRules.shownRegion(draft.region, preset: presetDefault),
                        busy: false,
                        onSelect: { region in
                            draft.region = region
                            failure = nil
                        }
                    )
                }
                .disabled(saving)
                .transition(.opacity)
            }
            CardSection {
                SettingsField(
                    label: Text("Name"), text: $draft.name,
                    prompt: draft.isCustom ? Text("Optional") : Text(kind.title),
                    limit: ProviderFormRules.nameLimit,
                    problem: draft.problems.contains(.name) ? Text("Up to 60 characters.") : nil
                )
                SettingsSecretField(
                    label: Text("API key"), text: $draft.key, prompt: Text("Paste the key"),
                    footnote: draft.problems.contains(.key)
                        ? Text("That's longer than any key (500 characters max).")
                        : Text("Goes straight to your server's vault. OpenDuet never sees it.")
                )
            }
            .disabled(saving)
            ProviderHeaderFields(headers: $draft.headers, disabled: saving)
            SettingsSaveRow(
                title: Text("Add"), busy: saving, enabled: draft.canSave, saved: false,
                failure: failure, status: status, onSave: save
            )
        }
        .animation(.easeInOut(duration: 0.2), value: draft.wireProtocol)
        .animation(.easeInOut(duration: 0.2), value: regions)
        .task { await loadRegions() }
    }

    private var presetDefault: ProviderRegion? {
        ProviderRegionRules.presetDefault(for: kind, presets: presets.isEmpty ? fetched : presets)
    }

    /// StepFun's regions: the caller's presets, else GET /api/voice-settings once. The default is
    /// the iPhone's region (CN: mainland China, any other country: international).
    private func loadRegions() async {
        if kind == .stepfun, presets.isEmpty, fetched.isEmpty, let api = models.api,
           let settings = try? await api.voiceSettings() {
            fetched = settings.presets
        }
        guard !regions.isEmpty, !draft.offersRegion else { return }
        draft.offersRegion = true
        if draft.region == nil { draft.region = ProviderRegionRules.defaultRegion(localeRegion: Locale.current.region?.identifier) }
    }

    private var customFields: some View {
        VStack(alignment: .leading, spacing: 10) {
            SheetSectionTitle(text: Text("Protocol"))
                .padding(.bottom, -6)
            SettingsSegmented(
                options: ProviderProtocol.allCases.map { ($0, Text($0.label)) },
                selection: draft.wireProtocol, disabled: saving,
                onSelect: { draft.wireProtocol = $0; failure = nil }
            )
            CardSection {
                SettingsField(
                    label: Text("Base URL"), text: $draft.baseUrl,
                    prompt: Text(verbatim: "https://llm.example.com/v1"),
                    limit: ProviderFormRules.urlLimit, plain: true, keyboard: .URL,
                    problem: ProviderFormCopy.urlProblem(draft.problems),
                    footnote: Text("The address before /chat/completions or /messages.")
                )
            }
            .disabled(saving)
            if draft.asksAuth {
                SheetSectionTitle(text: Text("Send the key as"))
                    .padding(.top, 6)
                    .padding(.bottom, -6)
                SettingsSegmented(
                    options: ProviderAuth.allCases.map { ($0, Text($0.label)) },
                    selection: draft.auth, disabled: saving,
                    onSelect: { draft.auth = $0 }
                )
                .transition(.opacity)
            }
        }
    }

    private var status: Text? {
        if saving { return Text("Checking the key…") }
        if keyDropped, failure != nil { return Text("Paste the key again to retry.") }
        return nil
    }

    private func save() {
        guard let body = draft.request else { return }
        // Sent once: the key leaves this page's state now.
        draft.dropSecrets()
        saving = true
        failure = nil
        keyDropped = false
        Task {
            do {
                let provider = try await models.createProvider(body)
                saving = false
                onAdded(provider)
            } catch {
                let tried = ProviderRegionRules.shownRegion(body.region, preset: presetDefault)
                if draft.offersRegion, let wrong = ProviderRegionRules.wrongSite(error, tried: tried, saved: nil) {
                    // The key is for the other site: the Region row moves there; the key is pasted again.
                    failure = ProviderRegionRules.wrongSiteText(wrong)
                    draft.region = wrong.belongsTo
                } else {
                    failure = SettingsReason.line(for: error)
                }
                keyDropped = true
                saving = false
            }
        }
    }
}

/// The words of the provider forms' problems.
enum ProviderFormCopy {
    static func urlProblem(_ problems: Set<ProviderFormProblem>) -> Text? {
        if problems.contains(.url) { return Text("Use an address like https://host/v1, without spaces, a query or a password.") }
        if problems.contains(.urlNeedsHTTPS) { return Text("Use https. Plain http only works for addresses on your own network.") }
        return nil
    }

    static func headerProblem(_ problem: ProviderFormProblem?) -> Text? {
        switch problem {
        case .headerName?: Text("Letters, digits and dashes only.")
        case .credentialHeader?: Text("Keys and tokens go in the API key field, not in a header.")
        case .duplicateHeader?: Text("Two headers have this name.")
        case .headerValue?: Text("Up to 2,000 characters.")
        default: nil
        }
    }
}

/// Extra request headers (not secret: credentials go in the key). Up to 10.
struct ProviderHeaderFields: View {
    @Binding var headers: [ProviderHeaderDraft]
    var disabled = false

    @ScaledMetric(relativeTo: .body) private var removeSize: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SheetSectionTitle(text: Text("Headers"))
                .padding(.bottom, -6)
            SettingsNote(text: Text("Optional. Sent with every request, like an organization or project id. Not for keys."))
            ForEach($headers) { $header in
                CardSection {
                    SettingsField(
                        label: Text("Header"), text: $header.name, prompt: Text(verbatim: "X-Project-Id"), plain: true,
                        problem: ProviderFormCopy.headerProblem(ProviderHeaderRules.problem(header, in: headers))
                    )
                    SettingsField(
                        label: Text("Value"), text: $header.value, prompt: Text("The value"), plain: true,
                        problem: header.value.count > ProviderFormRules.headerValueLimit ? Text("Up to 2,000 characters.") : nil
                    )
                    Button(role: .destructive) {
                        headers.removeAll { $0.id == header.id }
                    } label: {
                        Text("Remove header")
                            .font(.system(size: removeSize, weight: .medium))
                            .foregroundStyle(Palette.destructive)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .padding(.horizontal, 16)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(RowPressStyle())
                }
            }
            if headers.count < ProviderFormRules.maxHeaders {
                CapsuleButton(title: Text("Add header"), style: .outline, fullWidth: false) {
                    headers.append(ProviderHeaderDraft())
                }
                .padding(.horizontal, 6)
            }
        }
        .disabled(disabled)
        .animation(.easeInOut(duration: 0.2), value: headers.map(\.id))
    }
}
