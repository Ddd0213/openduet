// M28 Signed-in devices page: the rows' texts (name fallbacks, "Last active" vs "Signed in", the
// address line, the bell, the tile), the first section's title, and which sections and buttons
// show (others empty / one / many, an older server, a failed or reloading list).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M28 signed-in devices page")
struct UIM28DevicesTests {
    private static func date(_ iso: String) -> Date {
        JSONCoding.parseDate(iso) ?? Date(timeIntervalSince1970: 0)
    }

    private let clock = DevicesRules.Clock(
        locale: Locale(identifier: "en_US"),
        calendar: Calendar(identifier: .gregorian),
        timeZone: TimeZone(identifier: "UTC") ?? .gmt,
        now: UIM28DevicesTests.date("2026-11-20T18:42:10.000Z")
    )

    private func session(
        _ id: String, current: Bool = false, created: String = "2026-11-02T09:14:00.000Z", used: String? = nil,
        expires: String = "2027-01-31T09:14:00.000Z", name: String? = nil, signInIp: String? = nil,
        lastIp: String? = nil, push: Bool = false
    ) -> SessionInfo {
        SessionInfo(
            id: id, current: current, createdAt: Self.date(created), lastUsedAt: used.map(Self.date),
            expiresAt: Self.date(expires), deviceName: name, userAgent: nil, signInIp: signInIp, lastIp: lastIp, push: push
        )
    }

    // MARK: - Rows

    @Test("This iPhone: its name, when it signed in and when it signs out by itself; no address or bell")
    func currentRow() {
        let row = DevicesRules.currentRow(
            session("S1", current: true, used: "2026-11-20T18:42:00.000Z", name: "iPhone 15 Pro", signInIp: "203.0.113.24", lastIp: "198.51.100.7", push: true),
            ownName: "iPhone 16 Pro", clock: clock
        )
        #expect(row.title == "iPhone 15 Pro" && row.named)
        #expect(row.detail == "Signed in Nov 2")
        #expect(row.expiry == "Signs out by itself on Jan 31, 2027")
        #expect(row.address == nil && !row.push && row.symbol == "iphone")
    }

    @Test("This iPhone without a stored name reads this device's own model name")
    func currentRowFallback() {
        let row = DevicesRules.currentRow(session("S1", current: true), ownName: "iPhone 16 Pro", clock: clock)
        #expect(row.title == "iPhone 16 Pro" && row.named)
        let pad = DevicesRules.currentRow(session("S1", current: true), ownName: "iPad Air", clock: clock)
        #expect(pad.symbol == "ipad")
    }

    @Test("Another device: Last active, the last address, the bell")
    func otherRowActive() {
        let row = DevicesRules.otherRow(
            session("S2", used: "2026-11-20T18:37:10.000Z", name: "iPad Air", signInIp: "203.0.113.24", lastIp: "198.51.100.9", push: true),
            clock: clock
        )
        #expect(row.title == "iPad Air" && row.named)
        #expect(row.detail.hasPrefix("Last active ") && row.detail.contains("5 minutes"))
        #expect(row.expiry == nil)
        #expect(row.address == "198.51.100.9" && row.push && row.symbol == "ipad")
    }

    @Test("Last active within a minute reads just now; older follows the relative formatter")
    func lastActiveTimes() {
        let recent = DevicesRules.otherRow(session("S2", used: "2026-11-20T18:41:40.000Z", name: "iPhone"), clock: clock)
        #expect(recent.detail == "Last active just now")
        // a clock a little ahead of this phone's
        let ahead = DevicesRules.otherRow(session("S2", used: "2026-11-20T18:43:00.000Z", name: "iPhone"), clock: clock)
        #expect(ahead.detail == "Last active just now")
        let used = Self.date("2026-11-19T07:30:00.000Z")
        let older = DevicesRules.otherRow(session("S2", used: "2026-11-19T07:30:00.000Z", name: "iPhone"), clock: clock)
        #expect(older.detail == "Last active " + DevicesRules.relative(used, clock))
        #expect(older.detail != "Last active just now")
    }

    @Test("A device from before M28: Unknown device, Signed in, no address line, no bell")
    func otherRowUnknown() {
        let row = DevicesRules.otherRow(session("S3", created: "2026-10-26T14:20:00.000Z"), clock: clock)
        #expect(row.title == "Unknown device" && !row.named)
        #expect(row.detail == "Signed in Oct 26")
        #expect(row.address == nil && !row.push && row.symbol == "iphone")
    }

    @Test("The address line falls back to the sign-in's; a date in another year gets the year")
    func addressAndYear() {
        let row = DevicesRules.otherRow(session("S4", created: "2025-12-30T10:00:00.000Z", name: "iPhone 13", signInIp: "203.0.113.5"), clock: clock)
        #expect(row.address == "203.0.113.5")
        #expect(row.detail == "Signed in Dec 30, 2025")
    }

    @Test("This iPhone / This iPad")
    func currentTitle() {
        #expect(DevicesRules.currentTitle(ownName: "iPhone 16 Pro") == "This iPhone")
        #expect(DevicesRules.currentTitle(ownName: "iPhone") == "This iPhone")
        #expect(DevicesRules.currentTitle(ownName: "iPad Air") == "This iPad")
        #expect(DevicesRules.currentTitle(ownName: "iPad") == "This iPad")
    }

    // MARK: - Sections and buttons

    @Test("No other devices: the empty line, no capsule")
    func layoutAlone() {
        let layout = DevicesRules.layout(SessionList(sessions: [session("S1", current: true)]))
        #expect(layout.current?.id == "S1" && layout.others.isEmpty)
        #expect(layout.showsNoOthers && !layout.showsSignOutOthers)
    }

    @Test("One or many others: the list in the server's order and the capsule")
    func layoutOthers() {
        let one = DevicesRules.layout(SessionList(sessions: [session("S1", current: true), session("S2")]))
        #expect(one.others.map(\.id) == ["S2"] && !one.showsNoOthers && one.showsSignOutOthers)
        let many = DevicesRules.layout(SessionList(sessions: [session("S1", current: true), session("S3"), session("S2"), session("S4")]))
        #expect(many.others.map(\.id) == ["S3", "S2", "S4"] && many.showsSignOutOthers)
    }

    @Test("A list without this session shows no This iPhone row")
    func layoutWithoutCurrent() {
        let layout = DevicesRules.layout(SessionList(sessions: [session("S2"), session("S3")]))
        #expect(layout.current == nil && layout.others.count == 2)
    }

    @Test("The page: loading, failed, an older server, loaded")
    func screens() {
        let list = SessionList(sessions: [session("S1", current: true)])
        #expect(DevicesRules.screen(list: nil, failure: nil, loading: true, olderServer: false) == .loading)
        #expect(DevicesRules.screen(list: nil, failure: nil, loading: false, olderServer: false) == .loading)
        #expect(DevicesRules.screen(list: nil, failure: "Can't reach your server.", loading: false, olderServer: false) == .failed("Can't reach your server."))
        // Retry after a failure: the skeleton while it runs
        #expect(DevicesRules.screen(list: nil, failure: "x", loading: true, olderServer: false) == .loading)
        // A list stays up while it reloads or a reload fails
        #expect(DevicesRules.screen(list: list, failure: "x", loading: false, olderServer: false) == .loaded(list))
        #expect(DevicesRules.screen(list: list, failure: nil, loading: true, olderServer: false) == .loaded(list))
        // An older server: one line, no list, no capsule
        #expect(DevicesRules.screen(list: nil, failure: nil, loading: false, olderServer: true) == .olderServer)
        #expect(DevicesRules.screen(list: list, failure: nil, loading: false, olderServer: true) == .olderServer)
    }
}
