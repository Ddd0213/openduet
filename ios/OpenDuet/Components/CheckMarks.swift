// Check marks: the thick hand-drawn check of the celebration (prompt L17, L31) and the small
// green badge of onboarding page 2 (L23). Animate `progress` 0 -> 1 to draw the stroke. M9: the
// same stroke as the icon set's checks (ArtCheck, Components/Icons), so done marks, checklist
// ticks and the celebration are one hand.
import SwiftUI

/// A slightly uneven marker-style check; stroke it, trimmed to `progress`.
struct HandDrawnCheck: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * w, y: rect.minY + y * h) }
        var p = Path()
        p.move(to: point(ArtCheck.start.x, ArtCheck.start.y))
        p.addQuadCurve(to: point(ArtCheck.elbow.x, ArtCheck.elbow.y), control: point(ArtCheck.elbowControl.x, ArtCheck.elbowControl.y))
        p.addQuadCurve(to: point(ArtCheck.end.x, ArtCheck.end.y), control: point(ArtCheck.endControl.x, ArtCheck.endControl.y))
        return p
    }
}

/// The animated stroke: draws from 0 to `progress` with round caps.
struct CheckStroke: View {
    var progress: CGFloat
    var lineWidth: CGFloat
    var color: Color = OnboardingTheme.ink

    var body: some View {
        HandDrawnCheck()
            .trim(from: 0, to: progress)
            .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
    }
}

/// A green circle with a white check (page 2's badge on the mascot tile).
struct CheckBadge: View {
    var size: CGFloat = 22

    var body: some View {
        Circle()
            .fill(OnboardingTheme.checkGreen)
            .overlay(
                CheckStroke(progress: 1, lineWidth: size * 0.12, color: .white)
                    .padding(size * 0.27)
            )
            .overlay(Circle().strokeBorder(.white, lineWidth: size * 0.08))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

#Preview {
    VStack(spacing: 20) {
        Circle().fill(OnboardingTheme.accent).frame(width: 96, height: 96)
            .overlay(CheckStroke(progress: 1, lineWidth: 9).padding(24))
        CheckBadge()
    }
}
