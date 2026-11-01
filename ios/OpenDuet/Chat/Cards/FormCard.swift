// M9: the assistant's form card (kind "form", the ask_form tool, contract §2): the assistant asks its choices
// through a native card instead of "reply 1A 2B". The question sits on the assistant's bubble surface:
// a DuetIconTile, the title and description, then each field with its label and full-width
// option rows (a dashed hairline while unpicked; a solid dark border, primary text and a black
// check once picked, with a spring and a selection tick). "Other…" turns into an inline field;
// text fields are dashed boxes that turn solid on focus. One required single field without
// Other submits on the tap once the check has landed; otherwise Submit enables when the required
// fields are answered. Skip dismisses. Submitted: the unpicked rows fold away and the picks stay,
// with a grey "Sent". Skipped: one grey line ("Withdrawn" when the assistant took it back, M29).
// The rules live in FormLogic.swift (host-tested); the rows in FormPieces.swift.
import SwiftUI

struct FormCardView: View {
    var message: Message
    var payload: FormPayload
    var streaming: Bool
    var actions: ShellActions
    var onSent: () -> Void

    @Environment(\.cardContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft = FormDraft()
    /// Tapped here and not echoed by the store yet: guards a double tap.
    @State private var waiting = false
    @State private var lastTap: Tap = .submit
    @State private var pendingSubmit: Task<Void, Never>?
    @State private var picks = 0
    @State private var sends = 0
    @FocusState private var focus: ID?

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 15
    @ScaledMetric(relativeTo: .subheadline) private var noteSize: CGFloat = 14

    private enum Tap { case submit, skip }

    private var request: CardRequest? { context.requests[message.id] }
    private var inFlight: Bool { request == .inFlight }
    private var failure: String? { request?.failureReason }
    private var interactive: Bool { payload.state == .open && !inFlight && !waiting }
    private var tapToSubmit: Bool { FormLogic.submitsOnTap(payload.fields) }
    private var canSubmit: Bool { FormLogic.canSubmit(payload.fields, draft: draft) }
    private var hasDescription: Bool { !(payload.description ?? "").isEmpty }
    /// What the rows show: the draft while open, the stored answers once submitted.
    private var shown: FormDraft {
        guard payload.state == .submitted, let answers = payload.answers else { return draft }
        return FormLogic.draft(from: answers, fields: payload.fields)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text, streaming: streaming)
            if payload.state == .dismissed {
                skippedLine.transition(.opacity)
            } else {
                card.transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.3) : .spring(response: 0.45, dampingFraction: 0.86), value: payload.state)
        .animation(.easeInOut(duration: 0.2), value: failure)
        .animation(.easeInOut(duration: 0.2), value: inFlight)
        // Light for a pick and for a send (L186); warning when the server says no.
        .sensoryFeedback(.selection, trigger: picks)
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
        .onChange(of: payload.state) { waiting = false }
        .onChange(of: request) { waiting = false }
        .task(id: waiting) {
            // Nothing came back (no store, no echo): don't lock the card.
            guard waiting else { return }
            try? await Task.sleep(for: .seconds(8))
            if !Task.isCancelled { waiting = false }
        }
    }

    // MARK: Card

    private var card: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            ForEach(visibleFields) { field in
                FormFieldView(
                    field: field, draft: shown, submitted: payload.state == .submitted,
                    interactive: interactive, tapToSubmit: tapToSubmit, focus: $focus,
                    text: textBinding(field.id),
                    onPick: { pick($0, in: field) }, onOther: { toggleOther(field) }
                )
                .transition(.opacity)
            }
            footer
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Metrics.bubbleCorner, style: .continuous).fill(Palette.assistantBubble))
        .accessibilityElement(children: .contain)
    }

    /// Submitted: only the fields that were answered.
    private var visibleFields: [FormField] {
        guard payload.state == .submitted else { return payload.fields }
        return payload.fields.filter { FormLogic.isAnswered($0, draft: shown) }
    }

    private var header: some View {
        HStack(alignment: hasDescription ? .top : .center, spacing: 12) {
            DuetIconTile(icon: payload.icon)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: payload.title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.assistantText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let description = payload.description, !description.isEmpty {
                    Text(verbatim: description)
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: Footer

    @ViewBuilder private var footer: some View {
        if payload.state == .open {
            VStack(alignment: .leading, spacing: 10) {
                if let failure { FormFailureLine(reason: failure).transition(.opacity) }
                HStack(spacing: 12) {
                    Button(action: skip) {
                        Text("Skip")
                            .font(.system(size: noteSize + 1, weight: .medium))
                            .foregroundStyle(Palette.secondaryText)
                            .opacity(inFlight && lastTap == .skip ? 0 : 1)
                            .overlay { if inFlight && lastTap == .skip { ProgressView().controlSize(.small) } }
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableButtonStyle(scale: 0.94))
                    .disabled(!interactive)
                    .accessibilityHint(Text("Skips these questions"))
                    Spacer(minLength: 0)
                    if !tapToSubmit {
                        CapsuleButton(title: submitTitle, style: .filled, busy: inFlight && lastTap == .submit, fullWidth: false, action: submit)
                            .disabled(!interactive || !canSubmit)
                    } else if inFlight && lastTap == .submit {
                        ProgressView().controlSize(.small).transition(.opacity)
                    }
                }
            }
        } else {
            HStack(spacing: 6) {
                if inFlight {
                    ProgressView().controlSize(.mini)
                } else {
                    DuetIcon(glyph: .sent, size: noteSize, tint: Palette.secondaryText)
                }
                Text("Sent")
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.secondaryText)
            }
            .accessibilityElement(children: .combine)
            .transition(.opacity)
        }
    }

    private var submitTitle: Text {
        if let label = payload.submitLabel, !label.isEmpty { Text(verbatim: label) } else { Text("Send") }
    }

    /// Skipped: one grey line in place of the card. M29: "Withdrawn" when the assistant took
    /// it back (payload closedBy "assistant").
    private var skippedLine: some View {
        HStack(spacing: 8) {
            DuetIcon(payload.icon, size: noteSize + 3, tint: Palette.secondaryText)
            Text(verbatim: payload.title).lineLimit(1)
            Text(verbatim: "·").accessibilityHidden(true)
            (payload.isWithdrawn ? Text("Withdrawn") : Text("Skipped")).fixedSize()
        }
        .font(.system(size: noteSize))
        .foregroundStyle(Palette.secondaryText)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Capsule().fill(Palette.assistantBubble))
        .accessibilityElement(children: .combine)
    }

    // MARK: Actions

    private var pickAnimation: Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.32, dampingFraction: 0.72)
    }

    private func pick(_ optionId: ID, in field: FormField) {
        guard interactive else { return }
        withAnimation(pickAnimation) { FormLogic.toggle(optionId, in: field, draft: &draft) }
        picks += 1
        if tapToSubmit, draft.isSelected(optionId, in: field.id) { scheduleSubmit() }
    }

    private func toggleOther(_ field: FormField) {
        guard interactive else { return }
        withAnimation(pickAnimation) { FormLogic.toggleOther(in: field, draft: &draft) }
        picks += 1
        guard draft.isOtherOn(field.id) else {
            if focus == field.id { focus = nil }
            return
        }
        // The text field exists from the next frame on.
        Task {
            try? await Task.sleep(for: .milliseconds(80))
            focus = field.id
        }
    }

    /// One tap answers the form: let the check land (~0.35 s), then send.
    private func scheduleSubmit() {
        pendingSubmit?.cancel()
        pendingSubmit = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            submit()
        }
    }

    private func submit() {
        guard interactive, canSubmit else { return }
        let answers = FormLogic.answers(payload.fields, draft: draft)
        let summary = FormLogic.summary(payload.fields, answers: answers)
        lastTap = .submit
        waiting = true
        focus = nil
        sends += 1
        actions.cards.submitForm(message.id, answers, summary)
        onSent()
    }

    private func skip() {
        guard interactive else { return }
        pendingSubmit?.cancel()
        lastTap = .skip
        waiting = true
        focus = nil
        actions.cards.dismissForm(message.id)
    }

    /// A text field's or Other's text: the draft while open, the stored answer once submitted.
    private func textBinding(_ fieldId: ID) -> Binding<String> {
        Binding(
            get: { shown.text[fieldId] ?? "" },
            set: { FormLogic.setText($0, in: fieldId, draft: &draft) }
        )
    }
}
