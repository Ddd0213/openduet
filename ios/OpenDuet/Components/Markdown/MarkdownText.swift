// Inline markdown -> one SwiftUI Text, so a paragraph wraps, selects and reads as one piece.
// Links are blue and open through the environment's openURL (ThreadView routes http(s) to a
// Safari sheet and duet:// to openRoute). M8 (orig-chat.jpeg): duet://tasks/<id> and
// duet://artifacts/<id> links sit in a soft rounded pill with a small icon tile in front (the
// task's live status, the artifact's type), the title blue; inline code gets a rounded
// background; a bare URL shows tidy (no scheme, "www." or trailing slash).
import SwiftUI

struct MarkdownTextStyle {
    var size: CGFloat
    var weight: Font.Weight = .regular
    var color: Color
    /// Artifact id -> type, for the icon in an artifact link's pill (unknown ids show a doc).
    var artifactTypes: [String: ArtifactType] = [:]
    /// Task id -> live status, for the icon in a task link's pill (unknown ids show a checklist).
    var taskStatuses: [String: TaskStatus] = [:]
}

enum MarkdownText {
    static func text(_ inlines: [MarkdownInline], style: MarkdownTextStyle) -> Text {
        var result = Text(verbatim: "")
        for run in runs(inlines, Traits()) {
            result = result + piece(run, style: style)
        }
        return result
    }

    /// True when a duet:// task or artifact link appears, so the paragraph needs the pill renderer.
    static func hasTaskLink(_ inlines: [MarkdownInline]) -> Bool {
        inlines.contains { inline in
            switch inline {
            case .link(let url, _): isTaskLink(url) || artifactId(url) != nil
            case .strong(let c), .emphasis(let c), .strikethrough(let c): hasTaskLink(c)
            case .text, .code: false
            }
        }
    }

    /// True when the text needs TaskPillRenderer: a task / artifact pill or inline code.
    static func needsRenderer(_ inlines: [MarkdownInline]) -> Bool {
        inlines.contains { inline in
            switch inline {
            case .code: true
            case .link(let url, let c): isTaskLink(url) || artifactId(url) != nil || needsRenderer(c)
            case .strong(let c), .emphasis(let c), .strikethrough(let c): needsRenderer(c)
            case .text: false
            }
        }
    }

    static func isTaskLink(_ url: String) -> Bool {
        url.lowercased().hasPrefix("duet://tasks/")
    }

    /// The id of a duet://tasks/<id> link.
    static func taskId(_ url: String) -> String? {
        id(after: "duet://tasks/", in: url)
    }

    /// The id of a duet://artifacts/<id> link.
    static func artifactId(_ url: String) -> String? {
        id(after: "duet://artifacts/", in: url)
    }

    private static func id(after prefix: String, in url: String) -> String? {
        guard url.lowercased().hasPrefix(prefix) else { return nil }
        let id = url.dropFirst(prefix.count).split(separator: "/").first.map(String.init)?.removingPercentEncoding
        return id?.isEmpty == false ? id : nil
    }

    /// A paragraph that is one bare web link and nothing else (a URL on its own line): the
    /// bubble shows it as a link chip. A titled link ("[the docs](https://…)") stays inline.
    static func bareLink(_ inlines: [MarkdownInline]) -> URL? {
        let meaningful = inlines.filter { inline in
            if case .text(let s) = inline { return !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            return true
        }
        guard meaningful.count == 1, case .link(let url, let content) = meaningful[0], isBare(url: url, content: content),
              let link = URL(string: url), let scheme = link.scheme?.lowercased(), scheme == "https" || scheme == "http",
              link.host() != nil
        else { return nil }
        return link
    }

    /// The link's text is its own URL (a bare or <auto> link, or "www." shown without https://).
    private static func isBare(url: String, content: [MarkdownInline]) -> Bool {
        guard content.count == 1, case .text(let shown) = content[0] else { return false }
        return shown == url || "https://" + shown == url
    }

    /// "example.com/docs" for "https://www.example.com/docs/"; a long path keeps its start.
    static func tidy(_ url: String) -> String {
        var s = url
        for prefix in ["https://", "http://"] where s.lowercased().hasPrefix(prefix) {
            s.removeFirst(prefix.count)
        }
        if s.lowercased().hasPrefix("www.") { s.removeFirst(4) }
        while s.hasSuffix("/") { s.removeLast() }
        guard s.count > 48, let slash = s.firstIndex(of: "/") else { return s.isEmpty ? url : s }
        let host = s[..<slash]
        let path = s[slash...]
        let keep = max(48 - host.count, 12)
        return path.count > keep ? host + path.prefix(keep) + "…" : s
    }

    // MARK: - Flattening

    private enum Pill: Hashable {
        case task(String?)
        case artifact(String)
    }

    private struct Traits {
        var bold = false
        var italic = false
        var strike = false
        var code = false
        var link: URL?
        /// A task or artifact link's pill (an icon tile in front of its first run).
        var pill: Pill?
    }

    private struct Run {
        var text: String
        var traits: Traits
        /// The first run of a pill carries its icon.
        var icon: Pill?
    }

    private static func runs(_ inlines: [MarkdownInline], _ traits: Traits) -> [Run] {
        inlines.flatMap { inline -> [Run] in
            var t = traits
            switch inline {
            case .text(let s):
                return [Run(text: s, traits: t)]
            case .code(let s):
                t.code = true
                return [Run(text: s, traits: t)]
            case .strong(let c):
                t.bold = true
                return runs(c, t)
            case .emphasis(let c):
                t.italic = true
                return runs(c, t)
            case .strikethrough(let c):
                t.strike = true
                return runs(c, t)
            case .link(let url, let c):
                t.link = URL(string: url)
                if let id = artifactId(url) {
                    t.pill = .artifact(id)
                } else if isTaskLink(url) {
                    t.pill = .task(taskId(url))
                }
                // A bare web link reads tidy; its target stays the full URL.
                let content = t.pill == nil && isBare(url: url, content: c) && url.lowercased().hasPrefix("http") ? [MarkdownInline.text(tidy(url))] : c
                var inner = runs(content, t)
                if let pill = t.pill, !inner.isEmpty { inner[0].icon = pill }
                return inner
            }
        }
    }

    private static func piece(_ run: Run, style: MarkdownTextStyle) -> Text {
        let t = run.traits
        let design: Font.Design = t.code ? .monospaced : .default
        var font = Font.system(size: t.code ? style.size * 0.88 : style.size, weight: t.bold ? .semibold : style.weight, design: design)
        if t.italic { font = font.italic() }
        var string = AttributedString(run.text)
        string.font = font
        string.foregroundColor = t.link != nil ? Palette.link : style.color
        if t.strike { string.strikethroughStyle = .single }
        if let url = t.link { string.link = url }
        let body = Text(string)
        if t.code {
            // Hair spaces outside the mono run give the rounded background its side padding.
            let pad = Text(verbatim: "\u{200A}").font(.system(size: style.size))
            return pad + body.customAttribute(InlineCodeAttribute()) + pad
        }
        guard t.pill != nil else { return body }
        // Thin spaces inside the pill so its rounded rect clears the title.
        let space = Text(verbatim: "\u{2009}").font(.system(size: style.size))
        var text = body + space
        if let icon = run.icon {
            text = space + iconText(icon, style: style) + space + text
        } else {
            text = space + text
        }
        return text.customAttribute(TaskPillAttribute())
    }

    /// The pill's leading icon: the task's live status or the artifact's type, tinted, on a tile.
    private static func iconText(_ pill: Pill, style: MarkdownTextStyle) -> Text {
        let symbol: String
        let tint: PillTint
        switch pill {
        case .artifact(let id):
            let type = style.artifactTypes[id] ?? .docs
            symbol = type.systemImage
            tint = .artifact(type)
        case .task(let id):
            switch id.flatMap({ style.taskStatuses[$0] }) {
            case .readyForReview?: symbol = DuetGlyph.eye.symbol; tint = .ready
            case .needsInput?: symbol = DuetGlyph.approval.symbol; tint = .needsInput
            case .working?: symbol = TaskStatus.working.glyph; tint = .working
            case .scheduled?: symbol = DuetGlyph.clock.symbol; tint = .neutral
            case .resolved?: symbol = DuetGlyph.check.symbol; tint = .neutral
            case nil: symbol = DuetGlyph.task.symbol; tint = .neutral
            }
        }
        return Text(Image(systemName: symbol))
            .font(.system(size: style.size * 0.66, weight: .semibold))
            .foregroundColor(tint.color)
            .customAttribute(PillTileAttribute(tint: tint))
    }
}

/// The colour of a pill's icon and its tile.
enum PillTint: Hashable, Sendable {
    case ready, needsInput, working, neutral
    case artifact(ArtifactType)

    var color: Color {
        switch self {
        case .ready: Palette.readyForReview
        case .needsInput: Palette.needsInput
        case .working: Palette.working
        case .neutral: Palette.secondaryText
        case .artifact(let type): type.tint
        }
    }
}

/// Marks the runs of a task or artifact link for TaskPillRenderer.
struct TaskPillAttribute: TextAttribute {}

/// Marks a pill's icon: the renderer puts a tinted rounded tile behind it.
struct PillTileAttribute: TextAttribute {
    var tint: PillTint
}

/// Marks inline code: the renderer draws a rounded background behind it.
struct InlineCodeAttribute: TextAttribute {}

/// Draws the soft rounded pill behind task / artifact links (neighbouring marked runs on a line
/// share one pill), the tinted tile behind a pill's icon and the rounded background of inline
/// code, then the text as usual.
struct TaskPillRenderer: TextRenderer {
    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            var pills: [CGRect] = []
            var tiles: [(CGRect, PillTint)] = []
            var codes: [CGRect] = []
            var pill: CGRect?
            for run in line {
                let bounds = run.typographicBounds.rect
                if run[TaskPillAttribute.self] != nil {
                    let rect = bounds.insetBy(dx: 0, dy: -1.5)
                    pill = pill.map { $0.union(rect) } ?? rect
                } else if let rect = pill {
                    pills.append(rect)
                    pill = nil
                }
                if let tile = run[PillTileAttribute.self] {
                    let side = min(bounds.height + 1, bounds.width + 6)
                    tiles.append((CGRect(x: bounds.midX - side / 2, y: bounds.midY - side / 2, width: side, height: side), tile.tint))
                }
                if run[InlineCodeAttribute.self] != nil {
                    let rect = bounds.insetBy(dx: -2.5, dy: 0)
                    if let last = codes.last, abs(last.maxX - rect.minX) < 0.5 + 5 {
                        codes[codes.count - 1] = last.union(rect)
                    } else {
                        codes.append(rect)
                    }
                }
            }
            if let rect = pill { pills.append(rect) }
            for rect in pills {
                let shape = RoundedRectangle(cornerRadius: min(8, rect.height * 0.3), style: .continuous)
                context.fill(shape.path(in: rect), with: .color(Palette.pill))
            }
            for (rect, tint) in tiles {
                let shape = RoundedRectangle(cornerRadius: rect.height * 0.28, style: .continuous)
                context.fill(shape.path(in: rect), with: .color(tint.color.opacity(0.16)))
            }
            for rect in codes {
                let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)
                context.fill(shape.path(in: rect), with: .color(Palette.inlineCode))
            }
            context.draw(line)
        }
    }
}

extension Palette {
    /// The soft neutral pill behind task / artifact links in an assistant bubble (orig-chat.jpeg).
    static let pill = Color.dynamic(light: 0x141413, dark: 0xFFFFFF).opacity(0.065)
}
