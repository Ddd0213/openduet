// M12 onboarding's first page on a server with no usable model: "Add a model". The presets
// (Add provider's list), then that provider's form, then its remote models picker. Once a model is
// configured the page moves on by itself (a success haptic); "Skip for now" moves on without one.
// Drawn in the app's own look (light and dark, Dynamic Type), not PART A's forced light pages.
import SwiftUI

struct OnboardingModelStep: View {
    var onDone: () -> Void
    /// after any change: the session refreshes Me (features.models)
    var onModelsChanged: () -> Void = {}

    private enum Stage: Hashable {
        case intro, form(ProviderKind), pick(String)
    }

    @Environment(\.apiClient) private var api
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var models = ModelsModel()
    @State private var stage: Stage = .intro
    /// models were added that the assistant can't chat with (no tools): say so on the intro
    @State private var notUsable = false
    @State private var finished = false

    var body: some View {
        VStack(spacing: 0) {
            switch stage {
            case .intro:
                intro.transition(.opacity)
            case .form(let kind):
                VStack(spacing: 0) {
                    SheetHeader(title: Text(kind.title), leading: .back, onLeading: { stage = .intro })
                    ScrollView {
                        ProviderForm(models: models, kind: kind) { provider in stage = .pick(provider.id) }
                            .padding(.horizontal, 16)
                            .padding(.top, 8)
                            .padding(.bottom, 32)
                    }
                    .scrollIndicators(.hidden)
                    .scrollDismissesKeyboard(.interactively)
                }
                .transition(.opacity)
            case .pick(let providerId):
                RemoteModelsPage(models: models, providerId: providerId, onLeading: { stage = .intro }) {
                    if !models.configured {
                        notUsable = true
                        stage = .intro
                    }
                }
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Palette.sheetBackground.ignoresSafeArea())
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .easeInOut(duration: 0.3), value: stage)
        .task {
            models.attach(api)
            models.onChange = onModelsChanged
            await models.load()
        }
        .onChange(of: models.configured) { _, configured in
            if configured { finish() }
        }
        .sensoryFeedback(.success, trigger: finished) { _, new in new }
    }

    private var intro: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                SettingsHero(
                    title: Text("Add a model"),
                    subtitle: Text("OpenDuet needs a model to think with. Add a provider and its API key; you pick which of its models to use.")
                )
                .padding(.top, 24)
                if notUsable {
                    SettingsReasonLine(reason: String(localized: "Those models can't use tools, so OpenDuet can't chat with them. Try another provider."))
                        .padding(.horizontal, 6)
                }
                ProviderPresetList { stage = .form($0) }
                SettingsNote(text: Text("Keys go straight to your server's vault. You can change all of this later in Everything → Models."))
                Button(action: onDone) {
                    Text("Skip for now")
                        .font(.system(.body, weight: .semibold))
                        .foregroundStyle(Palette.secondaryText)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        Task {
            // Long enough to feel the haptic before the page goes.
            try? await Task.sleep(for: .milliseconds(450))
            onDone()
        }
    }
}
