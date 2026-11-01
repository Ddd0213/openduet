// M23 W5 (#34, review-ux §10; M20 left it for cards the server doesn't explain): why an approval
// card asks, and whether it offers the fainter "Always allow" row. The server's own reason
// (`approval.why`: browser clicks, safety-floor tools) wins; otherwise the card says it from its
// own fields: an email goes out in your name, a payment, a signature, a delete that can't be
// undone, a send to other people, something changed on the assistant's computer or in an app. Always
// shows only for low-risk kinds: never payments, signatures, deletes, purchases or account
// changes, even when a card carries an `always` scope. Pure Foundation (host-tested).
import Foundation

enum ApprovalWhy: Hashable, Sendable {
    /// The server's reason (a Phrase key, rendered by PhraseText).
    case server(Phrase)
    /// The card's own line, already in the user's language.
    case derived(String)
}

enum ApprovalWhyRules {
    /// The line under the preview: the server's reason on any card, else the card's own while it
    /// still waits on the user (a decided card in the history doesn't need to explain itself).
    static func why(_ approval: Approval) -> ApprovalWhy? {
        if let why = approval.why { return .server(why) }
        guard approval.status == .pending else { return nil }
        return derived(approval.preview, always: approval.always).map(ApprovalWhy.derived)
    }

    /// The card's own reason, from its kind and preview.
    static func derived(_ preview: ApprovalPreview, always: ApprovalAlways? = nil) -> String? {
        switch preview {
        case .email:
            return String(localized: "It sends an email in your name.")
        case .payment:
            return String(localized: "It moves money. Payments always ask.")
        case .sign:
            return String(localized: "It signs something in your name.")
        case .delete:
            return String(localized: "It deletes something, and that can't be undone.")
        case .action(let action):
            if action.browser != nil { return nil }
            if always?.scope == .recipient { return String(localized: "It sends something to other people.") }
            let app = action.app.trimmingCharacters(in: .whitespacesAndNewlines)
            if app == computerApp { return String(localized: "It changes something on OpenDuet's computer.") }
            // A skill's script names the skill ("/meeting-notes"), not an app.
            if app.hasPrefix("/") { return String(localized: "It runs a script on OpenDuet's computer.") }
            if app.isEmpty { return String(localized: "It changes something outside this chat.") }
            return String(localized: "It changes something in \(app).")
        }
    }

    /// The fainter "Always allow …" row under the buttons: only when the card offers an Always
    /// the app can say exactly (ApprovalAlwaysRules.rowText) and the action is low-risk.
    static func showsAlways(_ approval: Approval) -> Bool {
        guard ApprovalAlwaysRules.rowText(approval.always) != nil else { return false }
        switch approval.preview {
        case .payment, .sign, .delete:
            return false
        case .email:
            return true
        case .action(let action):
            guard let category = action.browser?.category ?? approval.always?.category else { return true }
            return isLowRisk(category)
        }
    }

    /// Browser clicks that can be allowed for a site: sending and submitting forms. Purchases,
    /// account changes and deletes always ask.
    static func isLowRisk(_ category: BrowserAction.Category) -> Bool {
        switch category {
        case .send, .submit: true
        case .purchase, .account, .delete: false
        }
    }

    /// The display name of the assistant's computer on action cards (approvals/service.ts, computer/).
    static let computerApp = "OpenDuet's computer"
}
