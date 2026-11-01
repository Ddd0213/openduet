// Onboarding page 2 (prompt L23, M29): small pills come in one by one from the left edge along a
// dotted arc into the mascot, which follows each with its eyes; as each lands its chip pops into
// the centred list below, and after the last one a green check badge springs onto the mascot's
// shoulder. The chips are the user's real apps, channels and skills from the server (L77);
// labels are shown verbatim.
import SwiftUI

struct SetupIllustration: View {
    var chips: [OnboardingInfo.Chip]

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date.now
    @State private var finished = false
    @State private var listHeight: CGFloat = 0

    /// At most this many chips are shown, so the list never pushes the footer off screen.
    static let maxChips = 12
    /// The mascot's circle sits ~60pt below the body text (L23; its stage starts 18pt above the
    /// circle); it may tighten on short screens.
    private static let preferredTop: CGFloat = 42
    private static let minTop: CGFloat = 20
    /// The list starts 34pt below the circle (the stage ends 14pt below it).
    private static let listGap: CGFloat = 20
    private static let bottomMargin: CGFloat = 12

    private var shown: [OnboardingInfo.Chip] { Array(chips.prefix(Self.maxChips)) }

    var body: some View {
        let visible = shown
        let timeline = SetupTimeline(count: visible.count)
        GeometryReader { geo in
            let layout = fit(height: geo.size.height)
            TimelineView(.animation(paused: finished)) { context in
                let t = finished ? timeline.finishTime : max(context.date.timeIntervalSince(start), 0)
                VStack(spacing: 0) {
                    SetupFlightStage(chips: visible, timeline: timeline, t: t, reduceMotion: reduceMotion)
                    SetupChipList(chips: visible, timeline: timeline, t: t, reduceMotion: reduceMotion)
                        .frame(width: geo.size.width)
                        .fixedSize(horizontal: false, vertical: true)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listHeight = $0 }
                        .scaleEffect(layout.scale, anchor: .top)
                        .frame(height: listHeight * layout.scale, alignment: .top)
                        .padding(.top, Self.listGap)
                }
                .padding(.top, layout.top)
                .frame(width: geo.size.width, alignment: .top)
            }
        }
        .task(id: visible) {
            start = .now
            finished = false
            try? await Task.sleep(for: .seconds(timeline.finishTime))
            if !Task.isCancelled { finished = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Your apps, chats and skills moving into OpenDuet"))
    }

    /// The stage's top inset and the list's scale for the height on offer: the gap above the
    /// mascot shrinks first, then the list scales down (only on very short screens).
    private func fit(height: CGFloat) -> (top: CGFloat, scale: CGFloat) {
        let fixed = SetupFlightStage.height + Self.listGap + Self.bottomMargin
        let spare = height - fixed - listHeight
        let top = min(Self.preferredTop, max(Self.minTop, spare))
        let room = max(height - fixed - top, 0)
        let scale = listHeight > room && listHeight > 0 ? max(room / listHeight, 0.5) : 1
        return (top, scale)
    }
}

// Previews sit inside the page's side margins, like OnboardingPageView places them.
#if DEBUG
#Preview("Fixture chips") {
    SetupIllustration(chips: OnboardingFixtures.setupChips)
        .frame(height: 520)
        .padding(.horizontal, OnboardingTheme.sideMargin)
        .background(OnboardingTheme.background)
}

#Preview("No chips") {
    SetupIllustration(chips: [])
        .frame(height: 300)
        .padding(.horizontal, OnboardingTheme.sideMargin)
        .background(OnboardingTheme.background)
}

#Preview("Many chips, short screen") {
    SetupIllustration(chips: OnboardingFixtures.setupChips + OnboardingFixtures.setupChips)
        .frame(height: 360)
        .padding(.horizontal, OnboardingTheme.sideMargin)
        .background(OnboardingTheme.background)
}
#endif
