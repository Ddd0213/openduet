// The parsed form of the assistant's markdown (prompt L100, L183). Pure Foundation so the parser runs
// in the Mac host tests; MarkdownView renders it.
import Foundation

enum MarkdownBlock: Hashable, Sendable {
    case paragraph([MarkdownInline])
    case heading(level: Int, [MarkdownInline])
    case list(MarkdownList)
    case quote([MarkdownBlock])
    /// `closed` is false while the closing fence hasn't streamed in yet.
    case code(language: String?, code: String, closed: Bool)
    case table(MarkdownTable)
    case rule
}

struct MarkdownList: Hashable, Sendable {
    /// nil for bullets, else the number of the first item (kept as written).
    var start: Int?
    var items: [MarkdownListItem]

    var ordered: Bool { start != nil }
}

struct MarkdownListItem: Hashable, Sendable {
    /// nil = plain item; true / false = a checklist item "- [x]" / "- [ ]".
    var checked: Bool?
    var blocks: [MarkdownBlock]
}

struct MarkdownTable: Hashable, Sendable {
    enum Alignment: Hashable, Sendable { case leading, center, trailing }
    var alignments: [Alignment]
    var header: [[MarkdownInline]]
    var rows: [[[MarkdownInline]]]
}

/// Line breaks inside a paragraph stay as "\n" in `.text` (chat keeps the model's line breaks).
indirect enum MarkdownInline: Hashable, Sendable {
    case text(String)
    case strong([MarkdownInline])
    case emphasis([MarkdownInline])
    case strikethrough([MarkdownInline])
    case code(String)
    case link(url: String, [MarkdownInline])
}

extension MarkdownInline {
    /// The visible text, for accessibility and tests.
    var plainText: String {
        switch self {
        case .text(let s), .code(let s): s
        case .strong(let c), .emphasis(let c), .strikethrough(let c), .link(_, let c): c.plainText
        }
    }
}

extension Array where Element == MarkdownInline {
    var plainText: String { map(\.plainText).joined() }
}

extension MarkdownBlock {
    /// The visible text of a block, for VoiceOver (M19: moved here from MessageView so the parse
    /// cache, host-tested, can join it).
    var plainText: String {
        switch self {
        case .paragraph(let inlines), .heading(_, let inlines): inlines.plainText
        case .list(let list): list.items.map { $0.blocks.map(\.plainText).joined(separator: " ") }.joined(separator: "\n")
        case .quote(let blocks): blocks.map(\.plainText).joined(separator: "\n")
        case .code(_, let code, _): code
        case .table(let table): ([table.header] + table.rows).map { $0.map(\.plainText).joined(separator: ", ") }.joined(separator: "\n")
        case .rule: ""
        }
    }
}
