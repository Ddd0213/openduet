// M3 card formatting (Chat/Cards/CardFormat.swift): money from minor units in the current
// locale, "Expires in N min" minutes, "Updated … ago", recipients, long bodies, app slugs, and
// which edited cards glow.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Card formatting")
struct UICardFormatTests {
    private static let en = Locale(identifier: "en_US")
    private static let zh = Locale(identifier: "zh-Hans")
    private static let now = Date(timeIntervalSince1970: 1_792_400_000)

    @Test("minor digits follow the currency (USD 2, JPY 0, BHD 3)")
    func minorDigits() {
        #expect(CardFormat.minorDigits("USD") == 2)
        #expect(CardFormat.minorDigits("usd") == 2)
        #expect(CardFormat.minorDigits("JPY") == 0)
        #expect(CardFormat.minorDigits("BHD") == 3)
    }

    @Test("money is formatted from minor units in the given locale")
    func money() {
        #expect(CardFormat.money(minor: 64_000, currency: "USD", locale: Self.en) == "$640.00")
        #expect(CardFormat.money(minor: 1_500, currency: "JPY", locale: Self.en) == "¥1,500")
        #expect(CardFormat.money(minor: 5, currency: "USD", locale: Self.en) == "$0.05")
        let chinese = CardFormat.money(minor: 64_000, currency: "USD", locale: Self.zh)
        #expect(chinese.contains("640.00"))
        #expect(chinese.contains("$"))
    }

    @Test("minutes left round up and stop at the expiry")
    func minutesLeft() {
        func left(_ seconds: Double) -> Int? { CardFormat.minutesLeft(until: Self.now.addingTimeInterval(seconds), now: Self.now) }
        #expect(left(8 * 60) == 8)
        #expect(left(7 * 60 + 1) == 8)
        #expect(left(7 * 60) == 7)
        #expect(left(30) == 1)
        #expect(left(0) == nil)
        #expect(left(-90) == nil)
    }

    @Test("ago is nil within the last minute and abbreviated after")
    func ago() {
        #expect(CardFormat.ago(Self.now.addingTimeInterval(-30), now: Self.now, locale: Self.en) == nil)
        #expect(CardFormat.ago(Self.now.addingTimeInterval(10), now: Self.now, locale: Self.en) == nil)
        #expect(CardFormat.ago(Self.now.addingTimeInterval(-61), now: Self.now, locale: Self.en) == "1 min. ago")
        #expect(CardFormat.ago(Self.now.addingTimeInterval(-2 * 3600), now: Self.now, locale: Self.en) == "2 hr. ago")
        let chinese = CardFormat.ago(Self.now.addingTimeInterval(-61), now: Self.now, locale: Self.zh)
        #expect(chinese?.contains("分钟") == true)
    }

    @Test("recipients show the first address and how many more")
    func recipients() {
        #expect(CardFormat.recipients([]) == "")
        #expect(CardFormat.recipients(["a@example.com"]) == "a@example.com")
        #expect(CardFormat.recipients(["a@example.com", "b@example.com", "c@example.com"]) == "a@example.com +2")
    }

    @Test("bodies longer than eight lines (wrapped) fold")
    func longBody() {
        #expect(!CardFormat.isLongBody(Array(repeating: "line", count: 8).joined(separator: "\n")))
        #expect(CardFormat.isLongBody(Array(repeating: "line", count: 9).joined(separator: "\n")))
        #expect(CardFormat.isLongBody(String(repeating: "word ", count: 80)))
        #expect(!CardFormat.isLongBody(""))
    }

    @Test("app display names map to AppLogo slugs")
    func toolkitSlug() {
        #expect(CardFormat.toolkitSlug("Google Calendar") == "googlecalendar")
        #expect(CardFormat.toolkitSlug("Gmail") == "gmail")
        #expect(CardFormat.toolkitSlug("") == nil)
        #expect(CardFormat.toolkitSlug(nil) == nil)
    }

    @Test("the first look only records versions; a bigger version with fields glows once")
    func editGlow() {
        var tracker = EditGlowTracker()
        #expect(tracker.update(["m1": CardEdit(version: 2, fields: ["body"])]).isEmpty)
        #expect(tracker.update(["m1": CardEdit(version: 2, fields: ["body"])]).isEmpty)
        #expect(tracker.update(["m1": CardEdit(version: 3, fields: ["subject"])]) == ["m1"])
        #expect(tracker.update(["m1": CardEdit(version: 3, fields: ["subject"])]).isEmpty)
        // An older copy never glows again.
        #expect(tracker.update(["m1": CardEdit(version: 2, fields: ["body"])]).isEmpty)
        // A new entry after the first look glows; one without fields is only recorded.
        let edits = [
            "m1": CardEdit(version: 3, fields: ["subject"]),
            "m3": CardEdit(version: 2, fields: ["amount"]),
            "m2": CardEdit(version: 2, fields: []),
        ]
        #expect(tracker.update(edits) == ["m3"])
        #expect(tracker.seen == ["m1": 3, "m2": 2, "m3": 2])
    }

    @Test("several cards bumped at once glow in a stable order")
    func editGlowOrder() {
        var tracker = EditGlowTracker()
        _ = tracker.update([:])
        let bumped = tracker.update(["b": CardEdit(version: 2, fields: ["to"]), "a": CardEdit(version: 2, fields: ["body"])])
        #expect(bumped == ["a", "b"])
    }
}
