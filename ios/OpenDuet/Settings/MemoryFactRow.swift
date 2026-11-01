// M11: one fact of a memory layer: its text, who saved it and when, "From the chat" when it can
// open that thread; ⋯ Edit (in place, Save / Cancel) and Forget (asks in place, then archives).
import SwiftUI

struct MemoryFactRow: View {
    var fact: MemoryFact
    var model: MemoryLayerModel
    var readOnly = false
    var sourceURL: URL?
    var onOpenSource: ((URL) -> Void)?

    private enum Mode: Hashable { case shown, editing, confirmingForget }

    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var mode = Mode.shown
    @State private var text = ""
    @State private var busy = false
    @State private var failure: String?
    @FocusState private var focused: Bool
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 15.5
    @ScaledMetric(relativeTo: .caption) private var metaSize: CGFloat = 12.5

    var body: some View {
        Group {
            switch mode {
            case .shown: shown
            case .editing: editor
            case .confirmingForget: confirm
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.34, dampingFraction: 0.86), value: mode)
        .animation(.easeInOut(duration: 0.2), value: failure)
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
    }

    private var shown: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: fact.text)
                    .font(.system(size: textSize))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                HStack(spacing: 6) {
                    MemorySourceBadge(source: fact.source)
                    Text(verbatim: ChatDateFormat(locale: locale).relativeDayAndTime(fact.createdAt))
                        .font(.system(size: metaSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                }
                if let sourceURL, let onOpenSource {
                    Button { onOpenSource(sourceURL) } label: {
                        Text("From the chat \(Image(glyph: .chevron))")
                            .font(.system(size: metaSize, weight: .semibold))
                            .foregroundStyle(Palette.accent)
                            .frame(minHeight: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Open the chat this came from"))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !readOnly {
                menu
            }
        }
        .transition(.opacity)
        .accessibilityElement(children: .contain)
        .accessibilityActions {
            if !readOnly {
                Button { startEditing() } label: { Text("Edit") }
                Button { mode = .confirmingForget } label: { Text("Forget") }
            }
        }
    }

    private var menu: some View {
        Menu {
            Button { startEditing() } label: { Label { Text("Edit") } icon: { Image(glyph: .edit) } }
            Button(role: .destructive) { mode = .confirmingForget } label: { Label { Text("Forget") } icon: { Image(glyph: .delete) } }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.secondaryText)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(Text("More for this fact"))
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(text: $text, axis: .vertical) { Text("Fact") }
                .font(.system(size: textSize))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1...8)
                .focused($focused)
                .disabled(busy)
            if let failure { SettingsReasonLine(reason: failure) }
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Cancel"), style: .outline, fullWidth: false) { stop() }
                    .disabled(busy)
                CapsuleButton(title: Text("Save"), busy: busy, fullWidth: false, action: save)
                    .disabled(FactList.cleaned(text) == nil || FactList.cleaned(text) == fact.text)
            }
        }
        .transition(.opacity)
    }

    private var confirm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Forget this? OpenDuet won't use it any more.")
                .font(.system(size: textSize))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: fact.text)
                .font(.system(size: metaSize + 1))
                .foregroundStyle(Palette.secondaryText)
                .lineLimit(3)
            if let failure { SettingsReasonLine(reason: failure) }
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Cancel"), style: .outline) { stop() }
                    .disabled(busy)
                DestructiveCapsule(title: Text("Forget"), busy: busy, action: forget)
            }
        }
        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
    }

    private func startEditing() {
        text = fact.text
        failure = nil
        mode = .editing
        focused = true
    }

    private func stop() {
        failure = nil
        mode = .shown
    }

    private func save() {
        guard let cleaned = FactList.cleaned(text) else { return }
        busy = true
        failure = nil
        Task {
            do {
                try await model.editFact(fact.id, text: cleaned)
                mode = .shown
            } catch {
                failure = SettingsReason.line(for: error)
            }
            busy = false
        }
    }

    private func forget() {
        busy = true
        failure = nil
        Task {
            do {
                try await model.forgetFact(fact.id)
            } catch {
                failure = SettingsReason.line(for: error)
            }
            busy = false
        }
    }
}

/// "You" / "OpenDuet" / "Tidied up" as a small capsule.
struct MemorySourceBadge: View {
    var source: MemorySource

    @ScaledMetric(relativeTo: .caption2) private var size: CGFloat = 11.5

    var body: some View {
        Text(source.badge)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(source == .user ? Palette.primaryText : Palette.accent)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(source == .user ? Palette.tile : Palette.accent.opacity(0.12)))
            .accessibilityLabel(Text(source.spoken))
    }
}

extension MemorySource {
    /// What VoiceOver says for the badge.
    var spoken: LocalizedStringResource {
        switch self {
        case .user: "Added by you"
        case .assistant: "Saved by OpenDuet"
        case .dreaming: "Tidied up by OpenDuet"
        }
    }
}
