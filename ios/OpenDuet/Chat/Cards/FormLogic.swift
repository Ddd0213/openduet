// M9: the form card's rules (contract §2), apart from the view so they are host-tested: what
// a tap does to the draft, when a field counts as answered, the [FormAnswer] the app submits,
// the readable "label: answer" summary the user's bubble shows, and whether the card submits on
// the first tap. Pure Foundation; compiles with Models/*.swift alone.
import Foundation

/// What the user has picked and typed so far, by field id. "Other" is a row of its own: on
/// while its text field shows; its text is kept when it is switched off so it comes back.
struct FormDraft: Hashable, Sendable {
    var selected: [ID: Set<ID>] = [:]
    var otherOn: Set<ID> = []
    var text: [ID: String] = [:]

    func isSelected(_ optionId: ID, in fieldId: ID) -> Bool {
        selected[fieldId]?.contains(optionId) ?? false
    }

    func isOtherOn(_ fieldId: ID) -> Bool { otherOn.contains(fieldId) }
}

enum FormLogic {
    /// The server's limits (FormAnswer: text ≤ 4000, optionIds ≤ 10).
    static let maxText = 4000
    static let maxOptions = 10

    // MARK: Taps

    /// A tap on an option row. Single: picks it (and turns Other off); tapping the chosen row
    /// again clears it only when the field is optional. Multi: toggles it.
    static func toggle(_ optionId: ID, in field: FormField, draft: inout FormDraft) {
        guard let choice = field.choice, choice.options.contains(where: { $0.id == optionId }) else { return }
        var chosen = draft.selected[field.id] ?? []
        if choice.multi {
            if chosen.contains(optionId) {
                chosen.remove(optionId)
            } else if chosen.count + (draft.isOtherOn(field.id) ? 1 : 0) < maxOptions {
                chosen.insert(optionId)
            }
        } else if chosen.contains(optionId) {
            if !field.required { chosen = [] }
        } else {
            chosen = [optionId]
            draft.otherOn.remove(field.id)
        }
        draft.selected[field.id] = chosen
    }

    /// A tap on the "Other…" row (allowOther only). Single: Other replaces the chosen option.
    /// Multi: Other is one more checked row next to the options.
    static func toggleOther(in field: FormField, draft: inout FormDraft) {
        guard let choice = field.choice, choice.allowOther else { return }
        if draft.isOtherOn(field.id) {
            draft.otherOn.remove(field.id)
        } else {
            draft.otherOn.insert(field.id)
            if !choice.multi { draft.selected[field.id] = [] }
        }
    }

    /// The typed text of a text field or of "Other", capped at the server's limit.
    static func setText(_ text: String, in fieldId: ID, draft: inout FormDraft) {
        draft.text[fieldId] = String(text.prefix(maxText))
    }

    // MARK: Answers

    /// The text that counts for a field: a text field's text, or Other's while it is on.
    /// Blank (only spaces / newlines) counts as nothing.
    static func typed(_ field: FormField, draft: FormDraft) -> String? {
        if field.choice != nil, !draft.isOtherOn(field.id) { return nil }
        let value = (draft.text[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : String(value.prefix(maxText))
    }

    /// The field's answer, nil while it has none. Option ids follow the field's own order.
    static func answer(_ field: FormField, draft: FormDraft) -> FormAnswer? {
        let text = typed(field, draft: draft)
        guard let choice = field.choice else {
            return text.map { FormAnswer(fieldId: field.id, optionIds: [], text: $0) }
        }
        let chosen = draft.selected[field.id] ?? []
        var ids = choice.options.map(\.id).filter { chosen.contains($0) }
        if !choice.multi { ids = Array(ids.prefix(1)) }
        // Single: an option or Other's text, never both (toggle keeps them apart).
        let other = choice.multi || ids.isEmpty ? text : nil
        guard !ids.isEmpty || other != nil else { return nil }
        return FormAnswer(fieldId: field.id, optionIds: Array(ids.prefix(maxOptions)), text: other)
    }

    static func isAnswered(_ field: FormField, draft: FormDraft) -> Bool {
        answer(field, draft: draft) != nil
    }

    /// Every answered field, in the form's order (unanswered optional fields are left out).
    static func answers(_ fields: [FormField], draft: FormDraft) -> [FormAnswer] {
        fields.compactMap { answer($0, draft: draft) }
    }

    /// Submit enables once every required field is answered and there is at least one answer
    /// (the server takes 1-8).
    static func canSubmit(_ fields: [FormField], draft: FormDraft) -> Bool {
        fields.allSatisfy { !$0.required || isAnswered($0, draft: draft) } && !answers(fields, draft: draft).isEmpty
    }

    /// Exactly one required single-choice field without "Other": the first tap is the answer,
    /// so the card submits on it (no Submit button).
    static func submitsOnTap(_ fields: [FormField]) -> Bool {
        guard fields.count == 1, let field = fields.first, field.required,
              case .single(_, let allowOther) = field.kind else { return false }
        return !allowOther
    }

    // MARK: Summary

    /// One "label: answer" line per answered field: option labels (multi joined with ", "),
    /// Other's or a text field's typed text. This is the text of the user's message.
    static func summary(_ fields: [FormField], answers: [FormAnswer]) -> String {
        let byField = Dictionary(answers.map { ($0.fieldId, $0) }, uniquingKeysWith: { first, _ in first })
        return fields.compactMap { field -> String? in
            guard let answer = byField[field.id], let text = answerText(field, answer: answer) else { return nil }
            return "\(field.label): \(text)"
        }
        .joined(separator: "\n")
    }

    /// An answer as the user reads it; newlines in typed text become spaces so each field
    /// stays on its own line.
    static func answerText(_ field: FormField, answer: FormAnswer) -> String? {
        var parts: [String] = []
        if let choice = field.choice {
            parts = choice.options.filter { answer.optionIds.contains($0.id) }.map(\.label)
        }
        if let text = answer.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            parts.append(text.split(whereSeparator: \.isNewline).joined(separator: " "))
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    // MARK: Submitted cards

    /// The draft a submitted card shows: its answers as picks and text.
    static func draft(from answers: [FormAnswer], fields: [FormField]) -> FormDraft {
        var draft = FormDraft()
        for answer in answers {
            guard let field = fields.first(where: { $0.id == answer.fieldId }) else { continue }
            if !answer.optionIds.isEmpty { draft.selected[field.id] = Set(answer.optionIds) }
            if let text = answer.text, !text.isEmpty {
                draft.text[field.id] = text
                if field.choice != nil { draft.otherOn.insert(field.id) }
            }
        }
        return draft
    }
}

extension FormField {
    /// The option list of a single / multi field; nil for a text field.
    var choice: (options: [FormOption], allowOther: Bool, multi: Bool)? {
        switch kind {
        case .single(let options, let allowOther): (options, allowOther, false)
        case .multi(let options, let allowOther): (options, allowOther, true)
        case .text: nil
        }
    }
}
