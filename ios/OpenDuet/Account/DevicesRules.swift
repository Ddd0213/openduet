// M28 Signed-in devices page (docs/API.md "M28 sessions") without SwiftUI, so the Mac host tests
// cover it: each row's texts (the name and its fallbacks, "Last active" or "Signed in", the address
// line, the bell), which sections and buttons show, what a failed load / sign-out means (404 on the
// list = a server before M28; 404 on a sign-out = already gone), the "Signed out N devices" line,
// and the rule for a closed live-computer socket (4001 or a 401 upgrade: no retry, one check).
import Foundation

enum DevicesRules {
    /// What the dates are formatted against: the app's locale, the iPhone's calendar and time zone,
    /// and now. Injectable so tests get fixed output.
    struct Clock: Sendable {
        var locale: Locale = AppLocale.current
        var calendar: Calendar = .autoupdatingCurrent
        var timeZone: TimeZone = .autoupdatingCurrent
        var now = Date()
    }

    /// One device row's texts.
    struct Row: Hashable, Sendable, Identifiable {
        var id: String
        /// the model name ("iPhone 15 Pro"), or "Unknown device"
        var title: String
        /// false when the title is the "Unknown device" fallback
        var named: Bool
        /// "Signed in Nov 2" (this device), "Last active 5 minutes ago" or "Signed in Nov 2" (others)
        var detail: String
        /// "Signs out by itself on Jan 31, 2027" (this device only)
        var expiry: String?
        /// the quiet third line: the last request's address, else the sign-in's
        var address: String?
        /// an APNs token registered from that session gets pushes (the bell)
        var push: Bool
        /// the row's tile: "ipad" for an iPad, else "iphone"
        var symbol: String
    }

    // MARK: - Rows

    /// The "This iPhone" row: its stored name, else this device's own model name; when it signed in
    /// and when it signs out by itself. No address, no bell, no button.
    static func currentRow(_ session: SessionInfo, ownName: String = DeviceModelName.current, clock: Clock = Clock()) -> Row {
        let title = session.deviceName ?? ownName
        return Row(
            id: session.id,
            title: title,
            named: true,
            detail: String(localized: "Signed in \(day(session.createdAt, clock))"),
            expiry: String(localized: "Signs out by itself on \(day(session.expiresAt, clock))"),
            address: nil,
            push: false,
            symbol: symbol(for: title)
        )
    }

    /// Another device's row: its name or "Unknown device", "Last active <relative>" (nil lastUsedAt:
    /// "Signed in <date>"), the address and the bell.
    static func otherRow(_ session: SessionInfo, clock: Clock = Clock()) -> Row {
        let detail: String
        if let used = session.lastUsedAt {
            detail = String(localized: "Last active \(relative(used, clock))")
        } else {
            detail = String(localized: "Signed in \(day(session.createdAt, clock))")
        }
        return Row(
            id: session.id,
            title: session.deviceName ?? String(localized: "Unknown device"),
            named: session.deviceName != nil,
            detail: detail,
            expiry: nil,
            address: session.lastIp ?? session.signInIp,
            push: session.push,
            symbol: symbol(for: session.deviceName)
        )
    }

    /// The first section's title: "This iPhone", or "This iPad" when this device is an iPad.
    static func currentTitle(ownName: String = DeviceModelName.current) -> String {
        DeviceModelName.isIPad(ownName) ? String(localized: "This iPad") : String(localized: "This iPhone")
    }

    /// "ipad" for an iPad's name, else "iphone" (an unnamed row included: the app runs on phones).
    static func symbol(for name: String?) -> String {
        DeviceModelName.isIPad(name) ? "ipad" : "iphone"
    }

    /// "Nov 2" this year, "Nov 2, 2026" another year (the app's locale: "11月2日").
    static func day(_ date: Date, _ clock: Clock) -> String {
        var calendar = clock.calendar
        calendar.timeZone = clock.timeZone
        let style = Date.FormatStyle(locale: clock.locale, calendar: calendar, timeZone: clock.timeZone)
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: clock.now)
        return date.formatted(sameYear ? style.month(.abbreviated).day() : style.year().month(.abbreviated).day())
    }

    /// "just now" within the last minute (or a clock a little ahead), else "5 minutes ago",
    /// "yesterday", "last week" (relative to `now`, the page's minute tick).
    static func relative(_ date: Date, _ clock: Clock) -> String {
        guard clock.now.timeIntervalSince(date) >= 60 else { return String(localized: "just now") }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = clock.locale
        var calendar = clock.calendar
        calendar.timeZone = clock.timeZone
        formatter.calendar = calendar
        formatter.dateTimeStyle = .named
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: clock.now)
    }
}

// MARK: - Sections and buttons

extension DevicesRules {
    /// What the loaded page shows.
    struct Layout: Hashable, Sendable {
        /// the "This iPhone" row (nil when the server didn't list this session)
        var current: SessionInfo?
        /// "Other devices", in the server's order
        var others: [SessionInfo]
        /// "No other devices are signed in." instead of the list
        var showsNoOthers: Bool { others.isEmpty }
        /// the "Sign out other devices" capsule, only while there are others
        var showsSignOutOthers: Bool { !others.isEmpty }
    }

    static func layout(_ list: SessionList) -> Layout {
        Layout(current: list.current, others: list.others)
    }

    /// The whole page.
    enum Screen: Hashable, Sendable {
        /// the first load (skeleton)
        case loading
        /// nothing to show and the load failed: the reason with Retry
        case failed(String)
        /// GET /api/sessions was 404: one line, no list, no capsule
        case olderServer
        case loaded(SessionList)
    }

    /// An older server wins (its 404 is the answer); a list stays up while it reloads or a reload
    /// fails; a failure replaces the page only when there is nothing to show.
    static func screen(list: SessionList?, failure: String?, loading: Bool, olderServer: Bool) -> Screen {
        if olderServer { return .olderServer }
        if let list { return .loaded(list) }
        if let failure, !loading { return .failed(failure) }
        return .loading
    }
}

// MARK: - Errors

extension DevicesRules {
    /// What a failed GET /api/sessions means.
    enum LoadFailure: Hashable, Sendable {
        /// cancelled (the page went away): nothing changes
        case ignore
        /// 404 not_found: a server from before M28
        case olderServer
        /// anything else: the reason with Retry (a 401 also signs the app out, as everywhere)
        case reason(String)
    }

    static func loadFailure(_ error: any Error) -> LoadFailure {
        if error is CancellationError { return .ignore }
        if case .notFound? = error as? APIError { return .olderServer }
        return .reason(SettingsReason.line(for: error) ?? String(localized: "Something went wrong."))
    }

    /// What a DELETE /api/sessions/:id answer means for its row.
    enum DeleteOutcome: Hashable, Sendable {
        /// 204, or 404 (already signed out, expired or unknown): the row leaves
        case gone
        /// 400 validation_failed field id (the current session, which has no button): load the list again
        case reload
        /// cancelled: nothing changes
        case ignore
        /// anything else: the reason in the row, which stays
        case failed(String)
    }

    /// `error` nil = 204.
    static func deleteOutcome(_ error: (any Error)?) -> DeleteOutcome {
        guard let error else { return .gone }
        if error is CancellationError { return .ignore }
        switch error as? APIError {
        case .notFound?: return .gone
        case .validationFailed(let field, _)? where field == "id": return .reload
        default: return .failed(SettingsReason.line(for: error) ?? String(localized: "Something went wrong."))
        }
    }

    /// A failed "Sign out other devices": the reason shown in place (nil: cancelled).
    static func revokeFailure(_ error: any Error) -> String? {
        SettingsReason.line(for: error)
    }

    /// The line after "Sign out other devices": "Signed out 1 device" / "Signed out 3 devices";
    /// nil for 0 (nothing to say).
    static func revokedLine(_ revoked: Int) -> String? {
        switch revoked {
        case ..<1: nil
        case 1: String(localized: "Signed out 1 device")
        default: String(localized: "Signed out \(revoked) devices")
        }
    }
}

// MARK: - The live computer's socket

/// How ComputerStream treats a closed socket (docs/API.md "M28 sessions", open streams): the server
/// closes a signed-out session's socket with 4001, and an app before M28 gets a 401 on the upgrade.
/// Either way the stream doesn't reconnect but makes one authorized request, whose 401 signs the
/// app out; any other close (1011, the network, a timeout) keeps the backoff.
enum ComputerStreamEnd: Hashable, Sendable {
    /// reconnect after the backoff
    case retry
    /// signal `.closed` once, then one authorized request instead of a reconnect
    case checkSession

    /// SESSION_ENDED_CLOSE_CODE
    static let sessionEndedCode = 4001

    /// `closeCode`: the socket's close code (raw); `upgradeStatus`: the upgrade answer's HTTP status.
    static func after(closeCode: Int, upgradeStatus: Int?) -> ComputerStreamEnd {
        (closeCode == sessionEndedCode || upgradeStatus == 401) ? .checkSession : .retry
    }

    /// After the check: a 401 (the app is signing out) ends the stream for good; anything else (the
    /// session is still good, or the server can't be reached) goes back to the backoff, so a live
    /// view never stays stuck.
    static func reconnects(afterCheckRefused refused: Bool) -> Bool {
        !refused
    }
}
