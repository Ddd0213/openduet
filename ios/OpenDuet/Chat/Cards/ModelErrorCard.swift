// M12 model_error: a turn the model couldn't answer. The phrase (localized like system lines),
// the model's name as a caption, then Retry (action "retry") and Switch model (a sheet with the
// chat models; picking one retries on it), or "Set up models" when there's nothing to retry with.
// Retry shows "Retrying…" at once; a refusal shows its reason on the card. A retry the server
// took, or a dismissed card, folds to the phrase line (a new failure posts a new card).
import SwiftUI

struct ModelErrorCard: View {
    var message: Message
    var payload: ModelErrorPayload
    var actions: ShellActions

    @Environment(\.cardContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var switching = false
    @State private var taps = 0
    @State private var failures = 0
    @ScaledMetric(relativeTo: .body) private var phraseSize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var captionSize: CGFloat = 13

    private var phase: ModelErrorPhase {
        ModelErrorPhase(payload, request: context.requests[message.id])
    }

    var body: some View {
        let phase = phase
        Group {
            switch phase {
            case .retried, .dismissed:
                SystemLine(phrase: payload.phrase)
            case .retrying:
                VStack(spacing: 6) {
                    SystemLine(phrase: payload.phrase)
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Retrying…")
                    }
                    .font(.system(size: captionSize))
                    .foregroundStyle(Palette.secondaryText)
                    .accessibilityElement(children: .combine)
                }
            case .open, .failed:
                card(phase)
            }
        }
        .transition(.opacity)
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86), value: phase)
        .onChange(of: phase) { old, new in
            if case .failed = new, old == .retrying { failures += 1 }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: taps)
        .sensoryFeedback(.warning, trigger: failures)
        .sheet(isPresented: $switching) {
            ModelSwitchSheet(failedModelId: payload.modelId, onPick: { id in
                switching = false
                retry(on: id)
            }, onSetUp: {
                switching = false
                // After this sheet has started to go, so the Models sheet can come up.
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    actions.openModels()
                }
            }, onClose: { switching = false })
            .duetSheetChrome()
            .presentationDetents([.medium, .large])
        }
    }

    private func card(_ phase: ModelErrorPhase) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                DuetIcon(glyph: .warning, size: phraseSize + 3, tint: Palette.failure)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    PhraseText(phrase: payload.phrase)
                        .font(.system(size: phraseSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    if let caption = ModelErrorCopy.caption(payload) {
                        Text(verbatim: caption)
                            .font(.system(size: captionSize))
                            .foregroundStyle(Palette.secondaryText)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if case .failed(let reason) = phase {
                FormFailureLine(reason: reason).transition(.opacity)
            }
            buttons(enabled: phase.canAct)
        }
        .padding(16)
        .frame(maxWidth: 520, alignment: .leading)
        .cardSurface()
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func buttons(enabled: Bool) -> some View {
        if ModelErrorCopy.needsSetup(payload) {
            CapsuleButton(title: Text("Set up models")) { actions.openModels() }
        } else {
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Switch model"), style: .outline) { switching = true }
                CapsuleButton(title: Text("Retry")) { retry(on: nil) }
            }
            .disabled(!enabled)
        }
    }

    private func retry(on modelId: String?) {
        guard phase.canAct else { return }
        taps += 1
        actions.cards.retry(message.id, modelId)
    }
}

/// Switch model: the usable chat models (the one that failed last); picking one retries on it.
struct ModelSwitchSheet: View {
    var failedModelId: String?
    var onPick: (String) -> Void
    var onSetUp: () -> Void
    var onClose: () -> Void

    @Environment(\.apiClient) private var api
    @State private var models = ModelsModel()

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Switch model"), leading: .close, onLeading: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch models.state.display {
                    case .loading:
                        SettingsRowsSkeleton(rows: 3)
                    case .failed(let reason):
                        InlineRetryLine(reason: reason) { Task { await models.load() } }
                            .cardSurface()
                    case .loaded(let state):
                        list(state)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
        }
        .task {
            models.attach(api)
            await models.load()
        }
    }

    @ViewBuilder private func list(_ state: ModelsState) -> some View {
        let options = ModelErrorCopy.switchOptions(state, failed: failedModelId)
        if options.allSatisfy({ $0.id == failedModelId }) {
            SettingsNote(text: Text("No other model is set up. Add one in Models."))
            CapsuleButton(title: Text("Set up models"), action: onSetUp)
        } else {
            SettingsNote(text: Text("OpenDuet tries the same message again on the model you pick. Your default stays the same."))
            CardSection {
                ForEach(options) { model in
                    SheetRow(
                        title: Text(verbatim: model.label),
                        subtitle: ModelCatalog.provider(model.providerId, in: state).map { Text(verbatim: $0.name) },
                        action: { onPick(model.id) }
                    ) {
                        if model.id == failedModelId {
                            ModelsTag(text: Text("Just failed"))
                        } else if model.id == state.defaults.defaultModelId {
                            ModelsTag(text: Text("Default"), accent: true)
                        }
                    }
                }
            }
        }
    }
}
