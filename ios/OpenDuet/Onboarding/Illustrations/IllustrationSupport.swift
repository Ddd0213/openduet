// Shared pieces of the onboarding illustrations (prompt L21, L23, L25): the white icon + text
// capsule and the small timing helpers the TimelineView-driven pages use. Every illustration
// computes its frame from the time since it appeared, so each visit starts from zero.
import SwiftUI

/// A white capsule with an icon on the left and one line of text (page 1's task chips, page
/// 2's flying pills and list chips). Text that doesn't fit truncates instead of clipping.
struct IllustrationChip<Icon: View>: View {
    var text: Text
    var fontSize: CGFloat
    var height: CGFloat
    var iconSize: CGFloat
    @ViewBuilder var icon: Icon

    var body: some View {
        HStack(spacing: iconSize * 0.45) {
            icon.frame(width: iconSize, height: iconSize)
            text
                .font(.system(size: fontSize))
                .foregroundStyle(OnboardingTheme.ink)
                .lineLimit(1)
        }
        .padding(.horizontal, height * 0.36)
        .frame(height: height)
        .onboardingCapsule()
    }
}

/// Pure timing curves; `t` is seconds since the illustration appeared.
enum IllustrationTiming {
    /// 0 before `start`, 1 after `start + duration`, linear in between.
    static func progress(_ t: Double, from start: Double, over duration: Double) -> Double {
        guard duration > 0 else { return t >= start ? 1 : 0 }
        return min(max((t - start) / duration, 0), 1)
    }

    static func easeInOut(_ p: Double) -> Double { p * p * (3 - 2 * p) }

    static func easeOut(_ p: Double) -> Double { 1 - (1 - p) * (1 - p) }

    static func lerp(_ a: CGPoint, _ b: CGPoint, _ p: Double) -> CGPoint {
        CGPoint(x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p)
    }

    /// A spring from `from` to 1 that starts at `start` (pops and badges).
    static func spring(_ t: Double, start: Double, from: Double, response: Double, dampingRatio: Double) -> Double {
        guard t > start else { return from }
        let spring = Spring(response: response, dampingRatio: dampingRatio)
        return from + spring.value(target: 1 - from, time: t - start)
    }
}

#Preview {
    VStack(spacing: 12) {
        IllustrationChip(text: Text("Drafted a reply"), fontSize: 13, height: 28, iconSize: 14) { GmailMark() }
        IllustrationChip(text: Text(verbatim: "Gmail"), fontSize: 12, height: 26, iconSize: 12) { GmailMark() }
        IllustrationChip(text: Text(verbatim: "Calendar"), fontSize: 14, height: 32, iconSize: 14) { CalendarMark() }
    }
    .padding()
    .background(OnboardingTheme.background)
}
