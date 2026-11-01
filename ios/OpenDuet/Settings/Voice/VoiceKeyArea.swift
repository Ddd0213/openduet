// M27 the Voice page's key area, Codync's three states:
// - no key: the secure field "API key" and Save; the server checks the key first (POST
//   /api/providers, or PATCH for a provider without one) and its reason shows under the field;
// - saved: "Key saved ··last4", Test key (POST /api/providers/:id/test), Replace key, and the last
//   check's line (a green check "Key works", or the red reason);
// - a StepFun key for the other site (400 field `region`): "This key is for StepFun's … site." and
//   "Switch to <it>", which sends the same key once more with that region. The key is kept only
//   while that offer is on screen, never stored.
import SwiftUI

struct VoiceKeyArea: View {
    var voice: VoiceSettingsModel
    /// nil: the provider is being added (kind and region below)
    var provider: VoiceProvider?
    var kind: VoiceEngineKind
    /// the region shown (sent when adding; the region a key was checked against)
    var region: ProviderRegion
    var onAdded: () -> Void

    @State private var draft = ""
    @State private var replacing = false
    @State private var saving = false
    @State private var failure: String?
    @State private var keyDropped = false
    /// a refused key whose site is the other one: "Switch to …" resends it (then it's gone)
    @State private var heldKey: String?
    @State private var switchTo: ProviderRegion?
    @State private var testing = false
    @State private var testFailure: String?

    @ScaledMetric(relativeTo: .footnote) private var noteSize: CGFloat = 13.5

    private var state: VoiceKeyState { VoicePageRules.keyState(provider) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if state.hasKey, !replacing {
                saved
                    .transition(.opacity)
            } else {
                entry
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: replacing)
        .animation(.easeInOut(duration: 0.2), value: state)
        .animation(.easeInOut(duration: 0.2), value: switchTo)
        .onChange(of: draft) { _, typed in
            if !typed.isEmpty { dropHeld() }
        }
        .onDisappear { dropHeld() }
    }

    // MARK: - Saved

    private var saved: some View {
        VStack(alignment: .leading, spacing: 8) {
            CardSection {
                VStack(alignment: .leading, spacing: 4) {
                    SheetRow(title: savedTitle, subtitle: nil, action: nil) {
                        RowSymbol(systemImage: "key")
                    } trailing: {
                        BusySpinner(busy: testing)
                    }
                    resultLine
                        .padding(.leading, Metrics.settingsTileInset)
                        .padding(.trailing, 16)
                        .padding(.bottom, 12)
                        .padding(.top, -6)
                }
                HStack(spacing: 10) {
                    CapsuleButton(title: Text("Test key"), style: .outline, busy: testing, fullWidth: false, action: test)
                        .disabled(testing)
                    CapsuleButton(title: Text("Replace key"), style: .outline, fullWidth: false) {
                        testFailure = nil
                        replacing = true
                    }
                    .disabled(testing)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            if let testFailure {
                SettingsReasonLine(reason: testFailure)
                    .padding(.horizontal, 6)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: testFailure)
        .sensoryFeedback(.warning, trigger: testFailure) { _, new in new != nil }
    }

    private var savedTitle: Text {
        switch state {
        case .saved(let last4?), .failed(let last4?, _): Text("Key saved ··\(last4)")
        default: Text("Key saved")
        }
    }

    @ViewBuilder private var resultLine: some View {
        switch state {
        case .failed(_, let reason):
            Label {
                Text(verbatim: reason).foregroundStyle(Palette.failure)
            } icon: {
                DuetIcon(glyph: .failed, size: noteSize + 2, tint: Palette.failure)
            }
            .font(.system(size: noteSize))
            .fixedSize(horizontal: false, vertical: true)
        default:
            Label {
                Text("Key works").foregroundStyle(Palette.secondaryText)
            } icon: {
                DuetIcon(glyph: .done, size: noteSize + 2, tint: Palette.readyForReview)
            }
            .font(.system(size: noteSize))
        }
    }

    // MARK: - Entry (no key, or Replace key)

    private var entry: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardSection {
                SettingsSecretField(
                    label: replacing ? Text("New API key") : Text("API key"), text: $draft,
                    prompt: Text("Paste the key"),
                    footnote: draft.count > ProviderFormRules.keyLimit
                        ? Text("That's longer than any key (500 characters max).")
                        : Text("Goes straight to your server's vault. OpenDuet never sees it.")
                )
            }
            .disabled(saving)
            if let switchTo {
                CapsuleButton(title: Text("Switch to \(String(localized: switchTo.label))"), style: .outline, fullWidth: false) {
                    resend(to: switchTo)
                }
                .padding(.horizontal, 6)
                .disabled(saving)
                .transition(.opacity)
            }
            HStack(alignment: .bottom, spacing: 4) {
                if replacing {
                    CapsuleButton(title: Text("Cancel"), style: .outline, fullWidth: false) { cancel() }
                        .disabled(saving)
                        .padding(.leading, 6)
                }
                SettingsSaveRow(
                    busy: saving, enabled: canSave, saved: false, failure: failure, status: status, onSave: save
                )
            }
        }
    }

    private var canSave: Bool {
        let key = ProviderFormRules.clean(draft)
        return !key.isEmpty && key.count <= ProviderFormRules.keyLimit && !saving
    }

    private var status: Text? {
        if saving { return Text("Checking the key…") }
        if keyDropped, failure != nil, switchTo == nil { return Text("Paste the key again to retry.") }
        return nil
    }

    // MARK: - Writes

    private func save() {
        let key = ProviderFormRules.clean(draft)
        guard !key.isEmpty else { return }
        // Sent once: the key leaves the field now.
        draft = ""
        send(key: key, region: nil)
    }

    private func resend(to region: ProviderRegion) {
        guard let key = heldKey else { return }
        send(key: key, region: region)
    }

    /// POST (adding) or PATCH (a new key; `region` when switching sites).
    private func send(key: String, region switching: ProviderRegion?) {
        saving = true
        failure = nil
        keyDropped = false
        switchTo = nil
        heldKey = nil
        let tried = switching ?? provider?.region ?? region
        Task {
            do {
                if let provider {
                    try await voice.updateProvider(provider.id, key: key, region: switching)
                    replacing = false
                } else {
                    try await voice.addProvider(kind, key: key, region: switching ?? region)
                    onAdded()
                }
                saving = false
            } catch {
                saving = false
                if kind == .stepfun, let wrong = ProviderRegionRules.wrongSite(error, tried: tried, saved: provider?.region) {
                    failure = ProviderRegionRules.wrongSiteText(wrong)
                    switchTo = wrong.switchTo
                    heldKey = wrong.switchTo == nil ? nil : key
                    keyDropped = wrong.switchTo == nil
                } else {
                    failure = SettingsReason.line(for: error)
                    keyDropped = true
                }
            }
        }
    }

    private func test() {
        guard let provider else { return }
        testing = true
        testFailure = nil
        Task {
            do { try await voice.testProvider(provider.id) } catch { testFailure = SettingsReason.line(for: error) }
            testing = false
        }
    }

    private func cancel() {
        draft = ""
        failure = nil
        keyDropped = false
        dropHeld()
        replacing = false
    }

    private func dropHeld() {
        heldKey = nil
        switchTo = nil
    }
}
