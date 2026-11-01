// The Canvas drawing of page 1's dial (prompt L21): the peach wedge trailing the hand, the
// ticks, the hand with its centre dot, and the four rim dots with their halo pulses.
// Verified: a conic gradient starts at 3 o'clock and runs clockwise on screen.
import SwiftUI

extension ClockSweep {
    static let wedgeSpan = 70.0
    static let handLength: CGFloat = 136
    private static let tickDark = Color(hex: 0x333333)
    private static let tickLight = Color(hex: 0xD0D0D0)

    static func draw(in gc: inout GraphicsContext, size: CGSize, t: Double, reduceMotion: Bool) {
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let angle = handAngle(t).truncatingRemainder(dividingBy: 360)
        drawWedge(in: &gc, center: c, head: angle)
        drawTicks(in: &gc, center: c)
        drawHand(in: &gc, center: c, angle: angle)
        drawDots(in: &gc, center: c, t: t, reduceMotion: reduceMotion)
    }

    /// Peach at ~35% near the rim, fading to 0 toward the centre and toward the tail.
    private static func drawWedge(in gc: inout GraphicsContext, center c: CGPoint, head: Double) {
        let tail = head - wedgeSpan
        var sector = Path()
        sector.move(to: c)
        for i in 0...36 {
            sector.addLine(to: point(c, tail + wedgeSpan * Double(i) / 36, radius))
        }
        sector.closeSubpath()

        gc.drawLayer { layer in
            // Angular fade: clear at the tail, full at the hand (eased toward the head). The
            // gradient starts 1° before the tail and is clear at both ends, so its seam is
            // invisible; past the hand the sector clips it.
            let lead = 1.0 / 360, fraction = wedgeSpan / 360
            let peach = OnboardingTheme.peach
            let angular = Gradient(stops: [
                .init(color: peach.opacity(0), location: 0),
                .init(color: peach.opacity(0), location: lead),
                .init(color: peach.opacity(0.1), location: lead + fraction * 0.5),
                .init(color: peach.opacity(0.35), location: lead + fraction),
                .init(color: peach.opacity(0), location: 1),
            ])
            // Clock degrees -> screen degrees (0 = 3 o'clock).
            let start = Angle.degrees(tail - 90 - 1)
            layer.fill(sector, with: .conicGradient(angular, center: c, angle: start))
            // Radial fade: keep the rim, dissolve toward the centre.
            layer.blendMode = .destinationIn
            let radial = Gradient(stops: [
                .init(color: .black.opacity(0), location: 0),
                .init(color: .black.opacity(0.35), location: 0.5),
                .init(color: .black, location: 1),
            ])
            layer.fill(sector, with: .radialGradient(radial, center: c, startRadius: 0, endRadius: radius))
        }
    }

    /// Dark short thick ticks at 12/3/6/9, light thin ticks every 15° between.
    private static func drawTicks(in gc: inout GraphicsContext, center c: CGPoint) {
        for i in 0..<24 {
            let degrees = Double(i) * 15
            let major = i % 6 == 0
            var tick = Path()
            tick.move(to: point(c, degrees, radius - (major ? 20 : 15)))
            tick.addLine(to: point(c, degrees, radius - 9))
            gc.stroke(tick, with: .color(major ? tickDark : tickLight), style: StrokeStyle(lineWidth: major ? 3 : 1, lineCap: .round))
        }
    }

    private static func drawHand(in gc: inout GraphicsContext, center c: CGPoint, angle: Double) {
        var hand = Path()
        hand.move(to: c)
        hand.addLine(to: point(c, angle, handLength))
        gc.stroke(hand, with: .color(OnboardingTheme.accent), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
        gc.fill(Path(ellipseIn: CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8)), with: .color(OnboardingTheme.accent))
    }

    /// 12pt orange dots on the rim, each with a halo while the hand has just passed it.
    private static func drawDots(in gc: inout GraphicsContext, center c: CGPoint, t: Double, reduceMotion: Bool) {
        for (i, degrees) in dots.enumerated() {
            let p = point(c, degrees, radius)
            if let halo = halo(i, at: t, reduceMotion: reduceMotion) {
                let r = halo.radius
                gc.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)), with: .color(OnboardingTheme.accent.opacity(halo.opacity)))
            }
            let r = 6 * dotScale(i, at: t, reduceMotion: reduceMotion)
            gc.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)), with: .color(OnboardingTheme.accent))
        }
    }
}
