// The composer's text field (prompt L92, L95): a UITextView so the Chinese keyboard's marked
// text works. `text` is the committed text only; while a candidate is being composed nothing is
// pushed back into the view, and Return there commits the candidate (the system's own handling).
// Return otherwise inserts a new line (sending is the ↑ circle), as in Duet / the assistant on iPhone.
// M8: ↑ shows while a candidate is composed too; it commits it through `ComposerTextHandle`
// and sends the whole visible text.
// M29: Paste takes images too (ComposerUITextView, PasteRules): they become attachments the
// way "+" adds them, and the text of the same paste goes into the field as before.
import SwiftUI
import UIKit

/// The composer's way into its text view for ↑ (M8): commit the keyboard's candidate, then read
/// the full visible text. Held by ComposerBar as @State; the view registers itself on creation.
@MainActor
final class ComposerTextHandle {
    weak var view: UITextView?

    /// Commits any marked text (pinyin, etc.) and returns everything the field shows; nil when
    /// the view is gone.
    func commit() -> String? {
        guard let view else { return nil }
        if view.markedTextRange != nil { view.unmarkText() }
        return view.text
    }
}

struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    /// True while the keyboard holds an uncommitted candidate (hides the placeholder).
    @Binding var isComposing: Bool
    var placeholder: LocalizedStringResource
    /// Bumped by a send: clears the view even while it holds marked text.
    var resetToken: Int
    var maxLines = 6
    /// ↑ commits the candidate through this (M8).
    var handle: ComposerTextHandle? = nil
    /// M29: the images of a Paste (nil: this composer takes no attachments; Paste is text only).
    var onPasteImages: (@MainActor ([NSItemProvider]) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ComposerUITextView {
        let view = ComposerUITextView()
        view.onPasteImages = onPasteImages
        handle?.view = view
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17))
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: 0xF2F2F2) : UIColor(hex: 0x141413) }
        view.tintColor = UIColor(hex: 0xC7604A)
        view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.keyboardDismissMode = .interactive
        view.accessibilityLabel = String(localized: placeholder)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.text = text
        return view
    }

    func updateUIView(_ view: ComposerUITextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        view.onPasteImages = onPasteImages
        if coordinator.resetToken != resetToken {
            coordinator.resetToken = resetToken
            view.text = text
            coordinator.lastCommitted = text
        } else if view.markedTextRange == nil, text != coordinator.lastCommitted {
            // An outside change (dictation): show it unless a candidate is being composed.
            view.text = text
            coordinator.lastCommitted = text
        }
        if isFocused, !view.isFirstResponder {
            Task { @MainActor in view.becomeFirstResponder() }
        } else if !isFocused, view.isFirstResponder {
            Task { @MainActor in view.resignFirstResponder() }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: ComposerUITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 240
        let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let lineHeight = view.font?.lineHeight ?? 20
        let maxHeight = lineHeight * CGFloat(maxLines) + view.textContainerInset.top + view.textContainerInset.bottom
        let scrolls = fitting.height > maxHeight
        if view.isScrollEnabled != scrolls { view.isScrollEnabled = scrolls }
        return CGSize(width: width, height: min(fitting.height, maxHeight))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        var lastCommitted: String
        var resetToken: Int

        init(_ parent: ComposerTextView) {
            self.parent = parent
            lastCommitted = parent.text
            resetToken = parent.resetToken
        }

        func textViewDidChange(_ view: UITextView) {
            let composing = view.markedTextRange != nil
            if parent.isComposing != composing { parent.isComposing = composing }
            let committed = Self.committedText(of: view)
            guard committed != lastCommitted else { return }
            lastCommitted = committed
            parent.text = committed
        }

        func textViewDidBeginEditing(_ view: UITextView) {
            if !parent.isFocused { parent.isFocused = true }
        }

        func textViewDidEndEditing(_ view: UITextView) {
            if parent.isFocused { parent.isFocused = false }
        }

        /// The text without the candidate the keyboard is still composing (pinyin, etc.).
        static func committedText(of view: UITextView) -> String {
            guard let marked = view.markedTextRange else { return view.text }
            let start = view.offset(from: view.beginningOfDocument, to: marked.start)
            let end = view.offset(from: view.beginningOfDocument, to: marked.end)
            let text = view.text as NSString
            guard start >= 0, end <= text.length, start <= end else { return view.text }
            return text.replacingCharacters(in: NSRange(location: start, length: end - start), with: "")
        }
    }
}

/// M29: the composer's UITextView, which also pastes images (PasteRules). The menu offers Paste
/// when the pasteboard says it has images (`hasImages` reads no content, so no "Allow Paste"
/// prompt); the images are read only when Paste is chosen, and the text goes in as before.
final class ComposerUITextView: UITextView {
    /// nil: this composer takes no attachments (Paste stays the system's, text only).
    var onPasteImages: (@MainActor ([NSItemProvider]) -> Void)?

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        let offers = super.canPerformAction(action, withSender: sender)
        guard action == #selector(paste(_:)) else { return offers }
        return PasteRules.offersPaste(systemOffers: offers, acceptsImages: isEditable && onPasteImages != nil, hasImages: UIPasteboard.general.hasImages)
    }

    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        let plan = PasteRules.plan(acceptsImages: isEditable && onPasteImages != nil, hasImages: board.hasImages, hasStrings: board.hasStrings)
        if plan.pastesText { super.paste(sender) }
        // The user chose Paste: only now is the pasteboard's content read.
        if plan.attachesImages, let onPasteImages { onPasteImages(board.itemProviders) }
    }
}
