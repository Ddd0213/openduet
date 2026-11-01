// The form card's pieces (FormCard.swift): one field (label header, hint, rows), the option
// row (dashed hairline -> solid dark border with a black check, ref-bubble-menu-form.png), the
// "Other…" row that turns into an inline field, the dashed text box that turns solid on focus,
// and the inline red failure line.
import SwiftUI

extension Palette {
    /// Unpicked option rows and empty text boxes: a dashed hairline.
    static let formDash = Color.dynamic(light: 0x141413, dark: 0xF2F2F2).opacity(0.28)
    /// Picked rows and filled boxes: a solid dark (light in dark mode) border.
    static let formSolid = Color.dynamic(light: 0x141413, dark: 0xF2F2F2)
}

extension Metrics {
    /// Option rows: ~52 pt tall, 12 pt continuous corners.
    static let formRowHeight: CGFloat = 52
    static let formRowCorner: CGFloat = 12
    static let formCheck: CGFloat = 24
}

/// One question: its label (a VoiceOver header), a hint, then its rows or text box. Submitted,
/// only the picks stay; the other rows fold away.
struct FormFieldView: View {
    var field: FormField
    var draft: FormDraft
    var submitted: Bool
    var interactive: Bool
    var tapToSubmit: Bool
    var focus: FocusState<ID?>.Binding
    var text: Binding<String>
    var onPick: (_ optionId: ID) -> Void
    var onOther: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var labelSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var hintSize: CGFloat = 13

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: field.label)
                    .font(.system(size: labelSize, weight: .medium))
                    .foregroundStyle(Palette.assistantText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let hint {
                    hint
                        .font(.system(size: hintSize))
                        .foregroundStyle(Palette.secondaryText)
                }
            }
            if let choice = field.choice {
                VStack(spacing: 8) {
                    ForEach(rows(choice.options)) { option in
                        FormOptionRow(
                            label: option.label, detail: option.detail,
                            selected: draft.isSelected(option.id, in: field.id),
                            hint: tapToSubmit ? Text("Sends this answer") : nil
                        ) { onPick(option.id) }
                        .transition(fold)
                    }
                    if choice.allowOther, !submitted || draft.isOtherOn(field.id) {
                        FormOtherRow(
                            fieldId: field.id, fieldLabel: field.label, on: draft.isOtherOn(field.id),
                            canTurnOff: choice.multi && !submitted, readOnly: submitted,
                            text: text, focus: focus, onToggle: onOther
                        )
                        .transition(fold)
                    }
                }
                .disabled(!interactive)
            } else if case .text(let placeholder, let multiline) = field.kind {
                FormTextBox(
                    fieldId: field.id, fieldLabel: field.label, placeholder: placeholder,
                    multiline: multiline, readOnly: submitted, text: text, focus: focus
                )
                .disabled(!interactive && !submitted)
            }
        }
    }

    /// Submitted: only the picked options.
    private func rows(_ options: [FormOption]) -> [FormOption] {
        submitted ? options.filter { draft.isSelected($0.id, in: field.id) } : options
    }

    /// Rows that weren't picked fade and fold up as the card turns "Sent".
    private var fold: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .opacity, removal: .opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
    }

    /// "Choose one or more" / "Optional · choose any" under a multi field, "Optional" under an
    /// optional one; nothing once sent.
    private var hint: Text? {
        guard !submitted else { return nil }
        switch field.kind {
        case .multi: return field.required ? Text("Choose one or more") : Text("Optional · choose any")
        case .single, .text: return field.required ? nil : Text("Optional")
        }
    }
}

/// A full-width option row: a dashed hairline and secondary text while unpicked; a solid dark
/// border, primary text and the black check at the trailing end once picked.
struct FormOptionRow: View {
    var label: String
    var detail: String?
    var selected: Bool
    var hint: Text?
    var action: () -> Void

    @ScaledMetric(relativeTo: .body) private var labelSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var detailSize: CGFloat = 13
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = Metrics.formRowHeight

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: label)
                        .font(.system(size: labelSize, weight: selected ? .medium : .regular))
                        .foregroundStyle(selected ? Palette.assistantText : Palette.secondaryText)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail, !detail.isEmpty {
                        Text(verbatim: detail)
                            .font(.system(size: detailSize))
                            .foregroundStyle(Palette.secondaryText)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if selected {
                    FormCheck().transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
            .background(FormRowBorder(solid: selected))
            .contentShape(RoundedRectangle(cornerRadius: Metrics.formRowCorner, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: [label, detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". ")))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint(hint ?? Text(verbatim: ""))
    }
}

/// The row outline: dashed hairline, or a solid border once picked or filled.
struct FormRowBorder: View {
    var solid: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Metrics.formRowCorner, style: .continuous)
        ZStack {
            shape.strokeBorder(Palette.formDash, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                .opacity(solid ? 0 : 1)
            shape.strokeBorder(Palette.formSolid, lineWidth: 1.2)
                .opacity(solid ? 1 : 0)
        }
    }
}

/// The black filled circle with a check (white in dark mode, with a dark check).
struct FormCheck: View {
    var body: some View {
        Circle()
            .fill(Palette.formSolid)
            .frame(width: Metrics.formCheck, height: Metrics.formCheck)
            .overlay { DuetIcon(glyph: .check, size: Metrics.formCheck * 0.62, tint: Palette.assistantBubble) }
            .accessibilityHidden(true)
    }
}

/// "Other…": a dashed row that turns into a solid row with an inline text field and the check.
struct FormOtherRow: View {
    var fieldId: ID
    var fieldLabel: String
    var on: Bool
    /// multi: the check turns Other off again (single: picking an option does)
    var canTurnOff: Bool
    var readOnly: Bool
    var text: Binding<String>
    var focus: FocusState<ID?>.Binding
    var onToggle: () -> Void

    @ScaledMetric(relativeTo: .body) private var labelSize: CGFloat = 16
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = Metrics.formRowHeight

    var body: some View {
        if on {
            HStack(spacing: 12) {
                Group {
                    if readOnly {
                        Text(verbatim: text.wrappedValue)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        TextField(text: text, prompt: Text("Type your answer")) { Text("Other, \(fieldLabel)") }
                            .focused(focus, equals: fieldId)
                            .submitLabel(.done)
                            .onSubmit { focus.wrappedValue = nil }
                    }
                }
                .font(.system(size: labelSize, weight: .medium))
                .foregroundStyle(Palette.assistantText)
                Button(action: onToggle) { FormCheck() }
                    .buttonStyle(PressableButtonStyle(scale: 0.9))
                    .disabled(!canTurnOff)
                    .accessibilityLabel(Text("Remove your own answer"))
                    .accessibilityHidden(!canTurnOff)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
            .background(FormRowBorder(solid: true))
            .transition(.opacity)
        } else {
            Button(action: onToggle) {
                HStack(spacing: 10) {
                    DuetIcon(glyph: .edit, size: labelSize, tint: Palette.secondaryText)
                    Text("Other…")
                        .font(.system(size: labelSize))
                        .foregroundStyle(Palette.secondaryText)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
                .background(FormRowBorder(solid: false))
                .contentShape(RoundedRectangle(cornerRadius: Metrics.formRowCorner, style: .continuous))
            }
            .buttonStyle(PressableButtonStyle(scale: 0.98))
            .accessibilityHint(Text("Type your own answer"))
            .transition(.opacity)
        }
    }
}

/// A text field: a dashed box that turns solid while focused or once it has text.
struct FormTextBox: View {
    var fieldId: ID
    var fieldLabel: String
    var placeholder: String?
    var multiline: Bool
    var readOnly: Bool
    var text: Binding<String>
    var focus: FocusState<ID?>.Binding

    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 16
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = Metrics.formRowHeight

    private var solid: Bool {
        focus.wrappedValue == fieldId || !text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var prompt: Text {
        if let placeholder, !placeholder.isEmpty { Text(verbatim: placeholder) } else { Text("Type your answer") }
    }

    var body: some View {
        Group {
            if readOnly {
                Text(verbatim: text.wrappedValue)
                    .fixedSize(horizontal: false, vertical: true)
            } else if multiline {
                TextField(text: text, prompt: prompt, axis: .vertical) { Text(verbatim: fieldLabel) }
                    .lineLimit(3...8)
                    .focused(focus, equals: fieldId)
            } else {
                TextField(text: text, prompt: prompt) { Text(verbatim: fieldLabel) }
                    .submitLabel(.done)
                    .focused(focus, equals: fieldId)
                    .onSubmit { focus.wrappedValue = nil }
            }
        }
        .font(.system(size: textSize))
        .foregroundStyle(Palette.assistantText)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
        .background(FormRowBorder(solid: solid || readOnly))
        .animation(.easeInOut(duration: 0.18), value: solid)
    }
}

/// The inline red reason under a failed Send or Skip; the controls are enabled again.
struct FormFailureLine: View {
    var reason: String

    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 14

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            DuetIcon(glyph: .warning, size: fontSize + 1, tint: Palette.failure)
                .padding(.top, 1)
            Text(verbatim: reason)
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.failure)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
