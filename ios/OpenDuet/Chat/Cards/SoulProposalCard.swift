// M11: propose_soul_change. "Change how OpenDuet is?": the field, what it says now and what the assistant
// proposes (two short blocks, diff-like) and why. Apply (action "apply") writes it, Not now
// ("dismiss") leaves it; nothing changes before Apply. A decided card folds to one line ("Tone ·
// Applied"); tapping the line shows the card again, read-only.
import SwiftUI

struct SoulProposalCard: View {
    var message: Message
    var payload: SoulProposalPayload
    var actions: ShellActions
    var onSent: () -> Void

    @Environment(\.cardContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private enum Tap { case apply, dismiss }
    @State private var lastTap: Tap?
    @State private var expanded = false
    @State private var showsAll = false
    @State private var successes = 0
    @State private var failures = 0
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 12
    @ScaledMetric(relativeTo: .subheadline) private var reasonSize: CGFloat = 14

    private var phase: SoulProposalPhase { SoulProposalPhase(payload.state, request: context.requests[message.id]) }

    var body: some View {
        let phase = phase
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            if phase.isDecided && !expanded {
                let field = String(localized: SoulFieldLabel.title(payload.field))
                FoldedCardLine(
                    glyph: phase == .applied ? .done : .edit,
                    tint: phase == .applied ? Palette.success : Palette.secondaryText,
                    label: phase == .applied ? Text("\(field) · Applied") : Text("\(field) · Not now"),
                    onExpand: { expanded = true }
                )
                .transition(.opacity)
            } else {
                card(phase).transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86), value: phase)
        .animation(.easeInOut(duration: 0.25), value: expanded)
        .onChange(of: phase) { _, new in
            guard lastTap != nil else { return }
            switch new {
            case .applied: successes += 1; lastTap = nil; expanded = false
            case .dismissed: lastTap = nil; expanded = false
            case .failed: failures += 1
            default: break
            }
        }
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.warning, trigger: failures)
    }

    private func card(_ phase: SoulProposalPhase) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                DuetIcon(glyph: .edit, size: 18, tint: Palette.accent)
                Text("Change how OpenDuet is?")
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            Text(SoulFieldLabel.title(payload.field))
                .font(.system(size: labelSize + 1, weight: .semibold))
                .foregroundStyle(Palette.accent)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule().fill(Palette.accent.opacity(0.12)))
            VStack(alignment: .leading, spacing: 6) {
                block(label: Text("Now"), text: payload.current, proposed: false)
                DuetIcon(glyph: .scrollDown, size: 14, tint: Palette.secondaryText)
                    .padding(.leading, 12)
                    .accessibilityHidden(true)
                block(label: Text("Proposed"), text: payload.proposed, proposed: true)
            }
            if isLong {
                Button { showsAll.toggle() } label: {
                    Group { if showsAll { Text("Show less") } else { Text("Show all") } }
                        .font(.system(size: reasonSize, weight: .medium))
                        .foregroundStyle(Palette.secondaryText)
                        .frame(minHeight: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.96))
            }
            if !payload.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(verbatim: payload.reason)
                    .font(.system(size: reasonSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            footer(phase)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .opacity(phase == .dismissed ? 0.75 : 1)
        .accessibilityElement(children: .contain)
    }

    /// One side of the change: a small label and the text in a tinted block.
    private func block(label: Text, text: String, proposed: Bool) -> some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let tint = proposed ? Palette.success : Palette.secondaryText
        return VStack(alignment: .leading, spacing: 4) {
            label
                .font(.system(size: labelSize, weight: .semibold))
                .foregroundStyle(proposed ? Palette.success : Palette.secondaryText)
            Group {
                if empty { Text("Not set yet") } else { Text(verbatim: text) }
            }
            .font(.system(size: bodySize))
            .foregroundStyle(empty ? Palette.secondaryText : Palette.primaryText)
            .italic(empty)
            .lineLimit(showsAll ? nil : 6)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(tint.opacity(proposed ? 0.08 : 0.06))
        )
        .overlay(alignment: .leading) {
            // A diff-like bar on the left edge.
            RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                .fill(tint.opacity(proposed ? 0.7 : 0.35))
                .frame(width: 3)
                .padding(.vertical, 8)
        }
        .accessibilityElement(children: .combine)
    }

    /// Either block runs past six lines on a phone: offer "Show all".
    private var isLong: Bool {
        payload.current.count + payload.proposed.count > 420
            || payload.current.split(separator: "\n").count > 6
            || payload.proposed.split(separator: "\n").count > 6
    }

    @ViewBuilder
    private func footer(_ phase: SoulProposalPhase) -> some View {
        switch phase {
        case .open, .busy:
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Not now"), style: .outline, busy: phase == .busy && lastTap == .dismiss) { dismiss() }
                CapsuleButton(title: Text("Apply"), style: .filled, busy: phase == .busy && lastTap != .dismiss) { apply() }
            }
            .disabled(phase == .busy)
        case .failed(let reason):
            InlineFailure(reason: reason, onRetry: { lastTap == .dismiss ? dismiss() : apply() }, onEdit: nil)
        case .applied:
            Button { expanded = false } label: {
                MakeOutcomeLine(icon: .done, color: Palette.success, title: Text("Applied"))
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityHint(Text("Collapses the card"))
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.9)))
        case .dismissed:
            Button { expanded = false } label: {
                MakeOutcomeLine(icon: .failed, color: Palette.secondaryText, title: Text("Not now"))
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityHint(Text("Collapses the card"))
        }
    }

    private func apply() {
        lastTap = .apply
        actions.cards.action(message.id, .apply, nil)
    }

    private func dismiss() {
        lastTap = .dismiss
        actions.cards.action(message.id, .dismiss, nil)
    }
}

/// The soul's fields as the Everything sheet's editor names them.
enum SoulFieldLabel {
    static func title(_ field: SoulProposalPayload.Field) -> LocalizedStringResource {
        switch field {
        case .name: "Name in replies"
        case .addressAs: "How to address you"
        case .identity: "Who OpenDuet is"
        case .persona: "Persona"
        case .tone: "Tone"
        case .soulExtra: "Here, OpenDuet also…"
        }
    }
}

/// A decided M11 card folded to one line: "<glyph> Tone · Applied ⌄"; tap shows the card again.
struct FoldedCardLine: View {
    var glyph: DuetGlyph
    var tint: Color
    /// one translatable line ("Tone · Applied", "Connected · Weather")
    var label: Text
    /// nil: the line can't expand (nothing more to show)
    var onExpand: (() -> Void)?

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14

    var body: some View {
        if let onExpand {
            Button(action: onExpand) { line(expandable: true) }
                .buttonStyle(PressableButtonStyle(scale: 0.98))
                .accessibilityElement(children: .combine)
                .accessibilityHint(Text("Shows the card"))
        } else {
            line(expandable: false)
                .accessibilityElement(children: .combine)
        }
    }

    private func line(expandable: Bool) -> some View {
        HStack(spacing: 8) {
            DuetIcon(glyph: glyph, size: fontSize + 2, tint: tint)
            label.lineLimit(1)
            Spacer(minLength: 4)
            if expandable {
                Image(systemName: "chevron.down").font(.system(size: fontSize - 2, weight: .semibold)).accessibilityHidden(true)
            }
        }
        .font(.system(size: fontSize))
        .foregroundStyle(Palette.secondaryText)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(corner: 14)
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
