// The soft pulse of loading skeletons (prompt L184); static with Reduce Motion.
import SwiftUI

struct SkeletonPulse: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    func body(content: Content) -> some View {
        content
            .opacity(reduceMotion ? 0.8 : (dim ? 0.45 : 1))
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: dim)
            .onAppear { dim = true }
    }
}

extension View {
    func skeletonPulse() -> some View { modifier(SkeletonPulse()) }
}

/// A red count badge with white text (#C34929, prompt L83): unread channels on ≡, tasks that
/// need the user on the Tasks tab.
struct CountBadge: View {
    var count: Int

    var body: some View {
        Text(verbatim: count > 99 ? "99+" : count.formatted())
            .font(.system(size: 11, weight: .bold).monospacedDigit())
            .foregroundStyle(.white)
            .contentTransition(.numericText(value: Double(count)))
            .padding(.horizontal, 5)
            .frame(minWidth: 18, minHeight: 18)
            .background(Capsule().fill(Palette.badge))
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: count)
            .accessibilityHidden(true)
    }
}
