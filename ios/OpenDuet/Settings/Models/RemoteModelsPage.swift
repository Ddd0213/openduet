// M12 the remote models picker (GET /api/providers/:id/remote-models): search, one row per model
// with its label, the id in a caption and badges (context, thinking, tools, images, voice).
// Models already in the list show checked and can't be picked; "Add N models" sends
// POST /api/models/batch. A provider that doesn't list its models (or one that isn't there yet)
// gets "Add by id" (POST /api/models).
import SwiftUI

struct RemoteModelsPage: View {
    var models: ModelsModel
    var providerId: String
    var leading: SheetHeaderLeading = .back
    var onLeading: () -> Void
    /// the models were added (the page that did it goes away)
    var onDone: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Add models"), leading: leading, onLeading: onLeading)
            RemoteModelsPicker(models: models, providerId: providerId, onDone: onDone)
        }
    }
}

/// The picker without its header (onboarding shows it under its own).
struct RemoteModelsPicker: View {
    var models: ModelsModel
    var providerId: String
    var onDone: () -> Void

    @State private var list = Loadable<[RemoteModel]>()
    @State private var selection = RemoteModelSelection()
    @State private var query = ""
    @State private var adding = false
    @State private var addFailure: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                switch list.display {
                case .loading:
                    SettingsRowsSkeleton(rows: 4)
                case .failed(let reason):
                    InlineRetryLine(reason: reason) { Task { await load() } }
                        .cardSurface()
                    AddModelByIdCard(models: models, providerId: providerId, onAdded: { _ in onDone() })
                case .loaded(let remote) where remote.isEmpty:
                    SettingsNote(text: Text("This provider doesn't list its models. Add one by its id."))
                    AddModelByIdCard(models: models, providerId: providerId, expanded: true, onAdded: { _ in onDone() })
                case .loaded(let remote):
                    loaded(remote)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            if case .loaded(let remote) = list.display, !remote.isEmpty {
                addBar
            }
        }
        .task { await load() }
        .sensoryFeedback(.warning, trigger: addFailure) { _, new in new != nil }
    }

    @ViewBuilder private func loaded(_ remote: [RemoteModel]) -> some View {
        ModelSearchField(query: $query)
        let shown = RemoteModelSelection.filter(remote, query: query)
        if shown.isEmpty {
            SettingsNote(text: Text("No model matches “\(query)”."))
        } else {
            CardSection {
                ForEach(shown) { model in
                    RemoteModelRow(
                        model: model,
                        picked: selection.isPicked(model.modelId),
                        enabled: selection.canPick(model) && !adding,
                        onToggle: { selection.toggle(model) }
                    )
                }
            }
        }
        AddModelByIdCard(models: models, providerId: providerId, onAdded: { _ in onDone() })
    }

    private var addBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let addFailure {
                SettingsReasonLine(reason: addFailure)
            }
            CapsuleButton(title: addTitle, busy: adding, action: add)
                .disabled(selection.count == 0 || adding)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Palette.sheetBackground.opacity(0.96))
        .animation(.easeInOut(duration: 0.2), value: addFailure)
    }

    private var addTitle: Text {
        switch selection.count {
        case 0: Text("Pick models to add")
        case 1: Text("Add 1 model")
        case let count: Text("Add \(count) models")
        }
    }

    private func load() async {
        list.begin()
        do {
            // M27: realtime models are added on the Voice page only.
            let remote = RemoteModelSelection.chatRows(try await models.remoteModels(providerId))
            selection.prune(to: remote)
            list.finish(remote)
        } catch {
            if let reason = SettingsReason.line(for: error) { list.fail(reason) } else { list.loading = false }
        }
    }

    private func add() {
        guard let body = selection.request(providerId: providerId) else { return }
        adding = true
        addFailure = nil
        Task {
            do {
                try await models.addModels(body)
                adding = false
                onDone()
            } catch {
                addFailure = SettingsReason.line(for: error)
                adding = false
            }
        }
    }
}

/// The search field over the list.
struct ModelSearchField: View {
    @Binding var query: String

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 16

    var body: some View {
        HStack(spacing: 8) {
            DuetIcon(glyph: .search, size: fontSize + 2, tint: Palette.secondaryText)
                .accessibilityHidden(true)
            TextField(text: $query, prompt: Text("Search models")) { Text("Search models") }
                .font(.system(size: fontSize))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Palette.secondaryText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Clear"))
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .cardSurface()
    }
}

/// One model the provider offers: the whole row toggles it; added ones show checked, disabled.
struct RemoteModelRow: View {
    var model: RemoteModel
    var picked: Bool
    var enabled: Bool
    var onToggle: () -> Void

    @ScaledMetric(relativeTo: .body) private var labelSize: CGFloat = 15.5
    @ScaledMetric(relativeTo: .caption) private var idSize: CGFloat = 12.5
    @ScaledMetric(relativeTo: .body) private var boxSize: CGFloat = 24

    private var added: Bool { RemoteModelSelection.isAdded(model) }

    var body: some View {
        Button(action: onToggle) {
            HStack(alignment: .top, spacing: 12) {
                HandCheckbox(checked: picked || added, size: boxSize)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: model.label)
                            .font(.system(size: labelSize, weight: .semibold))
                            .foregroundStyle(Palette.primaryText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if added {
                            ModelsTag(text: Text("Added"))
                        }
                    }
                    Text(verbatim: model.modelId)
                        .font(.system(size: idSize, design: .monospaced))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    ModelBadgesRow(badges: ModelBadge.badges(model))
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
            .opacity(added ? 0.55 : (enabled || picked ? 1 : 0.5))
        }
        .buttonStyle(RowPressStyle())
        .disabled(added || !enabled)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(picked || added ? [.isButton, .isSelected] : .isButton)
        .sensoryFeedback(.selection, trigger: picked)
    }
}

/// "Add by id": a model the list doesn't have (or a gateway without a list).
struct AddModelByIdCard: View {
    var models: ModelsModel
    var providerId: String
    var expanded = false
    var onAdded: (ModelEntry) -> Void

    @State private var open = false
    @State private var modelId = ""
    @State private var adding = false
    @State private var failure: String?

    private var cleanId: String { modelId.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if open || expanded {
                CardSection {
                    SettingsField(
                        label: Text("Model id"), text: $modelId, prompt: Text("The id the provider uses"),
                        limit: 200, monospaced: true, plain: true,
                        footnote: Text("OpenDuet fills in what it can; you can change the numbers after.")
                    )
                }
                .disabled(adding)
                SettingsSaveRow(
                    title: Text("Add"), busy: adding, enabled: !cleanId.isEmpty && cleanId.count <= 200, saved: false,
                    failure: failure, status: nil, onSave: add
                )
            } else {
                Button { open = true } label: {
                    Text("Add by id")
                        .font(.system(.subheadline, weight: .semibold))
                        .foregroundStyle(Palette.accent)
                        .frame(minHeight: 44)
                        .padding(.horizontal, 6)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(Text("For a model this list doesn't show"))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: open)
    }

    private func add() {
        let id = cleanId
        guard !id.isEmpty else { return }
        adding = true
        failure = nil
        Task {
            do {
                let model = try await models.addModel(CreateModelEntryRequest(providerId: providerId, modelId: id))
                adding = false
                modelId = ""
                onAdded(model)
            } catch {
                failure = ModelsReason.addLine(error)
                adding = false
            }
        }
    }
}
