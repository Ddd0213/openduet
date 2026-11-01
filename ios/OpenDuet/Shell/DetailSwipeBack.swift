// The task detail's swipe back (L186), M19: it follows the finger from the left edge and closes
// past a third of the width or on a flick; otherwise it springs back. The drag lives here, around
// the detail only, so a drag frame re-runs this modifier and not MainShellView (the thread, the
// Tasks tab, the side menu). The page casts a thin gradient on what it uncovers instead of a
// full-screen shadow.
import SwiftUI

struct DetailSwipeBack: ViewModifier {
    var onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag: CGFloat = 0
    @State private var width: CGFloat = 390

    func body(content: Content) -> some View {
        content
            .background(alignment: .leading) { PushEdgeShadow() }
            .offset(x: drag)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = max($0, 1) }
            .simultaneousGesture(backSwipe)
    }

    private var backSwipe: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                guard value.startLocation.x < 32, value.translation.width > 0,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                drag = reduceMotion ? 0 : value.translation.width
            }
            .onEnded { value in
                guard value.startLocation.x < 32 else { return }
                let closes = PushStackRules.swipeCommits(
                    translation: value.translation.width, projected: value.predictedEndTranslation.width, length: width
                )
                if closes && reduceMotion {
                    // No sliding: the detail crossfades away (its removal transition is .opacity).
                    onClose()
                } else if closes {
                    withAnimation(.easeOut(duration: 0.2)) { drag = width } completion: { onClose() }
                } else {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { drag = 0 }
                }
            }
    }
}
