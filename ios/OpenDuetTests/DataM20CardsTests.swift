// M20 (W4): the sign-in card's phases for every answer in docs/api-samples/m20.json and for older
// payloads without the new fields; the approval card's Always row and "how" words; the line under
// a disabled Always; a custom connector's tool rows keeping alwaysAllowed; and the Make viewer's
// external link rule (source host, subdomain, other host, long query, IDN / uppercase, no sources).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum M20Fx {
    static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
        do {
            return try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
        } catch {
            fatalError("M20 fixture \(T.self) didn't decode: \(error)")
        }
    }

    /// Phrases rendered as their key (the catalog isn't in the host build).
    static func render(_ phrase: Phrase) -> String? { phrase.key ?? phrase.text }

    static func payload(_ state: SignInPayload.State, step: SignInStep = .credentials, reason: String? = nil,
                        outcome: SignInCardOutcome? = nil) -> SignInPayload {
        SignInPayload(requestId: "sir_1", domain: "shop.example.com", state: state, step: step,
                      reason: reason.map { Phrase(key: $0) }, outcome: outcome)
    }

    static func phase(_ payload: SignInPayload, _ answer: SignInCardResponse? = nil, request: CardRequest? = nil,
                      afterCode: Bool = false) -> SignInCardPhase {
        SignInCardPhase.resolve(payload: payload, answer: answer, request: request, afterCode: afterCode, render: render)
    }

    /// docs/api-samples/m20.json SignInCardResponse, in order.
    static let answers: [SignInCardResponse] = [
        #"{ "requestId": "sir_2", "state": "sent", "step": "code", "reason": null, "outcome": null, "computer": null }"#,
        #"{ "requestId": "sir_2", "state": "failed", "step": "code", "reason": { "key": "signin.code_rejected" }, "outcome": null, "computer": null }"#,
        #"{ "requestId": "sir_3", "state": "failed", "step": "credentials", "reason": { "key": "signin.moved" }, "outcome": null, "computer": null }"#,
        #"{ "requestId": "sir_4", "state": "expired", "step": "credentials", "reason": null, "outcome": "taken_over", "computer": { "available": true, "browser": "ready", "controller": "user", "url": "https://shop.example.com/login", "domain": "shop.example.com", "blocked": null } }"#,
        #"{ "requestId": "sir_5", "state": "expired", "step": "credentials", "reason": null, "outcome": "dismissed", "computer": null }"#,
    ].map { decode(SignInCardResponse.self, $0) }

    static func source(_ name: String, app: String? = nil, _ detail: String) -> ArtifactSource {
        ArtifactSource(name: name, app: app, detail: detail)
    }

    static func connector(_ tools: [CustomConnectorTool]) -> CustomConnector {
        CustomConnector(
            id: "cc1", kind: .mcp, name: "Wiki", description: "", url: "https://mcp.example.com/mcp", domain: nil,
            headerName: nil, valuePrefix: nil, secret: nil, headers: [], status: .active, error: nil, tools: tools,
            scope: .all, channelIds: [], createdAt: Date(timeIntervalSince1970: 1_760_000_000)
        )
    }
}

@Suite("M20 sign-in card phases")
struct DataM20SignInTests {
    @Test("every m20.json answer on a pending card")
    func sampleAnswers() {
        let pending = M20Fx.payload(.pending)
        let a = M20Fx.answers
        // Submit answered "sent" + code: the site wants a code, the same card goes on.
        #expect(M20Fx.phase(pending, a[0]) == .code(reason: nil))
        // The same answer to a sent code: signed in.
        #expect(M20Fx.phase(pending, a[0], afterCode: true) == .sent)
        #expect(M20Fx.phase(pending, a[1]) == .failed(reason: "signin.code_rejected", takeControl: false))
        #expect(M20Fx.phase(pending, a[2]) == .failed(reason: "signin.moved", takeControl: true))
        #expect(a[3].computer?.controller == .user)
        #expect(M20Fx.phase(pending, a[3]) == .takenOver)
        #expect(M20Fx.phase(pending, a[4]) == .dismissed)
    }

    @Test("Retry after a refused code shows the code field again")
    func retryStep() {
        let pending = M20Fx.payload(.pending)
        #expect(SignInCardPhase.retryStep(payload: pending, answer: M20Fx.answers[1]) == .code)
        #expect(SignInCardPhase.retryStep(payload: pending, answer: M20Fx.answers[2]) == .credentials)
        #expect(SignInCardPhase.retryStep(payload: M20Fx.payload(.pending, step: .code), answer: nil) == .code)
        #expect(SignInCardPhase.retryStep(payload: pending, answer: nil) == .credentials)
    }

    @Test("the payload alone: code step (with the refused code's reason), failures, closed cards")
    func payloads() {
        #expect(M20Fx.phase(M20Fx.payload(.pending, step: .code)) == .code(reason: nil))
        #expect(M20Fx.phase(M20Fx.payload(.pending, step: .code, reason: "signin.code_rejected")) == .code(reason: "signin.code_rejected"))
        #expect(M20Fx.phase(M20Fx.payload(.failed, reason: "signin.wrong_page")) == .failed(reason: "signin.wrong_page", takeControl: true))
        #expect(M20Fx.phase(M20Fx.payload(.failed, reason: "signin.rejected")) == .failed(reason: "signin.rejected", takeControl: false))
        #expect(M20Fx.phase(M20Fx.payload(.failed, step: .code, reason: "signin.code_rejected")) == .failed(reason: "signin.code_rejected", takeControl: false))
        #expect(M20Fx.phase(M20Fx.payload(.expired, outcome: .takenOver)) == .takenOver)
        #expect(M20Fx.phase(M20Fx.payload(.expired, outcome: .dismissed)) == .dismissed)
        #expect(M20Fx.phase(M20Fx.payload(.expired)) == .expired)
        #expect(M20Fx.phase(M20Fx.payload(.sent, step: .code)) == .sent)
        #expect(SignInCardPhase.takenOver.isClosed && SignInCardPhase.dismissed.isClosed && SignInCardPhase.expired.isClosed)
        #expect(!SignInCardPhase.code(reason: nil).isClosed)
    }

    @Test("the m20.json sign-in messages decode and resolve")
    func sampleMessages() {
        let code = M20Fx.decode(SignInPayload.self, #"{ "requestId": "sir_2", "domain": "shop.example.com", "state": "pending", "step": "code", "reason": null, "outcome": null }"#)
        let taken = M20Fx.decode(SignInPayload.self, #"{ "requestId": "sir_4", "domain": "shop.example.com", "state": "expired", "step": "credentials", "reason": null, "outcome": "taken_over" }"#)
        #expect(M20Fx.phase(code) == .code(reason: nil))
        #expect(M20Fx.phase(taken) == .takenOver)
    }

    @Test("older payloads and answers without the new fields read as before")
    func olderShapes() {
        let old = M20Fx.decode(SignInPayload.self, #"{ "requestId": "sir_1", "domain": "a.com", "state": "failed" }"#)
        #expect(old.step == .credentials && old.reason == nil && old.outcome == nil)
        #expect(M20Fx.phase(old) == .failed(reason: nil))
        let oldAnswer = M20Fx.decode(SignInCardResponse.self, #"{ "requestId": "sir_1", "state": "sent" }"#)
        #expect(oldAnswer.step == .credentials && oldAnswer.outcome == nil && oldAnswer.computer == nil)
        #expect(M20Fx.phase(M20Fx.payload(.pending), oldAnswer) == .sent)
        let expired = M20Fx.decode(SignInPayload.self, #"{ "requestId": "sir_1", "domain": "a.com", "state": "expired" }"#)
        #expect(M20Fx.phase(expired) == .expired)
        // An unknown outcome from a newer server reads as none (plain Expired).
        let newer = M20Fx.decode(SignInPayload.self, #"{ "requestId": "sir_1", "domain": "a.com", "state": "expired", "outcome": "later" }"#)
        #expect(M20Fx.phase(newer) == .expired)
        // The pre-M20 call still resolves the same way.
        #expect(SignInCardPhase.resolve(payload: .pending, answer: .failed, request: nil) == .failed(reason: nil))
        #expect(SignInCardPhase.resolve(payload: .expired, answer: .sent, request: nil) == .expired)
    }

    @Test("a tap in flight wins; a local failure beats a stale answer; an expired 404 beats the old answer")
    func ordering() {
        let pending = M20Fx.payload(.pending)
        #expect(M20Fx.phase(pending, M20Fx.answers[0], request: .inFlight) == .sending)
        #expect(M20Fx.phase(pending, M20Fx.answers[0], request: .failed(reason: "Offline")) == .failed(reason: "Offline"))
        #expect(M20Fx.phase(M20Fx.payload(.sent), nil, request: .failed(reason: "Offline")) == .sent)
        // signIns says expired (404 / 410) while signInAnswers still holds the code answer.
        let merged = SignInCardPhase.answer(state: .expired, full: M20Fx.answers[0])
        #expect(merged?.state == .expired && merged?.step == .credentials)
        #expect(M20Fx.phase(pending, merged) == .expired)
        #expect(SignInCardPhase.answer(state: .sent, full: M20Fx.answers[0]) == M20Fx.answers[0])
        #expect(SignInCardPhase.answer(state: nil, full: M20Fx.answers[0]) == nil)
    }
}

@Suite("M20 approval Always rows and the safety floor")
struct DataM20ApprovalTests {
    @Test("the Always row says exactly what it covers; none for purchases, accounts or unknown scopes")
    func rowText() {
        #expect(ApprovalAlwaysRules.rowText(ApprovalAlways(scope: .recipient, value: "sam@example.com", category: nil)) == "Always allow sending to sam@example.com")
        #expect(ApprovalAlwaysRules.rowText(ApprovalAlways(scope: .site, value: "forum.example.org", category: .send)) == "Always allow sending on forum.example.org")
        #expect(ApprovalAlwaysRules.rowText(ApprovalAlways(scope: .site, value: "a.com", category: .delete)) == "Always allow deleting on a.com")
        #expect(ApprovalAlwaysRules.rowText(ApprovalAlways(scope: .site, value: "a.com", category: .submit)) == "Always allow submitting forms on a.com")
        #expect(ApprovalAlwaysRules.rowText(ApprovalAlways(scope: .site, value: "shop.com", category: .purchase)) == nil)
        #expect(ApprovalAlwaysRules.rowText(ApprovalAlways(scope: .site, value: "shop.com", category: .account)) == nil)
        #expect(ApprovalAlwaysRules.rowText(ApprovalAlways(scope: .site, value: "a.com", category: nil)) == nil)
        #expect(ApprovalAlwaysRules.rowText(ApprovalAlways(scope: .unknown, value: "a.com", category: nil)) == nil)
        #expect(ApprovalAlwaysRules.rowText(ApprovalAlways(scope: .recipient, value: "", category: nil)) == nil)
        #expect(ApprovalAlwaysRules.rowText(nil) == nil)
    }

    @Test("the m20.json approval cards: why and Always as sent")
    func sampleCards() {
        let site = M20Fx.decode(Approval.self, #"{ "id": "apr_9", "kind": "action", "status": "pending", "version": 1, "expiresAt": null, "taskId": "task_1", "messageId": "m", "preview": { "kind": "action", "app": "Claude's computer", "toolName": "Click in the browser", "rows": [], "browser": { "site": "forum.example.org", "button": "发布", "category": "send", "via": "click" } }, "result": null, "changedFields": [], "why": { "key": "approval.why_send" }, "always": { "scope": "site", "value": "forum.example.org", "category": "send" }, "updatedAt": "2026-11-10T09:00:00.000Z" }"#)
        let purchase = M20Fx.decode(Approval.self, #"{ "id": "apr_10", "kind": "action", "status": "pending", "version": 1, "expiresAt": null, "taskId": null, "messageId": "m", "preview": { "kind": "action", "app": "Claude's computer", "toolName": "Click in the browser", "rows": [], "browser": { "site": "shop.example.com", "button": "Place your order", "category": "purchase", "via": "click" } }, "result": null, "changedFields": [], "why": { "key": "approval.why_purchase" }, "always": null, "updatedAt": "2026-11-10T09:02:00.000Z" }"#)
        #expect(ApprovalAlwaysRules.rowText(site.always) == "Always allow sending on forum.example.org")
        #expect(site.why?.key == "approval.why_send")
        #expect(ApprovalAlwaysRules.rowText(purchase.always) == nil)
        guard case .action(let preview) = purchase.preview else { Issue.record("not an action card"); return }
        #expect(preview.browser?.button == "Place your order")
        #expect(preview.browser.map { ApprovalAlwaysRules.how($0.via) } == "Click")
    }

    @Test("how the click happens")
    func how() {
        #expect(ApprovalAlwaysRules.how(.click) == "Click")
        #expect(ApprovalAlwaysRules.how(.submit) == "Submit")
        #expect(ApprovalAlwaysRules.how(.enter) == "Enter")
    }

    @Test("the line under a disabled Always")
    func blockedLine() {
        #expect(ApprovalAlwaysRules.blockedLine(alwaysAllowed: false, reason: .floor) == "Payments, passwords and security settings always ask.")
        #expect(ApprovalAlwaysRules.blockedLine(alwaysAllowed: false, reason: .perRecipient) == "Asks each time. You can allow one recipient on its card.")
        #expect(ApprovalAlwaysRules.blockedLine(alwaysAllowed: false, reason: nil) == nil)
        #expect(ApprovalAlwaysRules.blockedLine(alwaysAllowed: true, reason: nil) == nil)
        #expect(ApprovalAlwaysRules.blockedLine(alwaysAllowed: true, reason: .floor) == nil)
    }

    @Test("a custom connector's tool rows keep alwaysAllowed / alwaysBlocked")
    func customTools() {
        let tools = [
            CustomConnectorTool(name: "search", description: "", access: .read, mode: .always),
            CustomConnectorTool(name: "pay", description: "", access: .write, mode: .ask, alwaysAllowed: false, alwaysBlocked: .floor),
            CustomConnectorTool(name: "post", description: "", access: .write, mode: .ask, alwaysAllowed: false, alwaysBlocked: .perRecipient),
        ]
        let rows = ApprovalAlwaysRules.tools(M20Fx.connector(tools))
        #expect(rows.map(\.slug) == ["search", "pay", "post"])
        #expect(rows.map(\.alwaysAllowed) == [true, false, false])
        #expect(rows.map(\.alwaysBlocked) == [nil, .floor, .perRecipient])
        let decoded = M20Fx.decode(CustomConnectorTool.self, #"{ "name": "pay", "description": "", "access": "write", "mode": "ask", "alwaysAllowed": false, "alwaysBlocked": "floor" }"#)
        #expect(!decoded.alwaysAllowed && decoded.alwaysBlocked == .floor)
    }
}

@Suite("M20 Make links ask before leaving")
struct DataM20LinkTests {
    private let sources = [
        M20Fx.source("Signups sheet", app: "Google Sheets", "docs.google.com/spreadsheets/d/1, tab Daily"),
        M20Fx.source("Prices", "From https://Shop.Example.co.uk/prices and bücher.de"),
        M20Fx.source("report.pdf", "Forwarded by sam@other.com"),
    ]

    private func asks(_ link: String, _ sources: [ArtifactSource]?) -> Bool {
        ExternalLinkRules.needsConfirmation(URL(string: link)!, sources: sources)
    }

    @Test("a short link to a source's site (or its subdomain) opens at once; another site asks")
    func sourceHosts() {
        #expect(!asks("https://docs.google.com/spreadsheets/d/1", sources))
        #expect(!asks("https://drive.google.com/file/2", sources))
        #expect(!asks("https://shop.example.co.uk/a", sources))
        #expect(!asks("https://www.example.co.uk/", sources))
        #expect(asks("https://other.co.uk/", sources))
        #expect(asks("https://evil.example/collect", sources))
        // An address in a source's text or a file name isn't a site the page may send to.
        #expect(asks("https://other.com/", sources))
        #expect(asks("https://report.pdf/", sources))
    }

    @Test("a long query or fragment asks even for a source's site")
    func longTail() {
        let base = "https://docs.google.com/x?d="
        #expect(!asks(base + String(repeating: "a", count: 198), sources))
        #expect(asks(base + String(repeating: "a", count: 199), sources))
        #expect(asks(base + String(repeating: "a", count: 190) + "#" + String(repeating: "b", count: 20), sources))
        // Counted as sent: one Chinese character is 9 percent-encoded characters.
        #expect(asks(base + String(repeating: "%E5%AD%97", count: 23), sources))
        #expect(ExternalLinkRules.tailLength(URL(string: "https://a.com/p?ab#cd")!) == 4)
    }

    @Test("IDN and uppercase hosts match their sources")
    func idnAndCase() {
        #expect(!asks("https://BÜCHER.de/x", sources))
        #expect(!asks("https://xn--bcher-kva.de/", sources))
        #expect(!asks("https://DOCS.GOOGLE.COM./x", sources))
        #expect(ExternalLinkRules.host(of: URL(string: "https://BÜCHER.de/x")!) == "xn--bcher-kva.de")
        #expect(ExternalLinkRules.normalized("Mail.Google.COM.") == "mail.google.com")
        // A look-alike Unicode site (Cyrillic "о") doesn't pass for the ASCII one; written either
        // way, a Unicode source matches its own punycode.
        let lookAlike = "https://g\u{043E}\u{043E}gle.com/x"
        #expect(asks(lookAlike, [M20Fx.source("x", "google.com")]))
        #expect(ExternalLinkRules.host(of: URL(string: lookAlike)!)?.hasPrefix("xn--") == true)
        #expect(!asks(lookAlike, [M20Fx.source("x", "g\u{043E}\u{043E}gle.com")]))
    }

    @Test("without sources (not loaded yet, or none) every web link asks")
    func noSources() {
        #expect(asks("https://docs.google.com/x", nil))
        #expect(asks("https://docs.google.com/x", []))
        #expect(asks("https://example.com/", [M20Fx.source("Stripe payments", app: "Stripe", "Last 30 days")]))
    }

    @Test("registrable domains: country second levels and shared hosting")
    func registrable() {
        #expect(ExternalLinkRules.registrableDomain("mail.google.com") == "google.com")
        #expect(ExternalLinkRules.registrableDomain("news.bbc.co.uk") == "bbc.co.uk")
        #expect(ExternalLinkRules.registrableDomain("shop.example.com.cn") == "example.com.cn")
        #expect(ExternalLinkRules.registrableDomain("alex.github.io") == "alex.github.io")
        #expect(ExternalLinkRules.registrableDomain("192.168.1.1") == "192.168.1.1")
        #expect(asks("https://mallory.github.io/", [M20Fx.source("x", "alex.github.io/notes")]))
    }

    @Test("the dialog's URL keeps its start and end")
    func shortened() {
        let long = URL(string: "https://evil.example.com/collect?data=" + String(repeating: "x", count: 300) + "&end=1")!
        let text = ExternalLinkRules.shortened(long)
        #expect(text.count == 80)
        #expect(text.hasPrefix("https://evil.example.com/collect?data="))
        #expect(text.hasSuffix("&end=1"))
        #expect(text.contains("…"))
        #expect(ExternalLinkRules.shortened(URL(string: "https://a.com/x")!) == "https://a.com/x")
    }
}
