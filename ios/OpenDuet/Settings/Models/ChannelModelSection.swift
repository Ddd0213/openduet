// M12 a channel's "Model" section in its OpenDuet sheet: Model ("Default · <default model>" plus
// the chat models) and Thinking ("Default" plus the levels of the model the channel runs on).
// Both PATCH /api/channels/:id (null = Default), shown at once and put back with the reason.
import SwiftUI

struct ChannelModelSection: View {
    var model: ChannelSettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Model"))
            switch model.models.display {
            case .loading:
                SettingsRowsSkeleton(rows: 2)
            case .failed(let reason):
                InlineRetryLine(reason: reason) { Task { await model.loadModels() } }
                    .cardSurface()
            case .loaded(let state):
                rows(state)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.modelChoice)
    }

    private func rows(_ state: ModelsState) -> some View {
        let choice = model.modelChoice
        // A model that was deleted or lost its key shows (and works) as Default.
        let shownModel = choice.ownModelMissing(in: state) ? nil : choice.modelId
        return VStack(alignment: .leading, spacing: 8) {
            CardSection(dividerInset: Metrics.settingsTileInset) {
                InlineChoiceRow(
                    title: Text("Model"),
                    current: modelText(shownModel, state: state),
                    options: [ChoiceOption(value: nil, title: Text(verbatim: ModelChoiceCopy.defaultModel(state)))]
                        + ChannelModelChoice.modelOptions(in: state).map { entry in
                            ChoiceOption(
                                value: entry.id, title: Text(verbatim: entry.label),
                                subtitle: ModelCatalog.provider(entry.providerId, in: state).map { Text(verbatim: $0.name) }
                            )
                        },
                    selection: shownModel,
                    busy: choice.busy,
                    leading: "cpu",
                    onSelect: { model.pickModel($0) }
                )
                InlineChoiceRow(
                    title: Text("Thinking"),
                    current: choice.thinking.map { Text($0.label) } ?? Text(verbatim: ModelChoiceCopy.defaultThinking(state)),
                    options: ModelsRoute.thinkingOptions(
                        choice.thinkingOptions(in: state),
                        none: Text(verbatim: ModelChoiceCopy.defaultThinking(state))
                    ),
                    selection: choice.thinking,
                    busy: choice.busy,
                    leading: "brain",
                    onSelect: { model.pickThinking($0) }
                )
            }
            if let failure = choice.failure {
                SettingsReasonLine(reason: failure)
                    .padding(.horizontal, 6)
                    .transition(.opacity)
            }
            if !state.configured {
                SettingsNote(text: Text("No model is set up yet. Add one in Everything → Models."))
            } else if choice.ownModelMissing(in: state) {
                SettingsNote(text: Text("This channel's model is gone, so it uses the default."))
            }
        }
        .sensoryFeedback(.warning, trigger: choice.failure) { _, new in new != nil }
    }

    private func modelText(_ id: String?, state: ModelsState) -> Text {
        if let entry = ModelCatalog.model(id, in: state) { return Text(verbatim: entry.label) }
        return Text(verbatim: ModelChoiceCopy.defaultModel(state))
    }
}
