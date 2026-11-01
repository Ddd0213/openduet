// One onboarding page's text and illustration (prompt L19): the title in the heavy serif,
// the body 8 pt below it, the illustration in the flexible space, then the small footer.
// The flow swaps this view (keyed by page) so the illustration restarts on every visit.
import SwiftUI

struct OnboardingPageView: View {
    let page: OnboardingPage
    var chips: [OnboardingInfo.Chip] = []
    var slackConnected = false
    /// Page 5: the connection or its OAuth page is in progress (the "+" shows a small spinner).
    var slackConnecting = false
    var onConnectSlack: () -> Void = {}

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if page == .proactive {
                Text("Research preview")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(OnboardingTheme.body)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(OnboardingTheme.pillFill))
                    .padding(.bottom, 14)
            }
            OnboardingText(page.title, font: OnboardingTheme.title, color: OnboardingTheme.ink, maxLines: 2)
                .tracking(OnboardingTheme.titleTracking)
                .accessibilityAddTraits(.isHeader)
            OnboardingText(page.body, font: OnboardingTheme.bodyFont, color: OnboardingTheme.body, lineSpacing: OnboardingTheme.bodyLineSpacing)
                .padding(.top, 8)
            illustration
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if let footer = page.footer {
                OnboardingText(footer.text, font: .system(size: footer.size), color: OnboardingTheme.grey)
                    .padding(.bottom, 14)
            }
        }
        .padding(.horizontal, OnboardingTheme.sideMargin)
    }

    @ViewBuilder private var illustration: some View {
        switch page {
        case .proactive: ClockIllustration()
        case .setup: SetupIllustration(chips: chips)
        // L25 and L27 put these cards 16 pt from the screen edges.
        case .web: BrowserIllustration().padding(.horizontal, 16 - OnboardingTheme.sideMargin)
        case .safety: SafetyIllustration().padding(.horizontal, 16 - OnboardingTheme.sideMargin)
        case .connect:
            VStack {
                SlackConnectRow(isConnected: slackConnected, onConnect: onConnectSlack)
                    .overlay(alignment: .trailing) {
                        if slackConnecting && !slackConnected {
                            SlackConnectingBadge()
                                .padding(.trailing, 8)
                                .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                        }
                    }
                    .animation(.easeInOut(duration: 0.2), value: slackConnecting && !slackConnected)
                    .accessibilityValue(slackConnecting && !slackConnected ? Text("Connecting") : Text(verbatim: ""))
                    .padding(.top, 28)
                Spacer(minLength: 0)
            }
        case .notify: NotifyIllustration()
        }
    }
}

/// Centred onboarding text. Strings with PART A's "\n" keep exactly those lines (shrinking a
/// little on narrow phones instead of re-wrapping); other strings, Chinese included, wrap.
struct OnboardingText: View {
    let text: String
    let font: Font
    let color: Color
    var lineSpacing: CGFloat = 0
    var maxLines: Int?

    init(_ text: String, font: Font, color: Color, lineSpacing: CGFloat = 0, maxLines: Int? = nil) {
        self.text = text
        self.font = font
        self.color = color
        self.lineSpacing = lineSpacing
        self.maxLines = maxLines
    }

    var body: some View {
        let fixedLines = text.contains("\n") ? text.split(separator: "\n").count : nil
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .lineSpacing(lineSpacing)
            .multilineTextAlignment(.center)
            .lineLimit(fixedLines ?? maxLines)
            .minimumScaleFactor(fixedLines != nil || maxLines != nil ? 0.85 : 1)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
    }
}
