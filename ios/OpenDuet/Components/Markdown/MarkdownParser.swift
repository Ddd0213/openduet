// Block-level markdown for the assistant's bubbles (prompt L100, L183): paragraphs, headings, bullet,
// numbered and check lists (nested), quotes, fenced code, GFM tables and rules. Streaming-safe:
// an unclosed fence runs to the end, a table shows once its delimiter row arrives, and a
// half-typed marker on the last line is hidden (MarkdownInlineParser). Pure Foundation.
import Foundation

enum MarkdownParser {
    /// `streaming`: the text is still arriving, so its last line may stop mid-marker.
    static func parse(_ text: String, streaming: Bool = false) -> [MarkdownBlock] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        return parseBlocks(lines, atDocumentEnd: streaming)
    }

    /// `atDocumentEnd`: these lines end the whole text, so the last paragraph may still be streaming.
    static func parseBlocks(_ lines: [String], atDocumentEnd: Bool) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if isBlank(line) { i += 1; continue }
            if let fence = MarkdownFence(line) {
                var code: [String] = []
                var j = i + 1
                var closed = false
                while j < lines.count {
                    if fence.isClosed(by: lines[j]) { closed = true; j += 1; break }
                    code.append(fence.strip(lines[j]))
                    j += 1
                }
                blocks.append(.code(language: fence.language, code: code.joined(separator: "\n"), closed: closed))
                i = j
            } else if let heading = heading(line) {
                let tail = atDocumentEnd && i == lines.count - 1
                blocks.append(.heading(level: heading.level, MarkdownInlineParser.parse(heading.text, streamingTail: tail)))
                i += 1
            } else if isRule(line) {
                blocks.append(.rule)
                i += 1
            } else if quoteContent(line) != nil {
                let (block, next) = parseQuote(lines, from: i, atDocumentEnd: atDocumentEnd)
                blocks.append(block)
                i = next
            } else if let marker = MarkdownListMarker(line) {
                let (block, next) = parseList(lines, from: i, first: marker, atDocumentEnd: atDocumentEnd)
                blocks.append(block)
                i = next
            } else if let (table, next) = parseTable(lines, from: i) {
                blocks.append(.table(table))
                i = next
            } else {
                var j = i + 1
                while j < lines.count, !isBlank(lines[j]), !interruptsParagraph(lines, at: j) { j += 1 }
                blocks.append(.paragraph(paragraphInlines(Array(lines[i..<j]), streamingTail: atDocumentEnd && j == lines.count)))
                i = j
            }
        }
        return blocks
    }

    // MARK: - Paragraphs

    private static func paragraphInlines(_ lines: [String], streamingTail: Bool) -> [MarkdownInline] {
        let joined = lines.enumerated().map { index, line -> String in
            var trimmed = String(line.drop(while: { $0 == " " || $0 == "\t" }))
            // Hard breaks ("  " or "\" at the end) become plain line breaks; chat keeps them all.
            if index < lines.count - 1 {
                while trimmed.hasSuffix(" ") { trimmed.removeLast() }
                if trimmed.hasSuffix("\\") { trimmed.removeLast() }
            }
            return trimmed
        }.joined(separator: "\n")
        return MarkdownInlineParser.parse(joined, streamingTail: streamingTail)
    }

    /// Lines that end a paragraph without a blank line between (bullets break in like chat apps do).
    private static func interruptsParagraph(_ lines: [String], at index: Int) -> Bool {
        let line = lines[index]
        if MarkdownFence(line) != nil || heading(line) != nil || isRule(line) || quoteContent(line) != nil { return true }
        if let marker = MarkdownListMarker(line), !marker.content.isEmpty { return true }
        return parseTable(lines, from: index) != nil
    }

    // MARK: - Headings and rules

    static func heading(_ line: String) -> (level: Int, text: String)? {
        let indent = leadingSpaces(line)
        guard indent <= 3 else { return nil }
        let rest = line.dropFirst(indent)
        let hashes = rest.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes) else { return nil }
        let after = rest.dropFirst(hashes)
        guard after.isEmpty || after.first == " " || after.first == "\t" else { return nil }
        var text = after.trimmingCharacters(in: .whitespaces)
        // Optional closing hashes: "## Title ##".
        if let range = text.range(of: #"\s+#+$"#, options: .regularExpression) {
            text.removeSubrange(range)
        } else if text.allSatisfy({ $0 == "#" }) {
            text = ""
        }
        return (hashes, text)
    }

    static func isRule(_ line: String) -> Bool {
        guard leadingSpaces(line) <= 3 else { return false }
        let chars = line.filter { $0 != " " && $0 != "\t" }
        guard chars.count >= 3, let first = chars.first, "-*_".contains(first) else { return false }
        return chars.allSatisfy { $0 == first }
    }

    // MARK: - Quotes

    static func quoteContent(_ line: String) -> String? {
        let indent = leadingSpaces(line)
        guard indent <= 3 else { return nil }
        var rest = line.dropFirst(indent)
        guard rest.first == ">" else { return nil }
        rest = rest.dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }

    private static func parseQuote(_ lines: [String], from start: Int, atDocumentEnd: Bool) -> (MarkdownBlock, Int) {
        var inner: [String] = []
        var j = start
        while j < lines.count {
            if let content = quoteContent(lines[j]) {
                inner.append(content)
            } else if !isBlank(lines[j]), let last = inner.last, !isBlank(last), !startsBlock(lines[j]) {
                inner.append(lines[j])  // lazy continuation of the quoted paragraph
            } else {
                break
            }
            j += 1
        }
        return (.quote(parseBlocks(inner, atDocumentEnd: atDocumentEnd && j == lines.count)), j)
    }

    static func startsBlock(_ line: String) -> Bool {
        MarkdownFence(line) != nil || heading(line) != nil || isRule(line) || quoteContent(line) != nil || MarkdownListMarker(line) != nil
    }

    // MARK: - Helpers

    static func isBlank(_ line: String) -> Bool {
        line.allSatisfy { $0 == " " || $0 == "\t" }
    }

    /// Leading indentation in columns (a tab counts as 4).
    static func leadingSpaces<S: StringProtocol>(_ line: S) -> Int {
        var count = 0
        for ch in line {
            if ch == " " { count += 1 } else if ch == "\t" { count += 4 } else { break }
        }
        return count
    }

    /// Removes up to `columns` columns of leading indentation.
    static func dedent(_ line: String, by columns: Int) -> String {
        var removed = 0
        var index = line.startIndex
        while index < line.endIndex, removed < columns {
            let ch = line[index]
            if ch == " " { removed += 1 } else if ch == "\t" { removed += 4 } else { break }
            index = line.index(after: index)
        }
        return String(line[index...])
    }
}

/// An opening code fence: ``` or ~~~ (3+), with an optional info string.
struct MarkdownFence {
    let char: Character
    let length: Int
    let indent: Int
    let language: String?

    init?(_ line: String) {
        let indent = MarkdownParser.leadingSpaces(line)
        guard indent <= 3 else { return nil }
        let rest = line.drop(while: { $0 == " " || $0 == "\t" })
        guard let first = rest.first, first == "`" || first == "~" else { return nil }
        let run = rest.prefix(while: { $0 == first }).count
        guard run >= 3 else { return nil }
        let info = rest.dropFirst(run).trimmingCharacters(in: .whitespaces)
        // A backtick fence's info string can't contain backticks (that's inline code).
        if first == "`", info.contains("`") { return nil }
        char = first
        length = run
        self.indent = indent
        let word = info.split(separator: " ").first.map(String.init)
        language = word?.isEmpty == false ? word : nil
    }

    func isClosed(by line: String) -> Bool {
        guard MarkdownParser.leadingSpaces(line) <= 3 else { return false }
        let rest = line.trimmingCharacters(in: .whitespaces)
        return rest.count >= length && rest.allSatisfy { $0 == char }
    }

    func strip(_ line: String) -> String {
        MarkdownParser.dedent(line, by: indent)
    }
}

// MARK: - M19: the parse cache

/// Parsed markdown for the views that draw it (M19). The thread re-renders its realized rows on
/// every store write, and each assistant row parsed its whole text on every pass, twice (the bubble
/// and its VoiceOver text). Keyed by text + streaming, small and bounded, main actor only (views
/// and their actions); `MarkdownParser.parse` itself stays pure. Texts still streaming in have
/// their own few slots: each delta is a new key, and it must not push the finished ones out.
@MainActor
enum MarkdownCache {
    static let settledLimit = 256
    static let streamingLimit = 8

    private static var settled = BoundedMemo<String, MarkdownCacheEntry>(limit: settledLimit)
    private static var streamingTexts = BoundedMemo<String, MarkdownCacheEntry>(limit: streamingLimit)

    /// `MarkdownParser.parse(text, streaming:)`, parsed once per text.
    static func blocks(_ text: String, streaming: Bool = false) -> [MarkdownBlock] {
        entry(text, streaming: streaming).blocks
    }

    /// The text without markdown markers (VoiceOver, the quote's excerpt), blocks one per line;
    /// joined once per text, from the same parse the bubble draws.
    static func plainText(_ text: String, streaming: Bool = false) -> String {
        entry(text, streaming: streaming).plainText
    }

    /// How many parses are kept (tests).
    static var count: (settled: Int, streaming: Int) { (settled.count, streamingTexts.count) }

    private static func entry(_ text: String, streaming: Bool) -> MarkdownCacheEntry {
        if let hit = streaming ? streamingTexts[text] : settled[text] { return hit }
        let made = MarkdownCacheEntry(blocks: MarkdownParser.parse(text, streaming: streaming))
        if streaming {
            streamingTexts.insert(made, for: text)
        } else {
            settled.insert(made, for: text)
        }
        return made
    }
}

/// One cached parse; its plain text is joined the first time something asks for it.
@MainActor
private final class MarkdownCacheEntry {
    let blocks: [MarkdownBlock]
    private(set) lazy var plainText: String = blocks.map(\.plainText).joined(separator: "\n")

    init(blocks: [MarkdownBlock]) { self.blocks = blocks }
}

/// A dictionary that keeps at most `limit` entries, dropping the oldest insert first (FIFO: the
/// cached texts are re-read far more often than new ones arrive, so an LRU's bookkeeping on
/// every hit isn't worth it).
struct BoundedMemo<Key: Hashable, Value> {
    let limit: Int
    private var values: [Key: Value] = [:]
    private var order: [Key] = []

    init(limit: Int) { self.limit = max(limit, 1) }

    var count: Int { values.count }

    subscript(key: Key) -> Value? { values[key] }

    mutating func insert(_ value: Value, for key: Key) {
        guard values.updateValue(value, forKey: key) == nil else { return }
        order.append(key)
        if order.count > limit { values[order.removeFirst()] = nil }
    }
}
