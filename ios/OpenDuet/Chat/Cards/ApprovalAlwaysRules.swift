// M20 (#4, the safety floor): the words of an approval card's Always row, of a browser card's
// "how", and of the line under an Ask / Always picker whose Always is disabled. Pure Foundation,
// host-tested. Purchases and account changes never come with an Always; an unknown scope shows
// no row.
import Foundation

enum ApprovalAlwaysRules {
    /// The Always row under a pending card's buttons, saying exactly what it covers; nil = no row.
    /// recipient: "Always allow sending to sam@example.com"; site: "Always allow sending on
    /// forum.example.org" (one sentence per kind of click, so each language can order its words).
    static func rowText(_ always: ApprovalAlways?) -> String? {
        guard let always, !always.value.isEmpty else { return nil }
        let value = always.value
        switch always.scope {
        case .recipient:
            return String(localized: "Always allow sending to \(value)")
        case .site:
            switch always.category {
            case .send: return String(localized: "Always allow sending on \(value)")
            case .delete: return String(localized: "Always allow deleting on \(value)")
            case .submit: return String(localized: "Always allow submitting forms on \(value)")
            case .purchase, .account, nil: return nil
            }
        case .unknown:
            return nil
        }
    }

    /// How a browser card's click happens ("Click", "Submit", "Enter").
    static func how(_ via: BrowserAction.Via) -> String {
        switch via {
        case .click: String(localized: "Click")
        case .submit: String(localized: "Submit")
        case .enter: String(localized: "Enter")
        }
    }

    /// The line under a tool's Ask / Always picker when Always is disabled; nil when Always is
    /// allowed or the server gave no reason.
    static func blockedLine(alwaysAllowed: Bool, reason: AlwaysBlocked?) -> String? {
        guard !alwaysAllowed else { return nil }
        switch reason {
        case .floor: return String(localized: "Payments, passwords and security settings always ask.")
        case .perRecipient: return String(localized: "Asks each time. You can allow one recipient on its card.")
        case nil: return nil
        }
    }

    /// A custom connector's tools as the shared rows, keeping M20's alwaysAllowed / alwaysBlocked
    /// (ConnectorCopy.tools maps the older fields only).
    static func tools(_ connector: CustomConnector) -> [ConnectorTool] {
        let byName = Dictionary(connector.tools.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        return ConnectorCopy.tools(connector).map { row in
            var row = row
            if let tool = byName[row.slug] {
                row.alwaysAllowed = tool.alwaysAllowed
                row.alwaysBlocked = tool.alwaysBlocked
            }
            return row
        }
    }
}
