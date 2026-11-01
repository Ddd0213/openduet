// Page 2's schedule (prompt L23, M29) as pure functions of time: a pill comes in from the left
// edge every 0.25s and reaches the mascot 0.7s later, each landing pops its chip into the list,
// and the check badge springs on after the last landing (at 0.6s with no chips). The mascot's
// eyes follow the pill in the air and it squints happily as each one lands.
import Foundation

struct SetupTimeline {
    static let firstLaunch = 0.35
    static let interval = 0.25
    static let flight = 0.7
    static let emptyBadge = 0.6

    var count: Int

    func launch(_ i: Int) -> Double { Self.firstLaunch + Double(i) * Self.interval }
    func landing(_ i: Int) -> Double { launch(i) + Self.flight }
    var badgeTime: Double { count == 0 ? Self.emptyBadge : landing(count - 1) + 0.15 }
    /// Nothing moves after this, so the TimelineView can pause.
    var finishTime: Double { badgeTime + 1.0 }

    /// Pill i in the air: its fraction along the arc, opacity and scale (nil when hidden).
    /// With Reduce Motion the pills don't fly: they crossfade in place at the top of the arc.
    func pill(_ i: Int, at t: Double, reduceMotion: Bool) -> (along: Double, opacity: Double, scale: Double)? {
        if reduceMotion {
            let d = abs(t - (landing(i) - 0.15))
            guard d < Self.interval else { return nil }
            return (0.5, 1 - d / Self.interval, 1)
        }
        let p = (t - launch(i)) / Self.flight
        guard p > 0, p < 1 else { return nil }
        let opacity = min(p / 0.12, (1 - p) / 0.12, 1)
        return (IllustrationTiming.easeInOut(p), opacity, 0.7 + 0.3 * sin(.pi * p))
    }

    /// The landed chip pops 0.85 -> 1.0 on a soft spring that stays below 1.03.
    func chipPop(_ i: Int, at t: Double, reduceMotion: Bool) -> (opacity: Double, scale: Double) {
        let land = landing(i)
        let opacity = IllustrationTiming.progress(t, from: land, over: reduceMotion ? 0.25 : 0.15)
        guard !reduceMotion else { return (opacity, 1) }
        let scale = IllustrationTiming.spring(t, start: land, from: 0.85, response: 0.42, dampingRatio: 0.8)
        return (opacity, min(scale, 1.03))
    }

    /// The 22pt check badge springs onto the mascot's shoulder (with Reduce Motion it fades in).
    func badge(at t: Double, reduceMotion: Bool) -> (opacity: Double, scale: Double) {
        let opacity = IllustrationTiming.progress(t, from: badgeTime, over: reduceMotion ? 0.3 : 0.12)
        guard !reduceMotion else { return (opacity, 1) }
        return (opacity, IllustrationTiming.spring(t, start: badgeTime, from: 0.3, response: 0.4, dampingRatio: 0.6))
    }

    // MARK: - M29: the mascot

    /// The pill the mascot's eyes are on: the oldest still in the air, or the next one from just
    /// before it appears (nil = none left: it looks at you).
    func lead(at t: Double) -> Int? {
        (0..<count).first { t >= launch($0) - 0.15 && t < landing($0) }
    }

    /// The happy squint (0...1): a short one as each pill lands (`pulses`), a full one from the
    /// last landing through the badge, gone again by `finishTime`.
    func happiness(at t: Double, pulses: Bool = true) -> Double {
        var h = 0.0
        if pulses {
            for i in 0..<count { h = max(h, 0.6 * MascotCurve.bump(t, landing(i), rise: 0.06, fall: 0.3)) }
        }
        let last = count == 0 ? Self.emptyBadge - 0.15 : landing(count - 1)
        return max(h, MascotCurve.ramp(t, last, 0.12) * (1 - MascotCurve.ramp(t, finishTime - 0.45, 0.35)))
    }

    /// The little squash as a pill lands in it (0...1).
    func gulp(at t: Double) -> Double {
        (0..<count).reduce(0.0) { max($0, MascotCurve.bump(t, landing($1) - 0.02, rise: 0.05, fall: 0.22)) }
    }
}
