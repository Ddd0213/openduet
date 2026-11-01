// M11: a memory layer's facts under its document: each with who saved it (You / the assistant / Tidied
// up) and when, "Add a fact" at the top, and per fact Edit and Forget (asks in place). Read-only
// for a channel seen from Everything, where a fact from the chat links to the channel's thread.
import SwiftUI

struct MemoryFactsSection: View {
    var model: MemoryLayerModel
    var readOnly = false
    /// a channel's facts link to its thread (nil = no links: About you, or the channel itself)
    var linkChannelId: String?
    var onOpenSource: ((URL) -> Void)?

    @State private var adding = false
    @State private var newText = ""
    @State private var addBusy = false
    @State private var addFailure: String?
    @State private var added = 0
    @FocusState private var addFocused: Bool
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var emptySize: CGFloat = 14.5

    private var facts: [MemoryFact] { model.state.value?.facts ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: facts.isEmpty ? Text("What OpenDuet remembers") : Text("What OpenDuet remembers · \(facts.count)"))
            CardSection {
                if !readOnly {
                    addRow
                }
                if facts.isEmpty {
                    empty
                }
                ForEach(facts) { fact in
                    MemoryFactRow(
                        fact: fact, model: model, readOnly: readOnly,
                        sourceURL: onOpenSource == nil ? nil : FactList.sourceRoute(fact, channelId: linkChannelId),
                        onOpenSource: onOpenSource
                    )
                }
            }
            .animation(.easeInOut(duration: 0.25), value: facts.map(\.id))
        }
        .sensoryFeedback(.success, trigger: added)
    }

    private var empty: some View {
        (readOnly
            ? Text("Nothing saved here yet.")
            : Text("Nothing saved yet. OpenDuet adds facts as it learns them, and you can add your own."))
            .font(.system(size: emptySize))
            .foregroundStyle(Palette.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var addRow: some View {
        if adding {
            VStack(alignment: .leading, spacing: 10) {
                TextField(text: $newText, prompt: Text("Something OpenDuet should remember"), axis: .vertical) {
                    Text("New fact")
                }
                .font(.system(size: textSize))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1...6)
                .focused($addFocused)
                .disabled(addBusy)
                .onAppear { addFocused = true }
                if let addFailure {
                    SettingsReasonLine(reason: addFailure)
                }
                HStack(spacing: 10) {
                    CapsuleButton(title: Text("Cancel"), style: .outline, fullWidth: false, action: cancelAdd)
                        .disabled(addBusy)
                    CapsuleButton(title: Text("Add"), busy: addBusy, fullWidth: false, action: add)
                        .disabled(FactList.cleaned(newText) == nil)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .transition(.opacity)
        } else {
            SheetRow(title: Text("Add a fact"), action: { adding = true }) {
                RowSymbol(systemImage: DuetGlyph.add.symbol, tint: Palette.secondaryText)
            } trailing: {
                EmptyView()
            }
            .transition(.opacity)
        }
    }

    private func add() {
        guard let text = FactList.cleaned(newText) else { return }
        addBusy = true
        addFailure = nil
        Task {
            do {
                try await model.addFact(text)
                newText = ""
                adding = false
                added += 1
            } catch {
                addFailure = SettingsReason.line(for: error)
            }
            addBusy = false
        }
    }

    private func cancelAdd() {
        newText = ""
        addFailure = nil
        adding = false
    }
}
