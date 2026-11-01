// M9 UI logic: a routine row's copy (Tasks/ScheduleCopy.swift: its times, next run / Paused /
// Finished, its last run) and a gallery item's long-press Delete (Stores/MakeReducer.swift: it
// leaves at once with its viewers; a failed delete puts it back where it was).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M9 routine copy")
struct UIM9RoutineCopyTests {
    private static let zone = TimeZone(identifier: "America/Los_Angeles")!
    /// Tuesday 2026-11-03 09:00 in Los Angeles.
    private static let now: Date = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 9, minute: 0))!
    }()

    private func copy(_ identifier: String = "en_US") -> ScheduleCopy {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = Self.zone
        return ScheduleCopy(format: ChatDateFormat(
            locale: Locale(identifier: identifier), calendar: calendar, timeZone: Self.zone, now: Self.now,
            joinDayAndTime: { day, time in identifier.hasPrefix("zh") ? "\(day) \(time)" : "\(day) at \(time)" }
        ))
    }

    /// ICU puts a narrow no-break space before AM/PM; compare with plain spaces.
    private func plain(_ text: String?) -> String? {
        text?.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    private func at(day: Int, _ hour: Int, _ minute: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = Self.zone
        return calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour, minute: minute))!
    }

    private func schedule(_ cadence: Schedule.Cadence, _ hour: Int, _ minute: Int, weekday: Int? = nil, at: Date? = nil) -> Schedule {
        Schedule(cadence: cadence, hour: hour, minute: minute, weekday: weekday, at: at)
    }

    private func routine(paused: Bool = false, next: Date? = nil, last: Date? = nil, status: Routine.LastStatus? = nil) -> Routine {
        Routine(paused: paused, quiet: false, nextRunAt: next, lastRunAt: last, lastRunStatus: status)
    }

    @Test func eachCadenceReadsNaturally() {
        let c = copy()
        #expect(plain(c.schedule(schedule(.daily, 9, 0))) == "Daily at 9:00 AM")
        #expect(plain(c.schedule(schedule(.weekdays, 8, 30))) == "Weekdays at 8:30 AM")
        #expect(plain(c.schedule(schedule(.weekly, 9, 0, weekday: 1))) == "Every Monday at 9:00 AM")
        #expect(c.schedule(schedule(.hourly, 0, 5)) == "Every hour at :05")
        #expect(plain(c.schedule(schedule(.once, 9, 0, at: at(day: 5, 9, 0)))) == "Once, Nov 5 at 9:00 AM")
    }

    @Test func weekdaysFollowTheContractAndTheLocale() {
        #expect(copy().weekdayName(0) == "Sunday")
        #expect(copy().weekdayName(6) == "Saturday")
        #expect(copy().weekdayName(7) == "Sunday", "out of range wraps instead of crashing")
        #expect(copy("zh_Hans_CN").weekdayName(1) == "星期一")
    }

    @Test func rowLineSaysNextRunPausedOrFinished() {
        let c = copy()
        let daily = schedule(.daily, 9, 0)
        #expect(plain(c.routineLine(daily, routine(next: at(day: 4, 9, 0)))) == "Daily at 9:00 AM · next run tomorrow at 9:00 AM")
        #expect(plain(c.routineLine(daily, routine(paused: true))) == "Daily at 9:00 AM · Paused")
        // Paused wins over a stale next run.
        #expect(plain(c.routineLine(daily, routine(paused: true, next: at(day: 4, 9, 0)))) == "Daily at 9:00 AM · Paused")
        let once = schedule(.once, 9, 0, at: at(day: 2, 9, 0))
        #expect(c.routineLine(once, routine(last: at(day: 2, 9, 0), status: .completed)).hasSuffix("· Finished"))
        #expect(c.routineLine(daily, routine()).hasSuffix("· Waiting for its next time"))
        #expect(c.routineLine(nil, routine(paused: true)) == "Paused")
    }

    @Test func lastRunSaysWhenAndHowItWent() {
        let c = copy()
        #expect(c.lastRun(routine()) == nil, "nothing before the first run")
        #expect(plain(c.lastRun(routine(last: at(day: 3, 8, 0), status: .completed))) == "Last run today at 8:00 AM · Posted")
        #expect(plain(c.lastRun(routine(last: at(day: 2, 9, 0), status: .failed))) == "Last run yesterday at 9:00 AM · Failed")
        #expect(c.lastRun(routine(status: .skipped)) == "Skipped")
    }
}

@Suite("M9 gallery delete")
struct UIM9GalleryDeleteTests {
    private static let now = Date(timeIntervalSince1970: 1_793_000_000)

    private func item(_ id: String, hoursAgo: Double, pinned: Bool = false, title: String? = nil) -> ArtifactSummary {
        let at = Self.now.addingTimeInterval(-hoursAgo * 3600)
        return ArtifactSummary(id: id, channelId: "c1", type: .webPage, title: title ?? "T \(id)", status: .ready, sourceCount: 0,
                               refreshSchedule: nil, pinnedToTabBar: pinned, createdAt: at, updatedAt: at)
    }

    @Test func deleteLeavesAtOnceAndAFailurePutsItBack() {
        var state = MakeState()
        state.applyList([item("a", hoursAgo: 1), item("b", hoursAgo: 2, pinned: true), item("c", hoursAgo: 3)])
        state.justMade.insert("b")
        state.viewer = ArtifactViewerState(artifactId: "b")
        state.pinnedViewer = ArtifactViewerState(artifactId: "b")
        state.requests[MakeState.RequestKey.pin("b")] = .inFlight
        #expect(state.pinned?.id == "b")

        let removal = state.remove("b")
        #expect(removal != nil)
        #expect(state.artifacts.map(\.id) == ["a", "c"])
        #expect(state.viewer == nil)
        #expect(state.pinnedViewer == nil)
        #expect(state.pinned == nil, "its tab goes too")
        #expect(!state.justMade.contains("b"))
        #expect(state.requests[MakeState.RequestKey.pin("b")] == nil)

        state.restore(removal!)
        #expect(state.artifacts.map(\.id) == ["a", "b", "c"], "back where it was (newest first)")
        #expect(state.justMade.contains("b"))
        #expect(state.pinned?.id == "b")
        let r1 = state.remove("missing")
        #expect(r1 == nil)
    }

    @Test func aCopyThatArrivedMeanwhileWinsOverTheRollback() {
        var state = MakeState()
        state.applyList([item("a", hoursAgo: 1), item("b", hoursAgo: 2)])
        let removal = state.remove("b")!
        state.applyList([item("a", hoursAgo: 1), item("b", hoursAgo: 0.5, title: "Newer")])
        state.restore(removal)
        #expect(state.artifacts.filter { $0.id == "b" }.map(\.title) == ["Newer"])
    }
}
