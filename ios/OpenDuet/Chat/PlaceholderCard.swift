// The M2 stand-in for cards that later milestones build (task spawn, approvals, suggestions,
// artifacts, live browser, sign-in, skills...) and for kinds from a newer server: a white
// rounded card with the kind's glyph and title, and the message text as an assistant bubble when
// there is one. It never crashes and never hides that something arrived.
import SwiftUI

struct PlaceholderCard: View {
    var message: Message
    var streaming: Bool

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing) {
            if !message.text.isEmpty {
                AssistantBubble(text: message.text, streaming: streaming)
            }
            HStack(alignment: .top, spacing: 12) {
                DuetIcon(glyph: summary.glyph, size: 20, tint: Palette.accent)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Palette.accent.opacity(0.12)))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    if let title = summary.title {
                        title
                            .font(.system(size: titleSize, weight: .semibold))
                            .foregroundStyle(Palette.primaryText)
                            .lineLimit(3)
                    }
                    summary.note
                        .font(Typography.caption)
                        .foregroundStyle(Palette.secondaryText)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: 300, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cardCorner, style: .continuous)
                    .fill(Palette.floatingSurface)
                    .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
            )
            .accessibilityElement(children: .combine)
        }
    }

    private struct Summary {
        var glyph: DuetGlyph
        var title: Text?
        var note: Text
    }

    private var summary: Summary {
        let later = Text("Coming in a later version of the app")
        switch message.content {
        case .taskSpawn(let p): return Summary(glyph: .task, title: Text(verbatim: p.task.title), note: later)
        case .taskSuggestions(let p): return Summary(glyph: .suggestion, title: p.items.first.map { Text(verbatim: $0.title) }, note: later)
        case .proactiveSuggestion(let p): return Summary(glyph: .suggestion, title: Text(verbatim: p.title), note: later)
        case .approval: return Summary(glyph: .approval, title: nil, note: later)
        case .spendRequest(let p): return Summary(glyph: .payment, title: Text(verbatim: p.merchant), note: later)
        case .confirmation(let p): return Summary(glyph: .confirmation, title: Text(verbatim: p.title), note: later)
        case .alert(let p): return Summary(glyph: .warning, title: Text(verbatim: PhraseText.string(p.title)), note: later)
        case .plate(let p): return Summary(glyph: .contents, title: p.items.first.map { Text(verbatim: $0.title) }, note: later)
        case .artifact(let p): return Summary(glyph: .make, title: Text(verbatim: p.artifact.title), note: later)
        case .liveBrowser(let p): return Summary(glyph: .browser, title: Text(verbatim: p.domain), note: later)
        case .signIn(let p): return Summary(glyph: .computer, title: Text(verbatim: p.domain), note: later)
        case .skillProposal(let p): return Summary(glyph: .skill, title: Text(verbatim: p.name), note: later)
        case .form(let p): return Summary(glyph: .task, title: Text(verbatim: p.title), note: later)
        case .card(let p): return Summary(glyph: .artifact, title: Text(verbatim: p.title), note: later)
        case .memoryNote(let p): return Summary(glyph: .memory, title: Text(verbatim: p.text), note: later)
        case .soulProposal(let p): return Summary(glyph: .edit, title: Text(SoulFieldLabel.title(p.field)), note: later)
        case .connectionRequest(let p): return Summary(glyph: .link, title: Text(verbatim: p.name), note: later)
        case .modelError(let p): return Summary(glyph: .warning, title: Text(verbatim: PhraseText.string(p.phrase)), note: later)
        case .soulSetup(let p): return Summary(glyph: .edit, title: p.fields.first.map { Text(SoulFieldLabel.title($0.field)) }, note: later)
        case .unsupported, .text, .file, .image, .quickReplies, .system, .usageLimit, .call:
            return Summary(glyph: .info, title: nil, note: Text("Update OpenDuet to see this message"))
        }
    }
}
