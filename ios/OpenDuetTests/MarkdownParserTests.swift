// MarkdownParser / MarkdownInlineParser: OpenDuet's bubble markdown (prompt L100, L183), including
// text that stops mid-marker while it streams.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Markdown parser")
struct MarkdownParserTests {
    private func inline(_ text: String, streaming: Bool = false) -> [MarkdownInline] {
        MarkdownInlineParser.parse(text, streamingTail: streaming)
    }

    // MARK: Inline

    @Test("bold, italic, code and strikethrough")
    func basicInline() {
        #expect(inline("a **b** *c* `d` ~~e~~") == [
            .text("a "), .strong([.text("b")]), .text(" "), .emphasis([.text("c")]), .text(" "),
            .code("d"), .text(" "), .strikethrough([.text("e")]),
        ])
        #expect(inline("_italic_ and __bold__") == [.emphasis([.text("italic")]), .text(" and "), .strong([.text("bold")])])
    }

    @Test("bold run-in headings")
    func runIn() {
        #expect(inline("**Today:** two launches") == [.strong([.text("Today:")]), .text(" two launches")])
    }

    @Test("nested emphasis follows CommonMark")
    func nested() {
        #expect(inline("***both***") == [.emphasis([.strong([.text("both")])])])
        #expect(inline("**a *b* c**") == [.strong([.text("a "), .emphasis([.text("b")]), .text(" c")])])
        #expect(inline("*a **b** c*") == [.emphasis([.text("a "), .strong([.text("b")]), .text(" c")])])
    }

    @Test("literal stars, underscores and tildes stay text")
    func literals() {
        #expect(inline("2 * 3 = 6") == [.text("2 * 3 = 6")])
        #expect(inline("snake_case_name") == [.text("snake_case_name")])
        #expect(inline("about ~5 min") == [.text("about ~5 min")])
        #expect(inline(#"\*not italic\*"#) == [.text("*not italic*")])
    }

    @Test("bold around CJK text and CJK punctuation")
    func cjk() {
        #expect(inline("这是**重点**。") == [.text("这是"), .strong([.text("重点")]), .text("。")])
        #expect(inline("是**“引号”**的") == [.text("是"), .strong([.text("“引号”")]), .text("的")])
    }

    @Test("links, autolinks and duet:// task links")
    func links() {
        #expect(inline("[Docs](https://example.com) here") == [.link(url: "https://example.com", [.text("Docs")]), .text(" here")])
        #expect(inline("see https://example.com/a_b.") == [.text("see "), .link(url: "https://example.com/a_b", [.text("https://example.com/a_b")]), .text(".")])
        #expect(inline("<https://x.dev>") == [.link(url: "https://x.dev", [.text("https://x.dev")])])
        #expect(inline("[Draft the brief](duet://tasks/abc123)") == [.link(url: "duet://tasks/abc123", [.text("Draft the brief")])])
        #expect(inline("[**Bold** link](https://a.b)") == [.link(url: "https://a.b", [.strong([.text("Bold")]), .text(" link")])])
        #expect(inline("网址https://a.cn，好") == [.text("网址"), .link(url: "https://a.cn", [.text("https://a.cn")]), .text("，好")])
    }

    @Test("an unfinished link in finished text stays literal")
    func brokenLink() {
        #expect(inline("[not a link] and [x](") == [.text("[not a link] and [x](")])
    }

    // MARK: Streaming

    @Test("an unclosed bold on the streaming line shows bold")
    func streamingBold() {
        #expect(inline("Here is **bold", streaming: true) == [.text("Here is "), .strong([.text("bold")])])
        #expect(inline("Here is *ital", streaming: true) == [.text("Here is "), .emphasis([.text("ital")])])
    }

    @Test("a trailing bare marker is hidden while streaming")
    func streamingTrailingMarker() {
        #expect(inline("Here is **", streaming: true) == [.text("Here is ")])
        #expect(inline("**bold*", streaming: true) == [.strong([.text("bold")])])
        #expect(inline("**done**", streaming: true) == [.strong([.text("done")])])
    }

    @Test("a link still arriving shows only its text")
    func streamingLink() {
        #expect(inline("See [the doc](https://exa", streaming: true) == [.text("See "), .text("the doc")].merged)
        #expect(inline("See [the d", streaming: true) == [.text("See the d")])
    }

    @Test("an unclosed code span runs to the end while streaming")
    func streamingCode() {
        #expect(inline("run `npm te", streaming: true) == [.text("run "), .code("npm te")])
        #expect(inline("run `npm te") == [.text("run `npm te")])
    }

    @Test("maths is not mistaken for a streaming marker")
    func streamingMaths() {
        #expect(inline("5*3", streaming: true) == [.text("5*3")])
    }

    // MARK: Blocks

    @Test("paragraphs keep line breaks and split on blank lines")
    func paragraphs() {
        let blocks = MarkdownParser.parse("one\ntwo\n\nthree")
        #expect(blocks == [.paragraph([.text("one\ntwo")]), .paragraph([.text("three")])])
    }

    @Test("headings")
    func headings() {
        #expect(MarkdownParser.parse("## Plan ##\nbody") == [.heading(level: 2, [.text("Plan")]), .paragraph([.text("body")])])
        #expect(MarkdownParser.parse("#hashtag") == [.paragraph([.text("#hashtag")])])
    }

    @Test("bullet and numbered lists, also right after a paragraph")
    func lists() {
        let blocks = MarkdownParser.parse("How I'll help:\n- Keep deadlines\n- Take drafting\n\n1. First\n2. Second")
        #expect(blocks == [
            .paragraph([.text("How I'll help:")]),
            .list(MarkdownList(start: nil, items: [
                MarkdownListItem(checked: nil, blocks: [.paragraph([.text("Keep deadlines")])]),
                MarkdownListItem(checked: nil, blocks: [.paragraph([.text("Take drafting")])]),
            ])),
            .list(MarkdownList(start: 1, items: [
                MarkdownListItem(checked: nil, blocks: [.paragraph([.text("First")])]),
                MarkdownListItem(checked: nil, blocks: [.paragraph([.text("Second")])]),
            ])),
        ])
        #expect(MarkdownParser.parse("• one\n• two") == [.list(MarkdownList(start: nil, items: [
            MarkdownListItem(checked: nil, blocks: [.paragraph([.text("one")])]),
            MarkdownListItem(checked: nil, blocks: [.paragraph([.text("two")])]),
        ]))])
    }

    @Test("nested lists and checklists")
    func nestedLists() {
        let blocks = MarkdownParser.parse("1. Plan\n   - [x] Book\n   - [ ] Pack\n2. Go")
        let sub = MarkdownBlock.list(MarkdownList(start: nil, items: [
            MarkdownListItem(checked: true, blocks: [.paragraph([.text("Book")])]),
            MarkdownListItem(checked: false, blocks: [.paragraph([.text("Pack")])]),
        ]))
        #expect(blocks == [.list(MarkdownList(start: 1, items: [
            MarkdownListItem(checked: nil, blocks: [.paragraph([.text("Plan")]), sub]),
            MarkdownListItem(checked: nil, blocks: [.paragraph([.text("Go")])]),
        ]))])
    }

    @Test("quotes and rules")
    func quotesAndRules() {
        #expect(MarkdownParser.parse("> quoted\n> more\n\n---\n* * *") == [
            .quote([.paragraph([.text("quoted\nmore")])]), .rule, .rule,
        ])
    }

    @Test("fenced code keeps its text; an unclosed fence runs to the end")
    func code() {
        #expect(MarkdownParser.parse("```swift\nlet a = 1\n  b()\n```\nafter") == [
            .code(language: "swift", code: "let a = 1\n  b()", closed: true), .paragraph([.text("after")]),
        ])
        #expect(MarkdownParser.parse("```\nlet a = **1**") == [.code(language: nil, code: "let a = **1**", closed: false)])
    }

    @Test("tables with alignment; a header alone stays a paragraph until its delimiter row")
    func tables() {
        let blocks = MarkdownParser.parse("| Name | Due |\n|:--|--:|\n| Launch | Fri |\n| Brief |")
        #expect(blocks == [.table(MarkdownTable(
            alignments: [.leading, .trailing],
            header: [[.text("Name")], [.text("Due")]],
            rows: [[[.text("Launch")], [.text("Fri")]], [[.text("Brief")], []]]
        ))])
        #expect(MarkdownParser.parse("| Name | Due |") == [.paragraph([.text("| Name | Due |")])])
        #expect(MarkdownParser.tableCells(#"| a \| b | c |"#) == ["a | b", "c"])
    }

    @Test("streaming: only the last paragraph is treated as unfinished")
    func streamingBlocks() {
        let blocks = MarkdownParser.parse("Use *args here\n\nNow **bo", streaming: true)
        #expect(blocks == [.paragraph([.text("Use *args here")]), .paragraph([.text("Now "), .strong([.text("bo")])])])
        // A finished message keeps a lone marker as written.
        #expect(MarkdownParser.parse("Use * for wildcards") == [.paragraph([.text("Use * for wildcards")])])
    }

    @Test("empty and blank text parse to nothing")
    func empty() {
        #expect(MarkdownParser.parse("").isEmpty)
        #expect(MarkdownParser.parse("  \n\n").isEmpty)
    }
}

private extension Array where Element == MarkdownInline {
    /// Adjacent text nodes joined, as the parser emits them.
    var merged: [MarkdownInline] {
        reduce(into: []) { result, node in
            if case .text(let new) = node, case .text(let old)? = result.last {
                result[result.count - 1] = .text(old + new)
            } else {
                result.append(node)
            }
        }
    }
}
