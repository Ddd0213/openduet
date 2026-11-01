// M23 W5: the face of the Up next card above the composer (ComposerSuggestion.swift) and the
// "✓ Started" note the last one leaves for a moment. The card is compact (it sits over the
// thread): the lightbulb tile with the title (2 lines), the why (2 lines), then where it came from
// next to Hide / Start; at large text sizes the source goes on its own line above the buttons.
import Accessibility
import SwiftUI

struct SuggestionCardFace: View {
    var suggestion: Suggestion
    var onHide: () -> Void
    var onStart: () -> Void

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var bodySize: CGFloat = 14
    @ScaledMetric(relativeTo: .footnote) private var sourceSize: CGFloat = 13

    private var source: String? { ComposerSuggestionRules.sourceLine(suggestion) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                DuetIconTile(icon: .lightbulb, size: 32, tint: Palette.accent, accent: Palette.accent)
                VStack(alignment: .leading, spacing: 3) {
                    // The assistant's words (data, not UI copy).
                    Text(verbatim: suggestion.title)
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if !suggestion.body.isEmpty {
                        Text(verbatim: suggestion.body)
                            .font(.system(size: bodySize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    sourceText.lineLimit(1)
                    Spacer(minLength: 8)
                    buttons
                }
                VStack(alignment: .leading, spacing: 8) {
                    sourceText.lineLimit(2)
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        buttons
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var sourceText: some View {
        if let source {
            Text(verbatim: source)
                .font(.system(size: sourceSize))
                .foregroundStyle(Palette.secondaryText)
        }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            CapsuleButton(title: Text("Hide"), style: .outline, fullWidth: false, action: onHide)
                .accessibilityLabel(Text("Hide \(suggestion.title)"))
            CapsuleButton(title: Text("Start"), style: .filled, fullWidth: false, action: onStart)
                .accessibilityLabel(Text("Start \(suggestion.title)"))
        }
        .fixedSize()
    }
}

/// "✓ Started" in the card's place for a moment after the last one was started here (its check
/// draws itself); read out by VoiceOver.
struct StartedNote: View {
    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 15

    var body: some View {
        HStack(spacing: 8) {
            DrawnCheckCircle(size: fontSize + 3, tint: Palette.success)
            Text("Started")
                .font(.system(size: fontSize, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(corner: 14)
        .accessibilityElement(children: .combine)
        .onAppear {
            AccessibilityNotification.Announcement(String(localized: "Started")).post()
        }
    }
}
