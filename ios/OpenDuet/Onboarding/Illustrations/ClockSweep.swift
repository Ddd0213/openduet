// Page 1's clock as pure functions of time (prompt L21): the hand angle, which rim dot was
// passed last, the chip fades and the halo pulses (the Canvas drawing is in ClockDrawing.swift).
// Angles are clock degrees: 0 = 12 o'clock, increasing clockwise.
import SwiftUI

enum ClockSweep {
    static let diameter: CGFloat = 290
    static let radius: CGFloat = diameter / 2
    /// The Canvas is wider than the dial so the rim dots and halos are never clipped.
    static let canvas: CGFloat = 350
    static let degreesPerSecond = 40.0
    static let startAngle = 20.0
    static let period = 360 / degreesPerSecond
    static let dots: [Double] = [32, 122, 227, 300]
    /// Each chip's centre relative to the dial centre (y down): above-right, right-below,
    /// below-left, above-left. Placed clear of the ticks, the centre dot and the moon/sun, and
    /// so that neighbours don't overlap while they crossfade.
    static let chipOffsets: [CGSize] = [
        CGSize(width: 32, height: -54),
        CGSize(width: 48, height: 44),
        CGSize(width: -30, height: 74),
        CGSize(width: -54, height: -24),
    ]
    static let chipFadeIn = 0.35
    static let chipFadeOut = 0.3
    static let haloDuration = 0.9

    static func handAngle(_ t: Double) -> Double { startAngle + degreesPerSecond * t }

    /// Seconds since the hand last reached each dot (nil before the first pass).
    static func sincePass(_ dot: Int, at t: Double) -> Double? {
        let first = (dots[dot] - startAngle) / degreesPerSecond
        guard t >= first else { return nil }
        return (t - first).truncatingRemainder(dividingBy: period)
    }

    /// Seconds from a dot to the next one along the rim.
    static func gapAfter(_ dot: Int) -> Double {
        let next = dots[(dot + 1) % dots.count]
        let degrees = (next - dots[dot] + 360).truncatingRemainder(dividingBy: 360)
        return degrees / degreesPerSecond
    }

    /// A chip fades in when its dot is reached and fades out as the next dot is reached.
    static func chip(_ dot: Int, at t: Double, reduceMotion: Bool) -> (opacity: Double, scale: Double) {
        guard let s = sincePass(dot, at: t) else { return (0, 0.9) }
        let gap = gapAfter(dot)
        if s < gap {
            let p = IllustrationTiming.easeOut(IllustrationTiming.progress(s, from: 0, over: chipFadeIn))
            return (p, reduceMotion ? 1 : 0.9 + 0.1 * p)
        }
        let p = IllustrationTiming.progress(s, from: gap, over: chipFadeOut)
        return (1 - p, reduceMotion ? 1 : 1 - 0.04 * p)
    }

    /// A soft halo that expands from the dot and fades; with Reduce Motion it only fades.
    static func halo(_ dot: Int, at t: Double, reduceMotion: Bool) -> (radius: CGFloat, opacity: Double)? {
        guard let s = sincePass(dot, at: t), s < haloDuration else { return nil }
        let p = s / haloDuration
        if reduceMotion { return (13, 0.3 * (1 - p)) }
        return (6 + 16 * CGFloat(IllustrationTiming.easeOut(p)), 0.4 * (1 - p))
    }

    /// The dot itself swells a little as the hand passes (not with Reduce Motion).
    static func dotScale(_ dot: Int, at t: Double, reduceMotion: Bool) -> CGFloat {
        guard !reduceMotion, let s = sincePass(dot, at: t), s < 0.35 else { return 1 }
        return 1 + 0.25 * CGFloat(sin(.pi * s / 0.35))
    }

    static func point(_ center: CGPoint, _ degrees: Double, _ r: CGFloat) -> CGPoint {
        let a = degrees * .pi / 180
        return CGPoint(x: center.x + r * CGFloat(sin(a)), y: center.y - r * CGFloat(cos(a)))
    }
}
