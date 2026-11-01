// Onboarding page 3 (prompt L25): the user's bubble at 0.4s, the mini browser card at 1.0s,
// the orange "OpenDuet" cursor gliding field to field and typing "Alex Kim", "Product design"
// and "May 12 to 14" (in the current language), the drift to the card's corner, then the grey
// reply. A TimelineView keyed to the moment the page appears drives it.
import SwiftUI

struct BrowserIllustration: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date.now
    @State private var finished = false
    @State private var naturalHeight: CGFloat = 0

    var body: some View {
        let script = SignupScript.localized()
        GeometryReader { geo in
            // Fixed sizes; only shrinks when the page leaves less room than the scene needs.
            let scale = naturalHeight > geo.size.height && naturalHeight > 0 ? max(geo.size.height / naturalHeight, 0.6) : 1
            TimelineView(.animation(paused: finished)) { context in
                let t = finished ? script.finishTime : max(context.date.timeIntervalSince(start), 0)
                BrowserScene(script: script, t: t, reduceMotion: reduceMotion)
                    .frame(width: geo.size.width)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { naturalHeight = $0 }
                    .scaleEffect(scale)
                    .frame(width: geo.size.width, height: geo.size.height)
            }
        }
        .task {
            start = .now
            finished = false
            try? await Task.sleep(for: .seconds(script.finishTime))
            if !Task.isCancelled { finished = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("OpenDuet filling in a sign-up form in its own browser"))
    }
}

/// The bubble, the card and the reply, with the cursor on top. The card spans the width it is
/// given; the page sets the 16pt screen margin (as it does for page 4).
struct BrowserScene: View {
    var script: SignupScript
    var t: Double
    var reduceMotion: Bool

    var body: some View {
        let card = IllustrationTiming.easeOut(IllustrationTiming.progress(t, from: SignupScript.cardIn, over: 0.35))
        VStack(spacing: 14) {
            SignupUserBubble()
                .opacity(IllustrationTiming.progress(t, from: SignupScript.bubbleIn, over: 0.35))
                .frame(maxWidth: .infinity, alignment: .trailing)
            SignupFormCard(script: script, t: t)
                .scaleEffect(reduceMotion ? 1 : 0.94 + 0.06 * card, anchor: .top)
                .opacity(card)
            // Laid out from the start so nothing shifts when it fades in.
            SignupReplyBubble()
                .opacity(IllustrationTiming.progress(t, from: script.replyIn, over: 0.4))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .overlayPreferenceValue(SignupAnchorKey.self) { anchors in
            GeometryReader { proxy in
                cursor(anchors: anchors, proxy: proxy)
            }
        }
    }

    /// The cursor's stops: in from the card's upper right, a point in each field (right of the
    /// typed text), then the card's bottom-right corner.
    @ViewBuilder
    private func cursor(anchors: [SignupAnchor: Anchor<CGRect>], proxy: GeometryProxy) -> some View {
        if let cardAnchor = anchors[.card] {
            let card = proxy[cardAnchor]
            let fields = (0..<script.values.count).compactMap { i in anchors[.field(i)].map { proxy[$0] } }
            let stops = [CGPoint(x: card.maxX - 70, y: card.minY + 46)]
                + fields.map { CGPoint(x: $0.minX + $0.width * 0.62, y: $0.midY - 2) }
                + [CGPoint(x: card.maxX - 64, y: card.maxY - 4)]
            let state = script.cursor(at: t, stops: stops, reduceMotion: reduceMotion)
            SignupCursor()
                .offset(x: state.point.x, y: state.point.y)
                .opacity(state.opacity)
        }
    }
}

#Preview {
    BrowserIllustration()
        .frame(height: 440)
        .padding(.horizontal, 16)
        .background(OnboardingTheme.background)
}
