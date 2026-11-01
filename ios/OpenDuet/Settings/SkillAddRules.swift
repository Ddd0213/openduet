// M25 (W2): the skills page's rules without SwiftUI, so the Mac host tests cover them: the Add
// skill menu's entries, which files Upload a skill takes (types for the Files picker, the
// extension check, the multipart type, the size caps), the upload's inline failure lines, and
// Create with OpenDuet's composer prefill.
import Foundation
import UniformTypeIdentifiers

/// The Add skill menu (a system Menu), in this order.
enum SkillAddEntry: CaseIterable, Hashable, Sendable {
    /// close the sheet, open the main thread, prefill the composer (nothing is sent)
    case createWithAssistant
    /// the Files picker at once, then the preview -> Import page
    case upload
    /// today's GitHub link page
    case github

    var title: LocalizedStringResource {
        switch self {
        case .createWithAssistant: "Create with OpenDuet"
        case .upload: "Upload a skill"
        case .github: "Import from GitHub"
        }
    }

    /// SF Symbols (the menu draws them as the system does).
    var symbol: String {
        switch self {
        case .createWithAssistant: "bubble.left.and.text.bubble.right"
        case .upload: "square.and.arrow.up"
        case .github: "chevron.left.forwardslash.chevron.right"
        }
    }
}

/// Upload a skill: POST /api/skills/upload/preview (multipart `file`). The server decides by the
/// bytes; the app only keeps obviously wrong files out and sends the file's own name.
enum SkillUpload {
    enum Kind: Hashable, Sendable {
        /// a .zip or a .skill (skill-creator's package, also a zip)
        case archive
        /// a single SKILL.md (or any .md / .txt)
        case markdown
    }

    /// m25.ts SKILL_UPLOAD_MAX_BYTES / SKILL_MD_UPLOAD_MAX_BYTES
    static let maxBytes = 20 * 1024 * 1024
    static let markdownMaxBytes = 1024 * 1024

    static let archiveExtensions: Set<String> = ["zip", "skill"]
    static let textExtensions: Set<String> = ["md", "markdown", "txt"]

    /// What a picked file is by its extension (any case); nil = not one we take.
    static func kind(forFileName name: String) -> Kind? {
        let ext = (name as NSString).pathExtension.lowercased()
        if archiveExtensions.contains(ext) { return .archive }
        if textExtensions.contains(ext) { return .markdown }
        return nil
    }

    static func limit(_ kind: Kind) -> Int {
        kind == .archive ? maxBytes : markdownMaxBytes
    }

    static func mime(_ kind: Kind) -> String {
        kind == .archive ? "application/zip" : "text/markdown"
    }

    /// The Files picker's types: zips, Markdown and plain text, `.skill` when the system knows
    /// it (no app declares one; Info.plist comes from project.yml), and `.data` so a `.skill`
    /// can still be picked. The extension check runs after the pick.
    static var contentTypes: [UTType] {
        var types: [UTType] = [.zip]
        for ext in ["skill", "md", "markdown"] {
            if let type = UTType(filenameExtension: ext), type.isDeclared, !types.contains(type) {
                types.append(type)
            }
        }
        types.append(contentsOf: [.plainText, .data])
        return types
    }

    /// The upload page's inline line for a failed preview (400 / 413 included); nil = cancelled.
    /// The server's known 400 texts read in the app's language; others show as sent.
    static func failureLine(for error: any Error, kind: Kind?) -> String? {
        if error is CancellationError { return nil }
        switch error as? APIError {
        case .tooLarge?:
            return tooLargeLine(kind)
        case .validationFailed(_, let message)?:
            return serverLine(message) ?? SettingsReason.line(for: error)
        default:
            return SettingsReason.line(for: error)
        }
    }

    static func tooLargeLine(_ kind: Kind?) -> String {
        kind == .markdown
            ? String(localized: "A SKILL.md can be up to 1 MB.")
            : String(localized: "Skills can be up to 20 MB.")
    }

    static var wrongTypeLine: String { String(localized: "Upload a .zip, a .skill or a SKILL.md file.") }

    /// backend skills/importer.ts fromUpload / fromSkillMd (the route sends "file: <text>").
    static func serverLine(_ message: String) -> String? {
        var text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("file:") { text = String(text.dropFirst(5)).trimmingCharacters(in: .whitespaces) }
        switch text {
        case "Upload a .zip, a .skill or a SKILL.md file.": return wrongTypeLine
        case "SKILL.md needs a name in its frontmatter.": return String(localized: "SKILL.md needs a name in its frontmatter.")
        case "SKILL.md has no instructions.": return String(localized: "SKILL.md has no instructions.")
        case "The file is empty.": return String(localized: "The file is empty.")
        case "": return nil
        default: return text
        }
    }
}

/// Create with OpenDuet: the main thread's composer opens with this text, the cursor at the end.
enum SkillCreatePrefill {
    /// The catalog gives "帮我创建一个技能：" in Chinese.
    static let text: LocalizedStringResource = "Help me create a skill: "

    /// The composer's draft after the prefill: the prefill alone when the draft is empty; a draft
    /// that already ends with it stays; otherwise the prefill goes on a new line after what was
    /// typed, so nothing is lost and the cursor (at the end) is right after it.
    static func draft(prefill: String, current: String) -> String {
        let typed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty { return prefill }
        if current.hasSuffix(prefill) { return current }
        let kept = current.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        return kept + "\n" + prefill
    }
}
