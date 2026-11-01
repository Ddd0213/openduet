// M22 soul_setup: the end of setting up "who OpenDuet is" in the chat (propose_soul_setup). In the
// look of the soul proposal card (SoulProposalCard): one row per field, "now → new" (an empty
// side reads as that field's default: "OpenDuet", your first name, Default), the reason, then
// Apply (action "apply": every field at once) / Not now ("dismiss": nothing changes). Busy and
// failed taps as soul_proposal's. Applied / Not now fold to one line that shows the card again;
// superseded (a newer card replaced it) folds to one grey line. An Apply bumps SoulRevision so
// the Who OpenDuet is page shows the new values.
import SwiftUI

struct SoulSetupCard: View {
    var message: Message
    var payload: SoulSetupPayload
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
    @ScaledMetric(relativeTo: .body) private var valueSize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 12.5
    @ScaledMetric(relativeTo: .subheadline) private var reasonSize: CGFloat = 14

    private var phase: SoulSetupPhase { SoulSetupPhase(payload.state, request: context.requests[message.id]) }

    var body: some View {
        let phase = phase
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            if phase == .superseded {
                FoldedCardLine(glyph: .edit, tint: Palette.secondaryText, label: Text("Replaced by a newer card"), onExpand: nil)
                    .transition(.opacity)
            } else if phase.isDecided && !expanded {
                let title = String(localized: "Who OpenDuet is")
                FoldedCardLine(
                    glyph: phase == .applied ? .done : .edit,
                    tint: phase == .applied ? Palette.success : Palette.secondaryText,
                    label: phase == .applied ? Text("\(title) · Applied") : Text("\(title) · Not now"),
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
            switch new {
            case .applied:
                guard lastTap != nil else { return }
                successes += 1
                lastTap = nil
                expanded = false
                SoulRevision.shared.applied()
            case .dismissed, .superseded:
                lastTap = nil
                expanded = false
            case .failed:
                if lastTap != nil { failures += 1 }
            case .open, .busy:
                break
            }
        }
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.warning, trigger: failures)
    }

    private func card(_ phase: SoulSetupPhase) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                DuetIcon(glyph: .edit, size: 18, tint: Palette.accent)
                Text("Set up who OpenDuet is")
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(payload.rows, id: \.field) { row in
                    fieldRow(row)
                }
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

    /// "Tone" over "warm → warm and brief", in a tinted block with the diff bar of the proposal card.
    private func fieldRow(_ row: SoulSetupPayload.Field) -> some View {
        let now = SoulSetupValue(row.current, field: row.field)
        let new = SoulSetupValue(row.proposed, field: row.field)
        let arrow: Text = Text(verbatim: "  \u{2192}  ").foregroundStyle(Palette.secondaryText)
        let line: Text = value(now, proposed: false) + arrow + value(new, proposed: true)
        return VStack(alignment: .leading, spacing: 4) {
            Text(SoulFieldLabel.title(row.field))
                .font(.system(size: labelSize, weight: .semibold))
                .foregroundStyle(Palette.accent)
            line
                .font(.system(size: valueSize))
                .lineLimit(showsAll ? nil : 4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Palette.success.opacity(0.07))
        )
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                .fill(Palette.success.opacity(0.6))
                .frame(width: 3)
                .padding(.vertical, 8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(SoulFieldLabel.title(row.field)))
        .accessibilityValue(spoken(now: now, new: new))
    }

    /// VoiceOver: "Now: warm. Proposed: warm and brief" (the arrow isn't read).
    private func spoken(now: SoulSetupValue, new: SoulSetupValue) -> Text {
        let before: Text = Text("Now") + Text(verbatim: ": ") + value(now, proposed: false)
        let after: Text = Text("Proposed") + Text(verbatim: ": ") + value(new, proposed: true)
        return before + Text(verbatim: ". ") + after
    }

    /// One side: the text, or the field's default in italics (grey now, ink for the new value).
    private func value(_ value: SoulSetupValue, proposed: Bool) -> Text {
        let color = proposed ? Palette.primaryText : Palette.secondaryText
        switch value {
        case .text(let text):
            return Text(verbatim: text).foregroundStyle(color).fontWeight(proposed ? .medium : .regular)
        case .assistant:
            return Text(verbatim: "OpenDuet").foregroundStyle(color).italic()
        case .firstName:
            return Text("Your first name").foregroundStyle(color).italic()
        case .standard:
            return Text("Default").foregroundStyle(color).italic()
        }
    }

    /// A row would run past four lines on a phone: offer "Show all".
    private var isLong: Bool {
        payload.rows.contains { row in
            row.current.count + row.proposed.count > 200
                || row.current.split(separator: "\n").count + row.proposed.split(separator: "\n").count > 4
        }
    }

    @ViewBuilder
    private func footer(_ phase: SoulSetupPhase) -> some View {
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
        case .superseded:
            EmptyView()
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
