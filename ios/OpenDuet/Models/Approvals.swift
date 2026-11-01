// Approval cards and spend requests (backend/src/contract/approvals.ts). Approve executes
// exactly the stored arguments on the server and must carry the version the card showed.
import Foundation

enum ApprovalKind: String, Decodable, Sendable { case email, payment, sign, delete, action }
enum ApprovalStatus: String, Decodable, Sendable { case pending, approved, declined, expired }

/// A labelled row on sign / delete / generic cards (never raw JSON).
struct DetailRow: Decodable, Hashable, Sendable {
    var label: String
    var value: String
}

struct EmailPreview: Decodable, Hashable, Sendable {
    struct Attachment: Decodable, Hashable, Sendable {
        var name: String
        var mime: String
        var fileId: ID?
    }
    var app: String
    var to: [String]
    var cc: [String]
    var subject: String
    var body: String
    var attachments: [Attachment]
}

struct PaymentPreview: Decodable, Hashable, Sendable {
    /// Minor units (cents); the app formats it in the current locale.
    var amount: Int
    var currency: String
    var merchant: String
    var description: String
    var testMode: Bool
}

/// Sign and delete cards share this shape.
struct RowsPreview: Decodable, Hashable, Sendable {
    var app: String
    var title: String
    var rows: [DetailRow]
}

struct ActionPreview: Decodable, Hashable, Sendable {
    var app: String
    /// The tool's human name, e.g. "Create calendar event".
    var toolName: String
    var rows: [DetailRow]
    /// M20: set on a browser approval (a consequential click in the assistant's browser).
    var browser: BrowserAction?
}

/// M20: what a consequential click in the assistant's browser would do (contract/m20.ts BrowserAction).
struct BrowserAction: Decodable, Hashable, Sendable {
    enum Category: String, Decodable, Hashable, Sendable {
        case purchase, account, send, delete, submit
        /// An unknown category from a newer server reads as the strictest one.
        init(from decoder: Decoder) throws {
            self = Category(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .purchase
        }
        /// Purchases and account or security changes always ask: no Always is offered for them.
        var isFloor: Bool { self == .purchase || self == .account }
    }
    enum Via: String, Decodable, Hashable, Sendable {
        case click, submit, enter
        init(from decoder: Decoder) throws {
            self = Via(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .click
        }
    }
    /// registrable site, e.g. "amazon.com"
    var site: String
    /// the button's accessible name exactly as the page shows it
    var button: String
    var category: Category
    var via: Via
}

/// M20: what "Always" on an approval card would cover; nil on the card = no Always row.
struct ApprovalAlways: Decodable, Hashable, Sendable {
    enum Scope: String, Decodable, Hashable, Sendable {
        /// this tool, only for these recipients (value: the addresses)
        case recipient
        /// browser clicks of `category` on this site (value: the site)
        case site
        /// a scope this app doesn't know: the card shows no Always row
        case unknown
        init(from decoder: Decoder) throws {
            self = Scope(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }
    var scope: Scope
    var value: String
    var category: BrowserAction.Category?
}

enum ApprovalPreview: Decodable, Hashable, Sendable {
    case email(EmailPreview)
    case payment(PaymentPreview)
    case sign(RowsPreview)
    case delete(RowsPreview)
    case action(ActionPreview)

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Discriminator.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "email": self = .email(try EmailPreview(from: decoder))
        case "payment": self = .payment(try PaymentPreview(from: decoder))
        case "sign": self = .sign(try RowsPreview(from: decoder))
        case "delete": self = .delete(try RowsPreview(from: decoder))
        case "action": self = .action(try ActionPreview(from: decoder))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown preview kind \(other)")
        }
    }
}

struct Approval: Decodable, Hashable, Sendable, Identifiable {
    /// What happened after Approve; the app picks "Sent" / "Paid" / ... from `kind`.
    struct Outcome: Decodable, Hashable, Sendable {
        var ok: Bool
        /// Failure reason shown inline with Retry and Edit.
        var error: Phrase?
    }
    var id: ID
    var kind: ApprovalKind
    var status: ApprovalStatus
    var version: Int
    var preview: ApprovalPreview
    /// Set for payments and spend requests only.
    var expiresAt: Date?
    var taskId: ID?
    var messageId: ID?
    var result: Outcome?
    /// Fields changed by the latest edit by chat; the card glows them for ~3 s.
    var changedFields: [String]
    /// M20: why this needs the user ("Why am I asked?"); nil on cards that explain themselves.
    var why: Phrase?
    /// M20: what an "Always" on this card would cover; nil = the card offers no Always.
    var always: ApprovalAlways?
    var updatedAt: Date
}

/// POST /api/approvals/:id/approve and /decline. M20: Approve with `always: true` also stores
/// an Always rule for the card's `always` scope (left out = nil, so older requests are unchanged).
struct ApprovalDecisionRequest: Codable, Hashable, Sendable {
    var version: Int
    var always: Bool?
}

/// 200 response of approve / decline (409 stale_version is an ApiErrorBody).
struct ApprovalDecisionResponse: Decodable, Sendable {
    var approval: Approval
}

/// A Link-style spend request card. Test mode: nothing is charged.
struct SpendRequest: Decodable, Hashable, Sendable, Identifiable {
    var id: ID
    var approvalId: ID
    var amount: Int
    var currency: String
    var merchant: String
    var description: String
    var item: String
    var expiresAt: Date
    var status: ApprovalStatus
    var testMode: Bool
}
