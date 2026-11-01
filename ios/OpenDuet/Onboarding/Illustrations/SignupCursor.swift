// Page 3's pieces around the browser card (prompt L25): the orange "OpenDuet" cursor (an arrow
// pointer with a small orange capsule label just below-right of its tip), the user's white
// 40pt capsule bubble and the assistant's grey #ECECEC reply bubble.
import SwiftUI

/// The cursor; its tip is the view's top-left corner.
struct SignupCursor: View {
    var body: some View {
        ZStack(alignment: .topLeading) {
            CursorArrow()
                .fill(OnboardingTheme.accent)
                .overlay(CursorArrow().stroke(.white, style: StrokeStyle(lineWidth: 1.2, lineJoin: .round)))
                .frame(width: 14, height: 19)
                .shadow(color: .black.opacity(0.18), radius: 1.5, y: 1)
            Text("OpenDuet")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 6)
                .frame(height: 16)
                .background(Capsule().fill(OnboardingTheme.accent))
                .offset(x: 10, y: 17)
        }
        .fixedSize()
    }
}

/// A notched arrowhead whose tip is the rect's top-left corner.
struct CursorArrow: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + h))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.34, y: rect.minY + h * 0.7))
        path.addLine(to: CGPoint(x: rect.minX + w, y: rect.minY + h * 0.66))
        path.closeSubpath()
        return path
    }
}

/// "Sign my team up for the conference": 15pt in a white 40pt capsule.
struct SignupUserBubble: View {
    var body: some View {
        Text("Sign my team up for the conference")
            .font(.system(size: 15))
            .foregroundStyle(OnboardingTheme.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, 16)
            .frame(height: 40)
            .onboardingCapsule()
    }
}

/// The assistant's reply: a left-aligned grey bubble that wraps if it must.
struct SignupReplyBubble: View {
    var body: some View {
        Text("The form's filled in. Take a look before I send it.")
            .font(.system(size: 15))
            .foregroundStyle(OnboardingTheme.ink)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(OnboardingTheme.pillFill))
            .frame(maxWidth: 280, alignment: .leading)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 24) {
        SignupUserBubble()
        SignupCursor()
        SignupReplyBubble()
    }
    .padding()
    .background(OnboardingTheme.background)
}
