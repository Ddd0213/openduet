// Make copy and chat extras logic (Make/MakeCopy.swift, Stores/MakeGallery.swift, prompt L147-L158,
// L181): relative times, the Build timer, "Refreshes daily at …" in 12/24-hour style, metric
// values, the docs outline, the "/" skills trigger and filter, reaction toggles, and the spend
// request / skill proposal states (expiry, tap in flight or failed).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Make copy and chat extras")
struct UIMakeCopyTests {
    private static let zone = TimeZone(identifier: "America/Los_Angeles")!
    /// Tuesday 2026-11-03 15:00 in Los Angeles.
    private static let now: Date = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 15))!
    }()

    private func copy(_ identifier: String = "en_US") -> MakeCopy {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = Self.zone
        return MakeCopy(format: ChatDateFormat(locale: Locale(identifier: identifier), calendar: calendar, timeZone: Self.zone, now: Self.now))
    }

    private func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    // MARK: Times

    @Test func relativeTimes() {
        let c = copy()
        #expect(c.ago(Self.now.addingTimeInterval(-20), now: Self.now) == "this minute")
        #expect(c.ago(Self.now.addingTimeInterval(-12 * 60), now: Self.now) == "12 min ago")
        #expect(c.ago(Self.now.addingTimeInterval(-2 * 3600), now: Self.now) == "2 hr ago")
        #expect(c.ago(Self.now.addingTimeInterval(-20 * 3600), now: Self.now) == "Yesterday")
        #expect(c.ago(Self.now.addingTimeInterval(-3 * 24 * 3600), now: Self.now) == "Saturday")
        #expect(c.ago(Self.now.addingTimeInterval(-30 * 24 * 3600), now: Self.now) == "Oct 4")
        #expect(c.updated(Self.now.addingTimeInterval(-10), now: Self.now) == "Updated now")
        #expect(c.updated(Self.now.addingTimeInterval(-2 * 3600), now: Self.now) == "Updated 2 hr ago")
    }

    @Test func buildTimer() {
        #expect(MakeCopy.elapsed(1) == "0:01")
        #expect(MakeCopy.elapsed(65) == "1:05")
        #expect(MakeCopy.elapsed(3723) == "1:02:03")
        #expect(MakeCopy.elapsed(-4) == "0:00")
    }

    @Test func refreshSchedules() {
        let daily = Schedule(cadence: .daily, hour: 5, minute: 30, weekday: nil, at: nil)
        #expect(copy().refreshes(daily).map(plain) == "Refreshes daily at 5:30 AM")
        #expect(copy("en_GB").refreshes(daily)?.contains("05:30") == true)
        #expect(copy().refreshes(Schedule(cadence: .hourly, hour: 0, minute: 0, weekday: nil, at: nil)) == "Refreshes every hour")
        #expect(copy().refreshes(Schedule(cadence: .weekdays, hour: 7, minute: 0, weekday: nil, at: nil)).map(plain) == "Refreshes weekdays at 7:00 AM")
        #expect(copy().refreshes(Schedule(cadence: .weekly, hour: 9, minute: 0, weekday: 2, at: nil)).map(plain) == "Refreshes every Monday at 9:00 AM")
        #expect(copy().refreshes(Schedule(cadence: .once, hour: 9, minute: 0, weekday: nil, at: nil)) == nil)
    }

    @Test func metricValues() {
        let c = copy()
        #expect(c.metric(12480, unit: "$") == "$12,480")
        #expect(c.metric(38, unit: "%") == "38%")
        #expect(c.metric(1204, unit: nil) == "1,204")
        #expect(c.metric(4.25, unit: "h") == "4.2 h" || c.metric(4.25, unit: "h") == "4.3 h")
    }

    // MARK: Docs outline

    @Test func outlineFollowsTheDomOrder() {
        let html = """
        <style>h1 { color: red }</style><h1>Brief</h1><p>x</p><h2 class="a">Goals &amp; <b>risks</b></h2>
        <script>document.write("<h2>no</h2>")</script><h3></h3><h3>Next</h3><h4>skip</h4>
        """
        let headings = DocOutline.headings(in: html)
        #expect(headings.map(\.text) == ["Brief", "Goals & risks", "Next"])
        #expect(headings.map(\.index) == [0, 1, 3])
        #expect(headings.map(\.level) == [1, 2, 3])
        #expect(!DocOutline.isLong(html: html, headings: headings))
        let long = html + "<p>" + String(repeating: "word ", count: 400) + "</p>"
        #expect(DocOutline.isLong(html: long, headings: headings))
    }

    // MARK: Skills

    private func skill(_ name: String, _ description: String = "") -> Skill {
        Skill(id: name, name: name, description: description, instructions: "", createdAt: Self.now)
    }

    @Test func slashOpensTheList() {
        #expect(SkillQuery.trigger(in: "/", isComposing: false) == "")
        #expect(SkillQuery.trigger(in: "／wri", isComposing: false) == "wri")
        #expect(SkillQuery.trigger(in: "/wri", isComposing: true) == nil)
        #expect(SkillQuery.trigger(in: "/my-style now", isComposing: false) == nil)
        #expect(SkillQuery.trigger(in: "hi /x", isComposing: false) == nil)
    }

    @Test func filterRanksNamePrefixFirst() {
        let skills = [skill("tone-check", "Writing tone"), skill("my-writing-style"), skill("writing-coach"), skill("budget")]
        #expect(SkillQuery.filter(skills, query: "writ").map(\.name) == ["writing-coach", "my-writing-style", "tone-check"])
        #expect(SkillQuery.filter(skills, query: "").map(\.name) == ["budget", "my-writing-style", "tone-check", "writing-coach"])
        #expect(SkillQuery.filter(skills, query: "zzz").isEmpty)
    }

    // MARK: Reactions

    @Test func reactionsToggleTheUsersOwn() {
        let assistant = Reaction(emoji: "❤️", by: .assistant)
        #expect(!ReactionToggle.isOn([assistant], emoji: "❤️"))
        let on = ReactionToggle.toggled([assistant], emoji: "❤️", on: true)
        #expect(ReactionToggle.isOn(on, emoji: "❤️"))
        #expect(ReactionToggle.badges(on) == ["❤️"])
        let off = ReactionToggle.toggled(on, emoji: "❤️", on: false)
        #expect(off == [assistant])
        #expect(ReactionToggle.badges([Reaction(emoji: "👍", by: .user), assistant, Reaction(emoji: "👍", by: .assistant)]) == ["👍", "❤️"])
    }

    // MARK: Spend request and skill proposal

    private func spend(_ status: ApprovalStatus = .pending, expiresIn minutes: Double = 14) -> SpendRequest {
        SpendRequest(id: "s1", approvalId: "a1", amount: 1649, currency: "usd", merchant: "Bike Co", description: "",
                     item: "Inner tube", expiresAt: Self.now.addingTimeInterval(minutes * 60), status: status, testMode: true)
    }

    @Test func spendPhases() {
        #expect(SpendPhase(spend(), request: nil, now: Self.now) == .pending)
        #expect(SpendPhase(spend(), request: .inFlight, now: Self.now) == .busy)
        #expect(SpendPhase(spend(), request: .failed(reason: "x"), now: Self.now) == .failed("x"))
        #expect(SpendPhase(spend(expiresIn: -1), request: nil, now: Self.now) == .expired)
        #expect(SpendPhase(spend(.approved), request: .inFlight, now: Self.now) == .approved)
        #expect(SpendPhase(spend(.declined), request: nil, now: Self.now) == .declined)
        #expect(SpendPhase(spend(.expired), request: nil, now: Self.now) == .expired)
        #expect(SpendPhase.failed("x").isOpen && SpendPhase.pending.isOpen && !SpendPhase.busy.isOpen)
        #expect(CardFormat.minutesLeft(until: spend().expiresAt, now: Self.now) == 14)
        #expect(plain(CardFormat.money(minor: 1649, currency: "usd", locale: Locale(identifier: "en_US"))) == "$16.49")
    }

    @Test func skillProposalPhases() {
        #expect(SkillProposalPhase(.open, request: nil) == .open)
        #expect(SkillProposalPhase(.open, request: .inFlight) == .busy)
        #expect(SkillProposalPhase(.open, request: .failed(reason: "x")) == .failed("x"))
        #expect(SkillProposalPhase(.saved, request: .inFlight) == .saved)
        #expect(SkillProposalPhase(.dismissed, request: nil) == .dismissed)
    }
}
