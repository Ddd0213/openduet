// The previews inside an approval card (prompt L106-L110, L182), by kind: the email (Gmail M
// tile + "Email", copy and ✎, To / Subject rows, the 17 pt body folding behind "Show more",
// attachment chips), the payment (bold amount, "Expires in 8 min", merchant, description, test
// mode fine print), signature / delete and generic tool cards (labelled rows, never raw JSON;
// long values as markdown, folding like the body). Fields named in `glowing` glow accent orange (L163).
import SwiftUI
import UIKit

struct ApprovalBody: View {
    var approval: Approval
    var glowing: Set<String>
    var now: Date
    /// Pending or failed: the ✎ and copy icons work.
    var interactive: Bool
    var onEdit: () -> Void
    var onOpenFile: (_ fileId: String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            preview
            // M20: any card the server explains (browser clicks, safety-floor tools); M23: the
            // others say it from their own fields while they wait (ApprovalWhyRules).
            if let why = ApprovalWhyRules.why(approval) {
                WhyLine(why: why)
            }
        }
    }

    @ViewBuilder
    private var preview: some View {
        switch approval.preview {
        case .email(let preview):
            EmailPreviewView(preview: preview, glowing: glowing, interactive: interactive, onEdit: onEdit, onOpenFile: onOpenFile)
        case .payment(let preview):
            PaymentPreviewView(preview: preview, expiresAt: approval.status == .pending ? approval.expiresAt : nil, now: now, glowing: glowing)
        case .sign(let preview):
            RowsPreviewView(icon: .signature, kind: Text("Signature request"), app: preview.app, title: preview.title, rows: preview.rows, glowing: glowing, destructive: false)
        case .delete(let preview):
            RowsPreviewView(icon: .delete, kind: Text("Delete"), app: preview.app, title: preview.title, rows: preview.rows, glowing: glowing, destructive: true)
        case .action(let preview):
            ActionPreviewView(preview: preview, glowing: glowing)
        }
    }
}

/// M20: "Why am I asked?" and the reason (the server's, or M23: the card's own), in the payment
/// card's fine-print look.
private struct WhyLine: View {
    var why: ApprovalWhy

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var reasonSize: CGFloat = 14

    private var reasonText: String {
        switch why {
        case .server(let phrase): PhraseText.string(phrase, locale: locale)
        case .derived(let text): text
        }
    }

    var body: some View {
        let reason = reasonText
        if !reason.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                DuetIcon(glyph: .info, size: labelSize + 3, tint: Palette.secondaryText)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Why am I asked?")
                        .font(.system(size: labelSize, weight: .medium))
                    Text(verbatim: reason)
                        .font(.system(size: reasonSize))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .foregroundStyle(Palette.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Email

private struct EmailPreviewView: View {
    var preview: EmailPreview
    var glowing: Set<String>
    var interactive: Bool
    var onEdit: () -> Void
    var onOpenFile: (_ fileId: String) -> Void

    @State private var expanded = false
    @State private var copies = 0
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var rowSize: CGFloat = 15
    @ScaledMetric(relativeTo: .body) private var kindSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var chipSize: CGFloat = 14

    private var isLong: Bool { CardFormat.isLongBody(preview.body) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            VStack(alignment: .leading, spacing: 6) {
                Text("To: \(preview.to.joined(separator: ", "))")
                    .font(.system(size: rowSize))
                    .editGlow(glowing.contains("to"), color: Palette.secondaryText)
                if !preview.cc.isEmpty {
                    Text("Cc: \(preview.cc.joined(separator: ", "))")
                        .font(.system(size: rowSize))
                        .editGlow(glowing.contains("cc"), color: Palette.secondaryText)
                }
                Divider().overlay(Palette.cardBorder)
                Text("Subject: \(preview.subject)")
                    .font(.system(size: rowSize))
                    .editGlow(glowing.contains("subject"), color: Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider().overlay(Palette.cardBorder)
            Text(verbatim: preview.body)
                .font(.system(size: bodySize))
                .lineLimit(expanded || !isLong ? nil : 8)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .editGlow(glowing.contains("body"))
            if isLong {
                Button { expanded.toggle() } label: {
                    if expanded { Text("Show less") } else { Text("Show more") }
                }
                .font(.system(size: rowSize, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
                .buttonStyle(PressableButtonStyle())
            }
            if !preview.attachments.isEmpty {
                LeadingFlowLayout(spacing: 8, lineSpacing: 8) {
                    ForEach(Array(preview.attachments.enumerated()), id: \.offset) { _, file in
                        attachment(file)
                    }
                }
                .editGlow(glowing.contains("attachments"))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: expanded)
        .onChange(of: glowing.contains("body")) { _, glows in if glows { expanded = true } }
        .sensoryFeedback(.impact(weight: .light), trigger: copies)
    }

    private var header: some View {
        HStack(spacing: 10) {
            IconTile(app: preview.app.isEmpty ? "Gmail" : preview.app, size: 30)
            Text("Email")
                .font(.system(size: kindSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
            Spacer(minLength: 8)
            Button {
                UIPasteboard.general.string = preview.subject.isEmpty ? preview.body : preview.subject + "\n\n" + preview.body
                copies += 1
            } label: {
                DuetIcon(glyph: copies > 0 ? .check : .copy, size: 19, tint: Palette.secondaryText)
                    .id(copies > 0)
                    .transition(.opacity)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .animation(.easeInOut(duration: 0.15), value: copies > 0)
            .accessibilityLabel(Text("Copy email"))
            if interactive {
                Button(action: onEdit) {
                    DuetIcon(glyph: .edit, size: 19, tint: Palette.secondaryText)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(Text("Edit email"))
                .accessibilityHint(Text("Tell OpenDuet what to change"))
            }
        }
        .font(.system(size: 16, weight: .regular))
        .foregroundStyle(Palette.secondaryText)
        .buttonStyle(PressableButtonStyle(scale: 0.9))
        .task(id: copies) {
            guard copies > 0 else { return }
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { copies = 0 }
        }
    }

    private func attachment(_ file: EmailPreview.Attachment) -> some View {
        Button { if let id = file.fileId { onOpenFile(id) } } label: {
            HStack(spacing: 6) {
                DuetIcon(FileKind(mime: file.mime, name: file.name).cardIcon, size: chipSize + 2, tint: Palette.accent)
                Text(verbatim: file.name)
                    .font(.system(size: chipSize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Capsule().fill(Palette.tile))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.95))
        .disabled(file.fileId == nil)
        .accessibilityLabel(Text("Attachment: \(file.name)"))
    }
}

// MARK: - Payment

private struct PaymentPreviewView: View {
    var preview: PaymentPreview
    var expiresAt: Date?
    var now: Date
    var glowing: Set<String>

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .largeTitle) private var amountSize: CGFloat = 30
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var expirySize: CGFloat = 14
    @ScaledMetric(relativeTo: .caption) private var fineSize: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: CardFormat.money(minor: preview.amount, currency: preview.currency, locale: locale))
                    .font(.system(size: amountSize, weight: .bold).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .editGlow(glowing.contains("amount") || glowing.contains("currency"))
                Spacer(minLength: 8)
                if let expiresAt, let minutes = CardFormat.minutesLeft(until: expiresAt, now: now) {
                    Text("Expires in \(CardFormat.expiryDuration(minutes: minutes, locale: locale))")
                        .font(.system(size: expirySize).monospacedDigit())
                        .foregroundStyle(minutes <= 2 ? Palette.needsInput : Palette.secondaryText)
                        .contentTransition(.numericText(countsDown: true))
                        .fixedSize()
                }
            }
            Text(verbatim: preview.merchant)
                .font(.system(size: textSize, weight: .semibold))
                .editGlow(glowing.contains("merchant"))
            if !preview.description.isEmpty {
                Text(verbatim: preview.description)
                    .font(.system(size: textSize))
                    .fixedSize(horizontal: false, vertical: true)
                    .editGlow(glowing.contains("description"), color: Palette.secondaryText)
            }
            if preview.testMode {
                Label {
                    Text("Test mode: no real money moves.")
                } icon: {
                    DuetIcon(glyph: .info, size: fineSize + 3, tint: Palette.secondaryText)
                }
                .font(.system(size: fineSize))
                .foregroundStyle(Palette.secondaryText)
                .padding(.top, 4)
            }
        }
    }
}

// MARK: - Signature, delete, generic

private struct RowsPreviewView: View {
    var icon: DuetGlyph
    var kind: Text
    var app: String
    var title: String
    var rows: [DetailRow]
    var glowing: Set<String>
    var destructive: Bool

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .body) private var kindSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var appSize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                DuetIconTile(glyph: icon, size: 30, tint: destructive ? Palette.failure : Palette.primaryText)
                kind
                    .font(.system(size: kindSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                Spacer(minLength: 8)
                if !app.isEmpty {
                    Text(builtInName: app)
                        .font(.system(size: appSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                }
            }
            if !title.isEmpty {
                Text(verbatim: title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .editGlow(glowing.contains("title"))
            }
            DetailRowsView(rows: rows, glowing: glowing)
        }
    }
}

private struct ActionPreviewView: View {
    var preview: ActionPreview
    var glowing: Set<String>

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                // M8: the assistant's computer draws the computer glyph, never the letter fallback.
                if Self.isComputer(preview.app) {
                    DuetIconTile(glyph: .computer, size: 30, tint: Palette.primaryText)
                } else if CardFormat.toolkitSlug(preview.app) != nil {
                    IconTile(app: preview.app, size: 30)
                } else {
                    DuetIconTile(glyph: .action, size: 30)
                }
                // Built-in tools ("Run commands") through the catalog, Composio names as sent.
                Text(builtInName: preview.toolName)
                    .font(.system(size: titleSize, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .editGlow(glowing.contains("toolName"))
                Spacer(minLength: 0)
            }
            if let browser = preview.browser {
                // M20: the site, the button verbatim and how it's pressed stand for the rows.
                BrowserActionView(action: browser)
            } else {
                DetailRowsView(rows: preview.rows, glowing: glowing)
            }
        }
    }

    /// M29: approvals stored under an older name ("Claude's computer", "Open Duet's computer").
    static func isComputer(_ app: String) -> Bool {
        ["OpenDuet's computer", "Open Duet's computer", "Claude's computer"].contains(app)
    }
}

/// M20: a consequential click in the assistant's browser: the site (letter badge as on the sign-in
/// card), "Button: “Place your order”" exactly as the page names it, and how ("Click").
private struct BrowserActionView: View {
    var action: BrowserAction

    @ScaledMetric(relativeTo: .body) private var siteSize: CGFloat = 16
    @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var howSize: CGFloat = 13

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            SiteBadge(domain: action.site)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: action.site)
                    .font(.system(size: siteSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("Button: \u{201C}\(action.button)\u{201D}")
                    .font(.system(size: buttonSize))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                Text(verbatim: ApprovalAlwaysRules.how(action.via))
                    .font(.system(size: howSize))
                    .foregroundStyle(Palette.secondaryText)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Labelled rows: a small grey label over its value, so long values and Chinese never clip.
/// Built-in labels ("Command", "Folder") come from the catalog; a command shows monospaced.
/// Long or multi-line values (a page's content) render as markdown and fold behind "Show more".
struct DetailRowsView: View {
    var rows: [DetailRow]
    var glowing: Set<String>

    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 13
    @ScaledMetric(relativeTo: .body) private var valueSize: CGFloat = 16

    /// Past this many characters a one-line value reads as text, not a field.
    private static let markdownLength = 200

    private static func isMarkdown(_ value: String) -> Bool {
        value.contains("\n") || value.count > markdownLength
    }

    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { Divider().overlay(Palette.cardBorder) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(builtInName: row.label)
                            .font(.system(size: labelSize))
                            .foregroundStyle(Palette.secondaryText)
                        if RunCopy.isCommandLabel(row.label) {
                            CommandBlock(command: row.value)
                                .padding(.top, 4)
                                .editGlow(glowing.contains("rows.\(row.label)"))
                        } else if Self.isMarkdown(row.value) {
                            RowMarkdown(value: row.value, glows: glowing.contains("rows.\(row.label)"))
                                .padding(.top, 2)
                        } else {
                            Text(verbatim: row.value)
                                .font(.system(size: valueSize))
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                                .editGlow(glowing.contains("rows.\(row.label)"))
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// A long or multi-line row value (a page's content) as markdown. Long ones fold like the email
/// body: about 8 lines with a soft fade at the bottom, then "Show more" / "Show less".
private struct RowMarkdown: View {
    var value: String
    var glows: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    /// The text's full height: a value that fits after all doesn't fold.
    @State private var fullHeight: CGFloat?
    /// About 8 lines of 17 pt markdown.
    @ScaledMetric(relativeTo: .body) private var foldHeight: CGFloat = 184
    @ScaledMetric(relativeTo: .subheadline) private var moreSize: CGFloat = 15

    private var isLong: Bool {
        CardFormat.isLongBody(value) && (fullHeight.map { $0 > foldHeight + 1 } ?? true)
    }

    private var folded: Bool { isLong && !expanded }

    /// Springy height; Reduce Motion eases.
    private var foldAnimation: Animation {
        reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.42, dampingFraction: 0.82)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The markdown sets its own text colour, so the glow's accent goes in here.
            MarkdownView(blocks: MarkdownCache.blocks(value), color: glows ? Palette.accent : Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                .frame(height: folded ? foldHeight : nil, alignment: .topLeading)
                .clipped()
                .contentShape(Rectangle())
                .mask { fade }
                .editGlow(glows)
            if isLong {
                Button { withAnimation(foldAnimation) { expanded.toggle() } } label: {
                    if expanded { Text("Show less") } else { Text("Show more") }
                }
                .font(.system(size: moreSize, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
                .buttonStyle(PressableButtonStyle())
            }
        }
        .onChange(of: glows) { _, glows in
            if glows && isLong && !expanded { withAnimation(foldAnimation) { expanded = true } }
        }
    }

    /// Opaque; while folded the last lines fade out.
    private var fade: some View {
        ZStack {
            LinearGradient(stops: [.init(color: .black, location: 0.7), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom)
            Rectangle().fill(.black).opacity(folded ? 0 : 1)
        }
    }
}

/// A shell command (computer_exec): monospaced on the code surface, long lines scroll sideways,
/// at most 6 lines until "Show more".
private struct CommandBlock: View {
    var command: String

    @State private var expanded = false
    @ScaledMetric(relativeTo: .footnote) private var codeSize: CGFloat = 14
    @ScaledMetric(relativeTo: .subheadline) private var moreSize: CGFloat = 14

    static let maxLines = 6

    private var isLong: Bool {
        command.split(separator: "\n", omittingEmptySubsequences: false).count > Self.maxLines
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(verbatim: command)
                    .font(.system(size: codeSize, design: .monospaced))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(expanded || !isLong ? nil : Self.maxLines)
                    .fixedSize(horizontal: true, vertical: true)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.codeSurface))
            if isLong {
                Button { expanded.toggle() } label: {
                    if expanded { Text("Show less") } else { Text("Show more") }
                }
                .font(.system(size: moreSize, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
                .buttonStyle(PressableButtonStyle())
            }
        }
        .animation(.easeInOut(duration: 0.25), value: expanded)
    }
}
