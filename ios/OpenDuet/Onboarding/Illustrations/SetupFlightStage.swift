// Page 2's stage (prompt L23, M29): the mascot is the subject, centred; small app pills come in
// from the screen's left edge along a dotted grey arc that bulges upward and drop into it. Its
// eyes follow the pill in the air, it squints happily (and gives a little squash) as each one
// lands, and after the last one the green check badge springs onto its shoulder. Once it all
// stops the still mascot hands over to the breathing one (the same first frame).
import SwiftUI

struct SetupFlightStage: View {
    var chips: [OnboardingInfo.Chip]
    var timeline: SetupTimeline
    var t: Double
    var reduceMotion: Bool

    /// The mascot's circle; the stage is a little taller for its frame and the arc above it.
    static let mascot: CGFloat = 64
    static let height: CGFloat = 96
    /// The circle's centre from the stage's top.
    private static let centerY: CGFloat = 50
    /// Where the arc starts: just outside the screen's left edge (the view sits inside the page's
    /// side margins), a little below the mascot's centre.
    private static let startX: CGFloat = -OnboardingTheme.sideMargin - 6
    private static let startDY: CGFloat = 10
    /// How far the arc's control point rises above the start (apex about 8 pt from the top).
    static let lift: CGFloat = 92
    /// Pills wider than this truncate their label.
    private static let pillWidth: CGFloat = 124

    var body: some View {
        GeometryReader { geo in
            let to = CGPoint(x: geo.size.width / 2, y: Self.centerY)
            let from = CGPoint(x: Self.startX, y: Self.centerY + Self.startDY)
            ZStack {
                SetupArc(from: from, to: to, lift: Self.lift)
                    .stroke(OnboardingTheme.grey.opacity(0.55), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [0.1, 6]))
                ForEach(chips.indices, id: \.self) { i in
                    if let pill = timeline.pill(i, at: t, reduceMotion: reduceMotion) {
                        IllustrationChip(text: Text(chips[i].label), fontSize: 12, height: 26, iconSize: 12) {
                            SetupChipIcon(chip: chips[i], size: 12)
                        }
                        .frame(width: Self.pillWidth)
                        .scaleEffect(pill.scale)
                        .opacity(pill.opacity)
                        .position(SetupArc.point(from: from, to: to, lift: Self.lift, at: pill.along))
                    }
                }
                mascot(from: from, to: to).position(to)
            }
        }
        .frame(height: Self.height)
    }

    private func mascot(from: CGPoint, to: CGPoint) -> some View {
        let r = Self.mascot / 2
        let badge = timeline.badge(at: t, reduceMotion: reduceMotion)
        return Group {
            if t >= timeline.finishTime {
                DuetMascot(pose: .idle, size: Self.mascot, animated: true)
            } else {
                MascotStill(face: face(from: from, to: to), size: Self.mascot)
            }
        }
        .overlay {
            CheckBadge(size: 22)
                .scaleEffect(badge.scale)
                .opacity(badge.opacity)
                .offset(x: r * 0.74, y: -r * 0.74)
        }
    }

    /// The mascot at `t`: eyes on the pill in the air (a quick saccade to each new one), the happy
    /// squint as they land. Reduce Motion: no tracking, the squint once at the end.
    private func face(from: CGPoint, to: CGPoint) -> MascotFace {
        let happy = timeline.happiness(at: t, pulses: !reduceMotion)
        var f = MascotFace.lerp(.neutral, .happy, happy)
        guard !reduceMotion else { return f }
        if let i = timeline.lead(at: t) {
            let pill = timeline.pill(i, at: t, reduceMotion: false)
            let at = SetupArc.point(from: from, to: to, lift: Self.lift, at: pill?.along ?? 0)
            let dx = Double(at.x - to.x), dy = Double(at.y - to.y)
            let near = MascotCurve.ramp(t, timeline.launch(i) - 0.15, 0.08)
            f.yaw += (1 - happy) * near * MascotCurve.clamp(dx / 4, -30, 30)
            f.pitch += (1 - happy) * near * MascotCurve.clamp(dy / 3, -20, 14)
            f.tilt += near * MascotCurve.clamp(dx / 30, -4, 4)
        }
        f.squash += 0.06 * timeline.gulp(at: t)
        return f
    }
}

/// A quadratic curve between two points whose control point rises `lift` above the higher one.
struct SetupArc: Shape {
    var from: CGPoint
    var to: CGPoint
    var lift: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: from)
        path.addQuadCurve(to: to, control: Self.control(from, to, lift))
        return path
    }

    static func control(_ a: CGPoint, _ b: CGPoint, _ lift: CGFloat) -> CGPoint {
        CGPoint(x: (a.x + b.x) / 2, y: min(a.y, b.y) - lift)
    }

    /// The point at fraction `along` (0...1) of the curve.
    static func point(from a: CGPoint, to b: CGPoint, lift: CGFloat, at along: Double) -> CGPoint {
        let c = control(a, b, lift)
        let t = CGFloat(along), u = 1 - CGFloat(along)
        return CGPoint(
            x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
            y: u * u * a.y + 2 * u * t * c.y + t * t * b.y
        )
    }
}
