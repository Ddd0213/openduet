// M22 W4 UI logic: Setup rows (the status word with an unknown status, what each fix does with
// unknown kinds and routes, the phone's Notifications row, Check again's 429 line), the soul_setup
// card's phases (superseded included) and its "now → new" defaults, the appearance choice and the
// language row's subtitle.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M22 Setup rows")
struct UIM22SetupRowTests {
    private func item(status: String = "needs_setup", fix: String = "null") throws -> SetupItem {
        let json = #"{"id":"apps","status":"\#(status)","required":false,"title":{"key":"setup.apps.title"},"detail":{"text":"No apps yet."},"fix":\#(fix),"checkedAt":null}"#
        return try JSONCoding.decoder().decode(SetupItem.self, from: Data(json.utf8))
    }

    @Test("Status words: ready, not checked, needs setup; a newer status reads Not checked")
    func status() throws {
        #expect(SetupRowStatus(try item(status: "ready").status) == .ready)
        #expect(SetupRowStatus(try item(status: "not_checked").status) == .notChecked)
        #expect(SetupRowStatus(try item(status: "needs_setup").status) == .needsSetup)
        let newer = try item(status: "degraded")
        #expect(newer.status == nil)
        #expect(SetupRowStatus(newer.status) == .notChecked)
        #expect(SetupRowStatus.ready.label.key == "Ready")
        #expect(SetupRowStatus.notChecked.label.key == "Not checked")
        #expect(SetupRowStatus.needsSetup.label.key == "Needs setup")
    }

    @Test("A route fix opens its settings page; duet://computer is a link; anything else has no button")
    func routes() throws {
        func fix(_ route: String) throws -> SetupFixAction? {
            try SetupFixAction(item(fix: #"{"kind":"route","route":"\#(route)"}"#))
        }
        #expect(try fix("duet://settings/models") == .page(.models))
        #expect(try fix("duet://settings/apps") == .page(.apps))
        #expect(try fix("duet://settings/voice") == .page(.voice))
        #expect(try fix("duet://computer") == .link(URL(string: "duet://computer")!))
        #expect(try fix("duet://settings/billing") == nil, "a page this build doesn't have")
        #expect(try fix("https://example.com/setup") == nil, "not an in-app link")
        #expect(try fix("not a link") == nil)
        #expect(SetupFixAction.page(.models).buttonTitle?.key == "Open Models")
        #expect(SetupFixAction.page(.apps).buttonTitle?.key == "Open Apps")
        #expect(SetupFixAction.page(.voice).buttonTitle?.key == "Open Voice")
        #expect(SetupFixAction.link(URL(string: "duet://computer")!).buttonTitle?.key == "Open")
    }

    @Test("An env fix shows its names (trimmed, blanks dropped) and hint; none left means no fix")
    func env() throws {
        let fix = try SetupFixAction(item(fix: #"{"kind":"env","names":[" SEARCH_PROVIDER ","","TAVILY_API_KEY"],"hint":{"text":"Set these in backend/.env."}}"#))
        guard case .env(let names, let hint)? = fix else {
            Issue.record("expected an env fix, got \(String(describing: fix))")
            return
        }
        #expect(names == ["SEARCH_PROVIDER", "TAVILY_API_KEY"])
        #expect(hint.text == "Set these in backend/.env.")
        #expect(fix?.buttonTitle == nil, "the names are the fix; nothing to tap")
        #expect(try SetupFixAction(item(fix: #"{"kind":"env","names":["  "],"hint":{"text":"x"}}"#)) == nil)
    }

    @Test("No fix while ready, without one, or of a kind this build doesn't know")
    func noFix() throws {
        #expect(try SetupFixAction(item(status: "ready", fix: #"{"kind":"route","route":"duet://settings/models"}"#)) == nil)
        #expect(try SetupFixAction(item(fix: "null")) == nil)
        let newer = try item(fix: #"{"kind":"script","command":"setup.sh"}"#)
        #expect(newer.fix == .unsupported)
        #expect(SetupFixAction(newer) == nil)
        // Not checked still offers its fix (set up but not tried since it changed).
        #expect(try SetupFixAction(item(status: "not_checked", fix: #"{"kind":"route","route":"duet://settings/apps"}"#)) == .page(.apps))
        #expect(try SetupFixAction(item(status: "degraded", fix: #"{"kind":"route","route":"duet://settings/apps"}"#)) == .page(.apps))
    }

    @Test("The phone's Notifications row: Ready when on; Turn on asks first, then opens iOS Settings")
    func notifications() {
        #expect(SetupNotificationsRow.status(.on) == .ready)
        #expect(SetupNotificationsRow.status(.off) == .needsSetup)
        #expect(SetupNotificationsRow.status(.undecided) == .needsSetup)
        #expect(SetupNotificationsRow.status(nil) == .notChecked, "still reading the permission")
        #expect(SetupNotificationsRow.action(.on) == nil)
        #expect(SetupNotificationsRow.action(nil) == nil)
        #expect(SetupNotificationsRow.action(.undecided) == .ask)
        #expect(SetupNotificationsRow.action(.off) == .openSettings)
    }

    @Test("Check again: 429 says to wait a moment; other failures their usual line; a cancel nothing")
    func checkFailure() {
        #expect(SetupCheckFailure.line(for: APIError.rateLimited) == String(localized: "Try again in a moment"))
        #expect(SetupCheckFailure.line(for: APIError.unreachable) == APIError.unreachable.localizedReason)
        #expect(SetupCheckFailure.line(for: CancellationError()) == nil)
        #expect(SetupCheckFailure.line(for: APIError(status: 429, body: Data())) == String(localized: "Try again in a moment"))
    }
}

@Suite("M22 soul_setup card")
struct UIM22SoulSetupTests {
    @Test("Phases: open, busy, failed, applied, dismissed; superseded wins over a tap in flight")
    func phases() {
        #expect(SoulSetupPhase(.open, request: nil) == .open)
        #expect(SoulSetupPhase(.open, request: .inFlight) == .busy)
        #expect(SoulSetupPhase(.open, request: .failed(reason: "r")) == .failed(reason: "r"))
        #expect(SoulSetupPhase(.applied, request: .inFlight) == .applied)
        #expect(SoulSetupPhase(.dismissed, request: .failed(reason: "r")) == .dismissed)
        for request in [nil, CardRequest.inFlight, .failed(reason: "r")] {
            #expect(SoulSetupPhase(.superseded, request: request) == .superseded)
        }
        #expect(SoulSetupPhase.applied.isDecided && SoulSetupPhase.dismissed.isDecided)
        #expect(!SoulSetupPhase.superseded.isDecided, "superseded folds to its own grey line")
        #expect(SoulSetupPhase.open.canAct && SoulSetupPhase.failed(reason: "r").canAct)
        for phase in [SoulSetupPhase.busy, .applied, .dismissed, .superseded] {
            #expect(!phase.canAct)
        }
    }

    @Test("An empty side reads as the field's default: OpenDuet, your first name, Default")
    func defaults() {
        #expect(SoulSetupValue("", field: .name) == .assistant)
        #expect(SoulSetupValue("  \n", field: .addressAs) == .firstName)
        #expect(SoulSetupValue("", field: .identity) == .standard)
        #expect(SoulSetupValue("", field: .persona) == .standard)
        #expect(SoulSetupValue("", field: .tone) == .standard)
        #expect(SoulSetupValue("  Warm and brief ", field: .tone) == .text("Warm and brief"))
        #expect(SoulSetupValue("Duet", field: .name) == .text("Duet"))
    }

    @Test("Rows keep the payload's order, once each, without soulExtra; the payload decodes")
    func rows() throws {
        let json = #"{"fields":[{"field":"addressAs","current":"","proposed":"Chris"},{"field":"name","current":"","proposed":"Duet"},{"field":"addressAs","current":"","proposed":"C"},{"field":"tone","current":"plain","proposed":"warm"}],"reason":"From our chat.","state":"superseded"}"#
        let payload = try JSONCoding.decoder().decode(SoulSetupPayload.self, from: Data(json.utf8))
        #expect(payload.state == .superseded)
        #expect(payload.rows.map(\.field) == [.addressAs, .name, .tone])
        #expect(payload.rows.first?.proposed == "Chris", "the first of a repeated field")
        var withExtra = payload
        withExtra.fields.append(.init(field: .soulExtra, current: "", proposed: "x"))
        #expect(!withExtra.rows.contains { $0.field == .soulExtra })
    }
}

@Suite("M22 Appearance and Language")
struct UIM22AppearanceTests {
    @Test("Appearance: System by default and for anything unknown; each choice round-trips")
    func appearance() {
        #expect(AppearanceChoice(stored: nil) == .system)
        #expect(AppearanceChoice(stored: "") == .system)
        #expect(AppearanceChoice(stored: "sepia") == .system)
        #expect(AppearanceChoice(stored: "Dark") == .system, "stored values are exact")
        for choice in AppearanceChoice.allCases {
            #expect(AppearanceChoice(stored: choice.rawValue) == choice)
        }
        #expect(AppearanceChoice.allCases == [.system, .light, .dark])
        #expect(!AppearanceChoice.system.overridesSystem)
        #expect(AppearanceChoice.light.overridesSystem && AppearanceChoice.dark.overridesSystem)
        #expect(AppearanceChoice.storageKey == "settings.appearance")
        #expect(AppearanceChoice.system.label.key == "System")
    }

    @Test("Language: the app's first localization, named in its own language")
    func language() {
        #expect(AppLanguageRow.current(["zh-Hans"]) == .zhHans)
        #expect(AppLanguageRow.current(["zh-Hans-CN", "en"]) == .zhHans)
        #expect(AppLanguageRow.current(["en"]) == .en)
        #expect(AppLanguageRow.current(["en-GB", "zh-Hans"]) == .en, "the first one decides")
        #expect(AppLanguageRow.current([]) == .en)
        #expect(AppLanguageRow.name(.zhHans) == "简体中文")
        #expect(AppLanguageRow.name(.en) == "English")
        #expect(AppLanguageRow.current(["ZH-hans"]) == .zhHans, "case doesn't matter")
    }
}
