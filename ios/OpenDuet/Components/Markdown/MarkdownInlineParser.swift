// Inline markdown: **bold**, *italic* / _italic_, ~~strike~~, `code`, [links](url), <autolinks>,
// bare http(s):// and duet:// links, and backslash escapes. Emphasis follows CommonMark's
// delimiter rules (with CJK text treated like punctuation next to "*", so "**“引号”**的" works).
//
// Streaming (`streamingTail`): the text may stop mid-marker. On its last line an unclosed "**" or
// "*" opens to the end ("**Bold" shows bold), a trailing bare "**" is hidden, an unclosed "`"
// runs to the end as code, and "[text](partial-url" shows just "text". Pure Foundation.
import Foundation

enum MarkdownInlineParser {
    static func parse(_ text: String, streamingTail: Bool = false) -> [MarkdownInline] {
        let chars = Array(text)
        return MarkdownInlineScanner(chars: chars, streaming: streamingTail).parse(0..<chars.count)
    }
}

/// A run of "*", "_" or "~~" waiting to be matched (CommonMark "process emphasis").
struct MarkdownDelimiter {
    let char: Character
    var count: Int
    let originalCount: Int
    let canOpen: Bool
    let canClose: Bool
    /// Index in `chars` where the run starts; used for the streaming-tail rules.
    let position: Int
}

private enum Piece {
    case node(MarkdownInline)
    case delimiter(MarkdownDelimiter)
}

struct MarkdownInlineScanner {
    let chars: [Character]
    let streaming: Bool

    // MARK: Tokenize

    func parse(_ range: Range<Int>) -> [MarkdownInline] {
        var pieces: [Piece] = []
        var text = ""
        func flushText() {
            if !text.isEmpty { pieces.append(.node(.text(text))); text = "" }
        }
        let atEnd = streaming && range.upperBound == chars.count
        var i = range.lowerBound
        while i < range.upperBound {
            let c = chars[i]
            switch c {
            case "\\":
                if i + 1 < range.upperBound, chars[i + 1].isASCII, chars[i + 1].isPunctuation || chars[i + 1].isSymbol {
                    text.append(chars[i + 1])
                    i += 2
                } else {
                    // A trailing "\" while streaming is most likely the start of an escape.
                    if !(atEnd && i + 1 == range.upperBound) { text.append(c) }
                    i += 1
                }
            case "`":
                let run = runLength(at: i, in: range)
                if let close = closingBackticks(from: i + run, length: run, in: range) {
                    flushText()
                    pieces.append(.node(.code(codeContent(i + run..<close))))
                    i = close + run
                } else if atEnd {
                    flushText()
                    let content = codeContent(i + run..<range.upperBound)
                    if !content.isEmpty { pieces.append(.node(.code(content))) }
                    i = range.upperBound
                } else {
                    text.append(String(repeating: "`", count: run))
                    i += run
                }
            case "*", "_", "~":
                let run = runLength(at: i, in: range)
                if c == "~", run != 2 {
                    text.append(String(repeating: "~", count: run))
                } else {
                    flushText()
                    pieces.append(.delimiter(delimiter(c, at: i, count: run, in: range)))
                }
                i += run
            case "[", "!":
                let start = c == "!" ? i + 1 : i
                guard start < range.upperBound, chars[start] == "[" else { text.append(c); i += 1; continue }
                if let link = link(openingAt: start, in: range) {
                    flushText()
                    pieces += link.nodes.map { .node($0) }
                    i = link.end
                } else {
                    text.append(c)
                    i += 1
                }
            case "<":
                if let (url, end) = angleLink(at: i, in: range) {
                    flushText()
                    pieces.append(.node(.link(url: url, [.text(url)])))
                    i = end
                } else {
                    text.append(c)
                    i += 1
                }
            case "h", "d", "w":
                if let end = bareURLEnd(at: i, in: range) {
                    flushText()
                    var url = String(chars[i..<end])
                    let shown = url
                    if url.hasPrefix("www.") { url = "https://" + url }
                    pieces.append(.node(.link(url: url, [.text(shown)])))
                    i = end
                } else {
                    text.append(c)
                    i += 1
                }
            default:
                text.append(c)
                i += 1
            }
        }
        flushText()
        resolveEmphasis(&pieces, bottom: 0)
        return flatten(resolveTail(pieces, reachesEnd: atEnd))
    }

    // MARK: Emphasis (CommonMark "process emphasis", simplified to one pass over `pieces`)

    private func resolveEmphasis(_ pieces: inout [Piece], bottom: Int) {
        var closerIndex = bottom
        while closerIndex < pieces.count {
            guard case .delimiter(var closer) = pieces[closerIndex], closer.canClose, closer.count > 0 else {
                closerIndex += 1
                continue
            }
            // While streaming, a shorter run at the very end ("**bold*") is a closer still arriving.
            var openerIndex: Int?
            var j = closerIndex - 1
            while j >= bottom {
                if case .delimiter(let opener) = pieces[j], opener.canOpen, opener.count > 0,
                   opener.char == closer.char, compatible(opener, closer),
                   !(isTrailing(closer) && opener.count > closer.count) {
                    openerIndex = j
                    break
                }
                j -= 1
            }
            guard let oi = openerIndex, case .delimiter(var opener) = pieces[oi] else {
                closerIndex += 1
                continue
            }
            let used = opener.char == "~" ? 2 : (opener.count >= 2 && closer.count >= 2 ? 2 : 1)
            let inner = flatten(Array(pieces[(oi + 1)..<closerIndex]))
            let node: MarkdownInline = switch (opener.char, used) {
            case ("~", _): .strikethrough(inner)
            case (_, 2): .strong(inner)
            default: .emphasis(inner)
            }
            opener.count -= used
            closer.count -= used
            pieces.replaceSubrange(oi...closerIndex, with: [.delimiter(opener), .node(node), .delimiter(closer)])
            closerIndex = oi + 2
        }
    }

    /// CommonMark's "rule of 3" for runs that can both open and close.
    private func compatible(_ opener: MarkdownDelimiter, _ closer: MarkdownDelimiter) -> Bool {
        if opener.char == "~" { return opener.count == 2 && closer.count == 2 }
        guard opener.canClose || closer.canOpen else { return true }
        let sum = opener.originalCount + closer.originalCount
        return sum % 3 != 0 || (opener.originalCount % 3 == 0 && closer.originalCount % 3 == 0)
    }

    // MARK: Streaming tail

    /// On the last line of streaming text, the earliest unmatched opener styles everything after it.
    private func resolveTail(_ pieces: [Piece], reachesEnd: Bool) -> [Piece] {
        guard reachesEnd else { return pieces }
        let lastLineStart = (chars.lastIndex(of: "\n") ?? -1) + 1
        guard let index = pieces.firstIndex(where: { piece in
            if case .delimiter(let d) = piece { isTailOpener(d, lastLineStart: lastLineStart) } else { false }
        }), case .delimiter(let opener) = pieces[index] else { return pieces }
        let rest = resolveTail(Array(pieces[(index + 1)...]), reachesEnd: true)
        let inner = flatten(rest)
        var result = Array(pieces[..<index])
        guard !inner.isEmpty else { return result }
        let node: MarkdownInline = switch (opener.char, opener.count) {
        case ("~", _): .strikethrough(inner)
        case (_, 1): .emphasis(inner)
        case (_, 2): .strong(inner)
        default: .emphasis([.strong(inner)])
        }
        result.append(.node(node))
        return result
    }

    private func isTailOpener(_ d: MarkdownDelimiter, lastLineStart: Int) -> Bool {
        guard d.canOpen, d.count > 0, d.char != "_", d.originalCount <= 3, d.position >= lastLineStart else { return false }
        // "5*3" or "a*b" (a letter or digit right before): maths or a word, not a streaming marker.
        let before = d.position > 0 ? chars[d.position - 1] : " "
        return !(before.isASCII && (before.isLetter || before.isNumber))
    }

    /// A marker run that ends the streaming text ("Here is **").
    private func isTrailing(_ d: MarkdownDelimiter) -> Bool {
        streaming && d.position + d.originalCount == chars.count && d.originalCount <= 3
    }

    private func flatten(_ pieces: [Piece]) -> [MarkdownInline] {
        var result: [MarkdownInline] = []
        for piece in pieces {
            switch piece {
            case .node(let node): append(node, to: &result)
            case .delimiter(let d):
                guard d.count > 0 else { continue }
                // An unmatched run at the very end of streaming text is a marker still arriving.
                if isTrailing(d) { continue }
                append(.text(String(repeating: d.char, count: d.count)), to: &result)
            }
        }
        return result
    }

    private func append(_ node: MarkdownInline, to result: inout [MarkdownInline]) {
        if case .text(let new) = node, case .text(let old)? = result.last {
            result[result.count - 1] = .text(old + new)
        } else if case .text(let new) = node, new.isEmpty {
            return
        } else {
            result.append(node)
        }
    }
}
