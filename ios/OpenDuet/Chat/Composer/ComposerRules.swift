// The composer's send rules (M8, decided by the user; this changes prompt L92): the waveform
// turns into ↑ as soon as the field has ANY text, including an uncommitted pinyin / marked
// candidate; tapping ↑ while composing commits the candidate first and sends everything visible.
// Return while composing still only commits (the keyboard's own handling, never a send).
// Pure Foundation (host-tested).
import Foundation

enum ComposerRules {
    /// ↑ instead of the waveform: committed text, a candidate being composed, or an uploaded file.
    static func showsSend(committed: String, hasMarkedText: Bool, hasUploads: Bool) -> Bool {
        hasMarkedText || !trimmed(committed).isEmpty || hasUploads
    }

    /// ↑ is enabled: something to send and no attachment still uploading or failed.
    static func canSend(committed: String, hasMarkedText: Bool, hasUploads: Bool, attachmentsReady: Bool) -> Bool {
        showsSend(committed: committed, hasMarkedText: hasMarkedText, hasUploads: hasUploads) && attachmentsReady
    }

    /// What ↑ sends: the field's full text once the candidate is committed (`visible`, read from
    /// the text view after unmarkText), else the committed draft; trimmed.
    static func outgoingText(committed: String, visible: String?) -> String {
        trimmed(visible ?? committed)
    }

    private static func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// M10 (plan 2.8 stop responding): what the composer's filled circle does right now.
enum ComposerAction: Hashable, Sendable {
    /// Nothing typed, the assistant idle: the waveform; a tap starts a voice call (M13).
    case voice
    /// Nothing typed while the assistant replies in this thread: ■, stop the reply.
    case stop
    /// Something to send: ↑ (while a reply runs, the message queues behind it).
    case send
    /// M13: nothing typed, the assistant idle, a call open: the call's live waveform; a tap ends it.
    case endCall

    /// Typed text (or a candidate, or an upload) always wins over ■, and ■ over the call.
    static func make(hasContent: Bool, replying: Bool, inCall: Bool = false) -> ComposerAction {
        if hasContent { return .send }
        if replying { return .stop }
        return inCall ? .endCall : .voice
    }
}

/// M29: pasting into the composer's field (ComposerUITextView). Images on the pasteboard become
/// attachments through the same path as "+" (ComposerBar.add, ChatStore.addAttachments: the same
/// 25 MB line and server refusals); text in the same paste goes into the field as before.
enum PasteRules {
    /// Images taken from one paste (the Photos picker's limit).
    static let maxImages = 10

    /// What one Paste does.
    struct Plan: Equatable, Sendable {
        /// the field's own paste runs (text)
        var pastesText: Bool
        /// the pasteboard's images are attached
        var attachesImages: Bool
    }

    /// Paste is offered in the field's menu: the system's own reasons (text), or images where
    /// the composer takes attachments. Only `hasImages` is asked (no "Allow Paste" prompt).
    static func offersPaste(systemOffers: Bool, acceptsImages: Bool, hasImages: Bool) -> Bool {
        systemOffers || (acceptsImages && hasImages)
    }

    /// Images where the composer takes attachments; the text either way (when there is text, or
    /// when the images can't be taken here: the system's paste then does what it always did).
    static func plan(acceptsImages: Bool, hasImages: Bool, hasStrings: Bool) -> Plan {
        let attaches = acceptsImages && hasImages
        return Plan(pastesText: hasStrings || !attaches, attachesImages: attaches)
    }

    /// How a pasted image item is read.
    enum ImageSource: Equatable, Sendable {
        /// an image file (copied in Files): its own bytes and name; HEIC becomes JPEG (as Files)
        case file(type: String)
        /// a picture (Photos, a screenshot, an app): as the camera's photo (JPEG 0.85)
        case picture
    }

    static let pngType = "public.png"
    static let jpegType = "public.jpeg"
    static let heicType = "public.heic"
    static let heifType = "public.heif"
    private static let fileTypes = [pngType, jpegType, heicType, heifType]

    /// An item with a file name and a PNG / JPEG / HEIC representation is a file (the first of
    /// those in the item's own order); anything else is a picture.
    static func source(types: [String], suggestedName: String?) -> ImageSource {
        let named = !(suggestedName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard named, let type = types.first(where: { fileTypes.contains($0) }) else { return .picture }
        return .file(type: type)
    }

    /// A pasted file's name with its type's extension (kept when it already has one).
    static func fileName(_ suggested: String?, type: String) -> String {
        let base = (suggested ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = base.isEmpty ? "Image" : base
        let ext = (name as NSString).pathExtension.lowercased()
        let wanted: [String] = switch type {
        case pngType: ["png"]
        case jpegType: ["jpg", "jpeg"]
        case heicType: ["heic"]
        default: ["heif", "heic"]
        }
        return wanted.contains(ext) ? name : name + "." + wanted[0]
    }

    /// The MIME type a pasted file is sent with (HEIC / HEIF are turned into JPEG first).
    static func mime(type: String) -> String {
        switch type {
        case pngType: "image/png"
        case jpegType: "image/jpeg"
        case heicType: "image/heic"
        default: "image/heif"
        }
    }
}

/// The quote chip's excerpt (M8 contract §2): one line of plain text, at most 160 characters.
enum ReplyExcerpt {
    static let limit = 160

    static func make(_ plain: String) -> String {
        let flat = plain.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard flat.count > limit else { return flat }
        return String(flat.prefix(limit - 1)) + "…"
    }
}
