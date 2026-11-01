// Lists (bullets "-", "*", "+", "•"; numbers "1." / "1)"; checklists "- [ ]") with nesting by
// indentation, and GFM tables. Pure Foundation.
import Foundation

/// A list item's marker line: indentation, the marker, and the item's first-line content.
struct MarkdownListMarker {
    let indent: Int
    /// nil for bullets.
    let number: Int?
    let bullet: Character?
    /// Column where the item's content starts (children indent at least this far).
    let contentIndent: Int
    let checked: Bool?
    let content: String

    init?(_ line: String) {
        let indent = MarkdownParser.leadingSpaces(line)
        let rest = Substring(MarkdownParser.dedent(line, by: indent))
        var markerWidth = 0
        var number: Int?
        var bullet: Character?
        if let first = rest.first, "-*+•".contains(first) {
            bullet = first
            markerWidth = 1
        } else {
            let digits = rest.prefix(while: { $0.isASCII && $0.isNumber })
            guard (1...9).contains(digits.count) else { return nil }
            let after = rest.dropFirst(digits.count)
            guard let delimiter = after.first, delimiter == "." || delimiter == ")" else { return nil }
            number = Int(digits)
            markerWidth = digits.count + 1
        }
        let afterMarker = rest.dropFirst(markerWidth)
        // The marker must be followed by a space or end the line ("**bold**" is no bullet).
        guard afterMarker.isEmpty || afterMarker.first == " " || afterMarker.first == "\t" else { return nil }
        let spaces = min(max(afterMarker.prefix(while: { $0 == " " }).count, 1), 4)
        var content = String(afterMarker.drop(while: { $0 == " " || $0 == "\t" }))
        var checked: Bool?
        if bullet != nil, content.count >= 3, content.hasPrefix("[") {
            let chars = Array(content)
            if chars[2] == "]", chars.count == 3 || chars[3] == " " {
                switch chars[1] {
                case " ": checked = false
                case "x", "X": checked = true
                default: break
                }
                if checked != nil { content = String(chars.dropFirst(3)).trimmingCharacters(in: .whitespaces) }
            }
        }
        self.indent = indent
        self.number = number
        self.bullet = bullet
        self.contentIndent = indent + markerWidth + spaces
        self.checked = checked
        self.content = content
    }

    func sameList(as other: MarkdownListMarker) -> Bool {
        (number == nil) == (other.number == nil)
    }
}

extension MarkdownParser {
    static func parseList(_ lines: [String], from start: Int, first: MarkdownListMarker, atDocumentEnd: Bool) -> (MarkdownBlock, Int) {
        var items: [MarkdownListItem] = []
        var j = start
        var marker = first
        while true {
            var itemLines = [marker.content]
            j += 1
            var pendingBlanks = 0
            while j < lines.count {
                let line = lines[j]
                if isBlank(line) { pendingBlanks += 1; j += 1; continue }
                let indent = leadingSpaces(line)
                if let next = MarkdownListMarker(line), next.indent <= marker.indent { break }
                if indent > marker.indent {
                    // A child line: nested list, continuation paragraph or code under the item.
                    itemLines += Array(repeating: "", count: pendingBlanks)
                    itemLines.append(dedent(line, by: min(indent, marker.contentIndent)))
                } else if pendingBlanks == 0, let last = itemLines.last, !isBlank(last), !startsBlock(line) {
                    itemLines.append(line)  // lazy continuation of the item's paragraph
                } else {
                    break
                }
                pendingBlanks = 0
                j += 1
            }
            let itemEnd = atDocumentEnd && j == lines.count
            items.append(MarkdownListItem(checked: marker.checked, blocks: parseBlocks(itemLines, atDocumentEnd: itemEnd)))
            guard j < lines.count, let next = MarkdownListMarker(lines[j]), next.indent <= first.indent + 3, next.sameList(as: first) else { break }
            // A shallower marker than the list's own belongs to an outer list.
            if next.indent < first.indent { break }
            marker = next
        }
        return (.list(MarkdownList(start: first.number, items: items)), j)
    }

    // MARK: - Tables

    /// A GFM table: a header row with "|", then a delimiter row ("|---|:--:|"), then rows.
    /// While only the header has streamed in, the line stays a paragraph.
    static func parseTable(_ lines: [String], from start: Int) -> (MarkdownTable, Int)? {
        guard start + 1 < lines.count, lines[start].contains("|") else { return nil }
        let header = tableCells(lines[start])
        guard let alignments = delimiterRow(lines[start + 1]), alignments.count == header.count else { return nil }
        var rows: [[[MarkdownInline]]] = []
        var j = start + 2
        while j < lines.count, !isBlank(lines[j]), lines[j].contains("|"), !startsBlock(lines[j]) {
            var cells = tableCells(lines[j])
            if cells.count < header.count { cells += Array(repeating: "", count: header.count - cells.count) }
            rows.append(cells.prefix(header.count).map { MarkdownInlineParser.parse($0, streamingTail: false) })
            j += 1
        }
        let table = MarkdownTable(
            alignments: alignments,
            header: header.map { MarkdownInlineParser.parse($0, streamingTail: false) },
            rows: rows
        )
        return (table, j)
    }

    private static func delimiterRow(_ line: String) -> [MarkdownTable.Alignment]? {
        let cells = tableCells(line)
        guard !cells.isEmpty else { return nil }
        var result: [MarkdownTable.Alignment] = []
        for cell in cells {
            let c = cell.trimmingCharacters(in: .whitespaces)
            let left = c.hasPrefix(":"), right = c.hasSuffix(":")
            let dashes = c.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            result.append(left && right ? .center : right ? .trailing : .leading)
        }
        return result
    }

    /// Cells of a row, split on unescaped "|" (an outer leading / trailing pipe is dropped).
    static func tableCells(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|"), !text.hasSuffix("\\|") { text.removeLast() }
        var cells: [String] = []
        var current = ""
        var escaped = false
        for ch in text {
            if escaped {
                if ch != "|" { current.append("\\") }
                current.append(ch)
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(ch)
            }
        }
        if escaped { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }
}
