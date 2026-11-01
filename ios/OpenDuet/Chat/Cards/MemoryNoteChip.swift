// M11: the quiet "Remembered · Undo" / "Forgot · Undo" chip under the assistant's reply (remember /
// forget), with the layer as a tiny label ("About you" / "This channel"). Undo is optimistic: the
// chip reads "Undone" the moment it's tapped (MemoryNotePhase.undoing) and goes back with the
// reason if the action fails. Tapping the chip shows the fact itself in one grey line.
import SwiftUI

struct MemoryNoteChip: View {
    var message: Message
    var payload: MemoryNotePayload
    var actions: ShellActions

    @Environment(\.cardContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showsFact = false
    @State private var undoTaps = 0
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13
    @ScaledMetric(relativeTo: .caption2) private var scopeSize: CGFloat = 11

    private var phase: MemoryNotePhase { MemoryNotePhase(payload.state, request: context.requests[message.id]) }

    var body: some View {
        let phase = phase
        VStack(alignment: .leading, spacing: 6) {
            LeadBubble(text: message.text)
            chip(phase)
            if showsFact {
                Text(verbatim: payload.text)
                    .font(.system(size: fontSize))
                    .foregroundStyle(Palette.secondaryText)
                    .strikethrough(phase.readsUndone, color: Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .transition(.opacity)
            }
            if case .failed(let reason) = phase {
                FormFailureLine(reason: reason)
                    .padding(.horizontal, 4)
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.32, dampingFraction: 0.86), value: phase)
        .animation(.easeInOut(duration: 0.2), value: showsFact)
        .sensoryFeedback(.impact(weight: .light), trigger: undoTaps)
        .sensoryFeedback(trigger: phase) { old, new in
            if case .failed = new, old == .undoing { return .warning }
            return nil
        }
    }

    private func chip(_ phase: MemoryNotePhase) -> some View {
        HStack(spacing: 8) {
            Button { showsFact.toggle() } label: {
                HStack(spacing: 6) {
                    DuetIcon(glyph: .memory, size: fontSize + 3, tint: Palette.secondaryText)
                    outcome(phase)
                        .font(.system(size: fontSize, weight: .medium))
                        .foregroundStyle(Palette.secondaryText)
                        .contentTransition(.opacity)
                        .lineLimit(1)
                    scopeLabel
                }
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.97))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel(phase))
            .accessibilityValue(showsFact ? Text("Expanded") : Text("Collapsed"))
            .accessibilityHint(Text("Shows what was saved"))
            if phase.canUndo {
                Text(verbatim: "·")
                    .font(.system(size: fontSize))
                    .foregroundStyle(Palette.secondaryText)
                    .accessibilityHidden(true)
                Button(action: undo) {
                    Text("Undo")
                        .font(.system(size: fontSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .frame(minWidth: 44, minHeight: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.94))
                .transition(.opacity)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, phase.canUndo ? 2 : 12)
        .padding(.vertical, 2)
        .background(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func outcome(_ phase: MemoryNotePhase) -> some View {
        if phase.readsUndone {
            Text("Undone")
        } else if payload.op == .remembered {
            Text("Remembered")
        } else {
            Text("Forgot")
        }
    }

    /// "About you" (the shared layer) or "This channel".
    private var scopeLabel: some View {
        Group {
            if payload.scope == .shared { Text("About you") } else { Text("This channel") }
        }
        .font(.system(size: scopeSize, weight: .medium))
        .foregroundStyle(Palette.secondaryText)
        .lineLimit(1)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(Palette.secondaryText.opacity(0.12)))
    }

    /// "Remembered: Prefers invoices as PDF, This channel"
    private func accessibilityLabel(_ phase: MemoryNotePhase) -> Text {
        let place = payload.scope == .shared ? String(localized: "About you") : String(localized: "This channel")
        if phase.readsUndone { return Text("Undone: \(payload.text), \(place)") }
        if payload.op == .remembered { return Text("Remembered: \(payload.text), \(place)") }
        return Text("Forgot: \(payload.text), \(place)")
    }

    private func undo() {
        guard phase.canUndo else { return }
        undoTaps += 1
        actions.cards.action(message.id, .undo, nil)
    }
}
