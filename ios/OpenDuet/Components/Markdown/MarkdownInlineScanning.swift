// Character-level helpers of MarkdownInlineScanner: delimiter flanking, code spans, links and
// autolinks. Pure Foundation.
import Foundation

extension MarkdownInlineScanner {
    func runLength(at index: Int, in range: Range<Int>) -> Int {
        var end = index
        while end < range.upperBound, chars[end] == chars[index] { end += 1 }
        return end - index
    }

    // MARK: Delimiters

    func delimiter(_ char: Character, at index: Int, count: Int, in range: Range<Int>) -> MarkdownDelimiter {
        let before: Character = index > range.lowerBound ? chars[index - 1] : " "
        let after: Character = index + count < range.upperBound ? chars[index + count] : " "
        let beforeSpace = before.isWhitespace, afterSpace = after.isWhitespace
        // CJK text counts as punctuation for "*" and "~~" (CJK has no spaces around bold);
        // "_" keeps the strict rule so file_names_like_this stay literal.
        let cjk = char != "_"
        let beforePunct = Self.isPunctuation(before) || (cjk && Self.isCJK(before))
        let afterPunct = Self.isPunctuation(after) || (cjk && Self.isCJK(after))
        let leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct)
        let rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct)
        let canOpen: Bool, canClose: Bool
        if char == "_" {
            canOpen = leftFlanking && (!rightFlanking || beforePunct)
            canClose = rightFlanking && (!leftFlanking || afterPunct)
        } else {
            canOpen = leftFlanking
            canClose = rightFlanking
        }
        return MarkdownDelimiter(char: char, count: count, originalCount: count, canOpen: canOpen, canClose: canClose, position: index)
    }

    static func isPunctuation(_ c: Character) -> Bool {
        c.isPunctuation || c.isSymbol
    }

    static func isCJK(_ c: Character) -> Bool {
        guard let scalar = c.unicodeScalars.first?.value else { return false }
        return (0x2E80...0x9FFF).contains(scalar)     // CJK radicals, kana, ideographs
            || (0xAC00...0xD7AF).contains(scalar)     // Hangul
            || (0xF900...0xFAFF).contains(scalar)     // compatibility ideographs
            || (0xFF00...0xFFEF).contains(scalar)     // full-width forms
            || (0x20000...0x2FA1F).contains(scalar)   // extension ideographs
    }

    // MARK: Code spans

    func closingBackticks(from start: Int, length: Int, in range: Range<Int>) -> Int? {
        var i = start
        while i < range.upperBound {
            if chars[i] == "`" {
                let run = runLength(at: i, in: range)
                if run == length { return i }
                i += run
            } else {
                i += 1
            }
        }
        return nil
    }

    func codeContent(_ range: Range<Int>) -> String {
        var text = String(chars[range]).replacingOccurrences(of: "\n", with: " ")
        if text.count >= 2, text.hasPrefix(" "), text.hasSuffix(" "), !text.allSatisfy({ $0 == " " }) {
            text = String(text.dropFirst().dropLast())
        }
        return text
    }

    // MARK: Links

    /// "[text](url)" / "![alt](url)" starting at the "[" index. While streaming, a link still
    /// arriving shows its text only; otherwise an unfinished one is no link (nil).
    func link(openingAt open: Int, in range: Range<Int>) -> (nodes: [MarkdownInline], end: Int)? {
        let atEnd = streaming && range.upperBound == chars.count
        guard let close = matching(open: "[", close: "]", from: open, in: range) else {
            // "[" with no "]" yet: hide the bracket while the text streams in.
            guard atEnd else { return nil }
            return (parse(open + 1..<range.upperBound), range.upperBound)
        }
        let label = parse(open + 1..<close)
        let afterClose = close + 1
        guard afterClose < range.upperBound else {
            // "[text]" at the very end: a "(url)" may follow.
            return atEnd ? (label, range.upperBound) : nil
        }
        guard chars[afterClose] == "(" else { return nil }
        guard let paren = matching(open: "(", close: ")", from: afterClose, in: range) else {
            return atEnd ? (label, range.upperBound) : nil
        }
        var destination = String(chars[(afterClose + 1)..<paren]).trimmingCharacters(in: .whitespaces)
        // Drop an optional title: (url "title").
        if let space = destination.firstIndex(where: { $0 == " " }) { destination = String(destination[..<space]) }
        if destination.hasPrefix("<"), destination.hasSuffix(">") { destination = String(destination.dropFirst().dropLast()) }
        guard !destination.isEmpty else { return (label, paren + 1) }
        let shown = label.isEmpty ? [MarkdownInline.text(destination)] : label
        return ([.link(url: destination, shown)], paren + 1)
    }

    /// The index of the bracket closing the one at `from`, skipping escapes and code spans.
    private func matching(open: Character, close: Character, from: Int, in range: Range<Int>) -> Int? {
        var depth = 0
        var i = from
        while i < range.upperBound {
            let c = chars[i]
            if c == "\\" { i += 2; continue }
            if c == "`" {
                let run = runLength(at: i, in: range)
                if let end = closingBackticks(from: i + run, length: run, in: range) { i = end + run; continue }
                i += run
                continue
            }
            if c == open { depth += 1 } else if c == close {
                depth -= 1
                if depth == 0 { return i }
            }
            i += 1
        }
        return nil
    }

    /// <https://example.com> and <duet://tasks/abc>.
    func angleLink(at index: Int, in range: Range<Int>) -> (String, Int)? {
        var i = index + 1
        while i < range.upperBound {
            let c = chars[i]
            if c == ">" { break }
            if c.isWhitespace || c == "<" { return nil }
            i += 1
        }
        guard i < range.upperBound else { return nil }
        let url = String(chars[(index + 1)..<i])
        guard url.range(of: #"^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s]+$"#, options: .regularExpression) != nil else { return nil }
        return (url, i + 1)
    }

    /// The end of a bare http(s)://, duet:// or www. link starting at `index`, if there is one.
    func bareURLEnd(at index: Int, in range: Range<Int>) -> Int? {
        if index > range.lowerBound {
            let before = chars[index - 1]
            if before.isASCII && (before.isLetter || before.isNumber) || before == "/" || before == "@" { return nil }
        }
        let prefixes = ["https://", "http://", "duet://", "www."]
        guard let prefix = prefixes.first(where: { hasPrefix($0, at: index, in: range) }) else { return nil }
        var end = index + prefix.count
        // URLs stop at spaces, "<" and the first non-ASCII character (CJK text often follows directly).
        while end < range.upperBound, chars[end].isASCII, !chars[end].isWhitespace, chars[end] != "<" { end += 1 }
        // Trailing punctuation belongs to the sentence; ")" only when unbalanced.
        while end > index + prefix.count {
            let last = chars[end - 1]
            if ".,:;!?\"'*_~".contains(last) {
                end -= 1
            } else if last == ")" {
                let slice = chars[index..<end]
                if slice.filter({ $0 == ")" }).count > slice.filter({ $0 == "(" }).count { end -= 1 } else { break }
            } else {
                break
            }
        }
        guard end > index + prefix.count else { return nil }
        return end
    }

    private func hasPrefix(_ prefix: String, at index: Int, in range: Range<Int>) -> Bool {
        let p = Array(prefix)
        guard index + p.count <= range.upperBound else { return false }
        for (offset, ch) in p.enumerated() where chars[index + offset].lowercased() != String(ch) { return false }
        return true
    }
}
