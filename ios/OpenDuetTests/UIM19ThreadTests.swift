// M19 chat thread (plan section T): the thread at rest past its own end (OverscrollRule, the
// blank thread after a send), the markdown parse cache and its bounds, the cached clock time, and
// a refreshed page that changes nothing not writing the thread.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M19 thread")
struct UIM19ThreadTests {
    // MARK: - Overscroll

    /// A visible area of 100...700 (600 pt) and 2000 pt of content ending at `end`.
    private func pastEnd(_ end: CGFloat, height: CGFloat = 2000) -> Bool {
        OverscrollRule.isPastEnd(contentTop: end - height, contentEnd: end, visibleTop: 100, visibleBottom: 700)
    }

    @Test("Past the end: more than 40 pt of empty room under content taller than the visible area")
    func overscroll() {
        #expect(!pastEnd(700), "at the bottom")
        #expect(!pastEnd(1200), "scrolled up: content below the visible bottom")
        #expect(!pastEnd(700 - OverscrollRule.tolerance), "exactly the tolerance")
        #expect(pastEnd(700 - OverscrollRule.tolerance - 1))
        // The blank thread: every row above the visible area.
        #expect(pastEnd(90))
    }

    @Test("A short thread resting at the top with room below it isn't past its end")
    func shortThread() {
        #expect(!pastEnd(400, height: 300))
        #expect(!pastEnd(700, height: 600), "exactly the visible height")
        #expect(pastEnd(640, height: 601))
        // Shorter than the visible area with the keyboard down, but left scrolled up by it: the
        // top rows are clipped with blank room below.
        #expect(OverscrollRule.isPastEnd(contentTop: -150, contentEnd: 300, visibleTop: 100, visibleBottom: 700))
        #expect(!OverscrollRule.isPastEnd(contentTop: 100, contentEnd: 550, visibleTop: 100, visibleBottom: 700), "short, at its top")
        #expect(!OverscrollRule.isPastEnd(contentTop: .nan, contentEnd: 90, visibleTop: 100, visibleBottom: 700))
        #expect(!OverscrollRule.isPastEnd(contentTop: -1900, contentEnd: .infinity, visibleTop: 100, visibleBottom: 700))
    }

    @Test("The gap is signed (fromBottom stays clamped at 0 for ↓)")
    func signedGap() {
        #expect(OverscrollRule.gap(contentEnd: 600, visibleBottom: 700) == 100)
        #expect(OverscrollRule.gap(contentEnd: 900.4, visibleBottom: 700) == -200)
        #expect(OverscrollRule.gap(contentEnd: .infinity, visibleBottom: 700) == 0)
        // ↓'s own reading is unchanged: past the end still reads as 0 there.
        #expect(JumpButtonRule.fromBottom(contentEnd: 600, visibleBottom: 700) == 0)
        #expect(JumpButtonRule.fromBottom(contentEnd: 900, visibleBottom: 700) == 200)
    }

    // MARK: - Parse cache

    @Test("The parse cache returns what the parser does, streaming or not, and the plain text from it")
    @MainActor func parseCache() {
        let text = "**Bold** and `code`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nhalf **open"
        #expect(MarkdownCache.blocks(text) == MarkdownParser.parse(text))
        #expect(MarkdownCache.blocks(text) == MarkdownParser.parse(text), "from the cache")
        #expect(MarkdownCache.blocks(text, streaming: true) == MarkdownParser.parse(text, streaming: true))
        #expect(MarkdownCache.plainText(text) == MarkdownParser.parse(text).map(\.plainText).joined(separator: "\n"))
        #expect(MarkdownCache.plainText(text, streaming: true) == MarkdownParser.parse(text, streaming: true).map(\.plainText).joined(separator: "\n"))
        #expect(MarkdownCache.plainText("") == "")
    }

    @Test("Streaming deltas keep to their own few slots; neither part grows past its limit")
    @MainActor func parseCacheBounded() {
        for index in 0..<(MarkdownCache.streamingLimit + 20) { _ = MarkdownCache.blocks("delta \(index)", streaming: true) }
        #expect(MarkdownCache.count.streaming == MarkdownCache.streamingLimit)
        for index in 0..<(MarkdownCache.settledLimit + 10) { _ = MarkdownCache.plainText("settled m19 \(index)") }
        #expect(MarkdownCache.count.settled == MarkdownCache.settledLimit)
    }

    @Test("BoundedMemo drops the oldest insert first; a key inserted again keeps its place")
    func boundedMemo() {
        var memo = BoundedMemo<String, Int>(limit: 2)
        memo.insert(1, for: "a")
        memo.insert(2, for: "b")
        memo.insert(3, for: "c")
        #expect(memo["a"] == nil)
        #expect(memo["b"] == 2 && memo["c"] == 3 && memo.count == 2)
        memo.insert(4, for: "b")
        #expect(memo["b"] == 4)
        memo.insert(5, for: "d")
        #expect(memo["b"] == nil)
        #expect(memo["c"] == 3 && memo["d"] == 5)
    }

    // MARK: - Clock time

    @Test("The cached clock time reads as ChatDateFormat's, per locale")
    @MainActor func cachedTime() {
        let date = Fx.date(3600)
        for id in ["en_US", "en_GB", "zh_Hans_CN"] {
            let locale = Locale(identifier: id)
            let expected = ChatDateFormat(locale: locale, timeZone: .current).time(date)
            #expect(ChatTimeFormat.time(date, locale: locale) == expected)
            #expect(ChatTimeFormat.time(date, locale: locale) == expected, "from the cache")
        }
    }

    // MARK: - Refreshed page

    @Test("A refreshed page that changes nothing reports no change and leaves the thread; a changed one reports it")
    func refreshUnchanged() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.applyFirstPage(Fx.page([Fx.message("o1", at: 1), Fx.message("m2", at: 2), Fx.message("m3", at: 3)], hasMore: true))
        let before = reducer.thread
        // The same newest page again: the usual switch back to a cached thread.
        let same = reducer.applyRefreshedPage(Fx.page([Fx.message("m2", at: 2), Fx.message("m3", at: 3)], hasMore: true))
        #expect(!same)
        #expect(reducer.thread == before)
        // An edited message.
        let edited = reducer.applyRefreshedPage(Fx.page([Fx.message("m2", at: 2), Fx.message("m3", at: 3, text: "edited", updated: 5)], hasMore: true))
        #expect(edited)
        #expect(reducer.thread.messages.map(\.text) == ["hi", "hi", "edited"])
        // A new message.
        let added = reducer.applyRefreshedPage(Fx.page([Fx.message("m3", at: 3, text: "edited", updated: 5), Fx.message("m4", at: 4)], hasMore: true))
        #expect(added)
        #expect(reducer.thread.messages.map(\.id) == ["o1", "m2", "m3", "m4"])
        // Before the first load it is the first load: a change.
        var fresh = ThreadReducer(channelId: Fx.main)
        let first = fresh.applyRefreshedPage(Fx.page([Fx.message("m1", at: 1)]))
        #expect(first)
    }
}
