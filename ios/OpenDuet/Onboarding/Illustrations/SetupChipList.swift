// Page 2's chip list (prompt L23): white 32pt capsules with an icon and 14pt text in centred
// flow rows, 8pt apart. App chips flow together, each channel gets its own row, skill chips
// flow together; the given order is kept. Every chip is laid out from the start (invisible
// until its pill lands) so the rows never reflow while they fill in.
import SwiftUI

struct SetupChipList: View {
    var chips: [OnboardingInfo.Chip]
    var timeline: SetupTimeline
    var t: Double
    var reduceMotion: Bool

    var body: some View {
        CenteredFlowLayout(spacing: 8, lineSpacing: 8) {
            ForEach(chips.indices, id: \.self) { i in
                let pop = timeline.chipPop(i, at: t, reduceMotion: reduceMotion)
                IllustrationChip(text: Text(chips[i].label), fontSize: 14, height: 32, iconSize: 14) {
                    SetupChipIcon(chip: chips[i], size: 14)
                }
                .scaleEffect(pop.scale)
                .opacity(pop.opacity)
                .flowLineBreak(startsRow(i))
            }
        }
    }

    /// A channel always starts a row, and so does the first chip after a change of kind.
    private func startsRow(_ i: Int) -> Bool {
        guard i > 0 else { return false }
        return chips[i].kind == .channel || chips[i].kind != chips[i - 1].kind
    }
}

/// The chip's icon: the app's mark, a speech bubble for a channel, a branch for a skill.
struct SetupChipIcon: View {
    var chip: OnboardingInfo.Chip
    var size: CGFloat

    var body: some View {
        switch chip.kind {
        case .app:
            AppLogo(toolkit: chip.toolkit, name: chip.label, size: size)
        case .channel:
            symbol("bubble.left")
        case .skill:
            symbol("arrow.triangle.branch")
        }
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: size * 0.86, weight: .medium))
            .foregroundStyle(OnboardingTheme.body)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
