// The timing curves the mascot's motion is built from (M29): eased ramps, a saccade that snaps
// and overshoots a little, a follow-through that lags behind it (eyes lead, the body follows),
// keyframe tracks, seeded randomness and the blink schedule. Pure functions of time, so a frame
// is the same whenever it is drawn and the motion survives pauses.
import Foundation

enum MascotCurve {
    static func clamp(_ x: Double, _ lo: Double = 0, _ hi: Double = 1) -> Double { min(max(x, lo), hi) }

    static func smooth(_ p: Double) -> Double {
        let p = clamp(p)
        return p * p * (3 - 2 * p)
    }

    /// 0 before `start`, 1 after `start + duration`, smoothstep in between.
    static func ramp(_ t: Double, _ start: Double, _ duration: Double) -> Double {
        duration > 0 ? smooth((t - start) / duration) : (t >= start ? 1 : 0)
    }

    static func easeOut(_ p: Double) -> Double {
        let q = 1 - clamp(p)
        return 1 - q * q * q
    }

    static func easeIn(_ p: Double) -> Double {
        let p = clamp(p)
        return p * p
    }

    /// Ease-out-back: reaches 1 with a small overshoot (about 4 %) before settling.
    static func backOut(_ p: Double, overshoot s: Double = 1.2) -> Double {
        let p = clamp(p) - 1
        return 1 + p * p * ((s + 1) * p + s)
    }

    /// A saccade: 0 -> 1 in `duration` (fast, ~80 ms) starting at `start`, overshooting a touch.
    static func snap(_ t: Double, _ start: Double, _ duration: Double = 0.08) -> Double {
        t <= start ? 0 : backOut((t - start) / duration)
    }

    /// The body following a saccade: starts `lag` later and settles with a soft spring.
    static func follow(_ t: Double, _ start: Double, lag: Double = 0.07, settle: Double = 0.32) -> Double {
        let d = t - start - lag
        guard d > 0 else { return 0 }
        let p = d / settle
        guard p < 3 else { return 1 }
        return 1 - exp(-4.2 * p) * cos(3.2 * p)
    }

    /// A short bump: up over `rise`, back down over `fall` (0 outside).
    static func bump(_ t: Double, _ start: Double, rise: Double, fall: Double) -> Double {
        let d = t - start
        guard d > 0, d < rise + fall else { return 0 }
        return d < rise ? smooth(d / rise) : 1 - smooth((d - rise) / fall)
    }

    enum Ease: Sendable { case smooth, easeIn, easeOut, linear }

    /// A keyframe track: (time, value, ease into it). Holds the first / last value outside.
    static func track(_ t: Double, _ keys: [(Double, Double, Ease)]) -> Double {
        guard let first = keys.first else { return 0 }
        if t <= first.0 { return first.1 }
        for i in 1..<keys.count where t <= keys[i].0 {
            let a = keys[i - 1], b = keys[i]
            let p = (t - a.0) / max(b.0 - a.0, 1e-6)
            let e: Double
            switch b.2 {
            case .smooth: e = smooth(p)
            case .easeIn: e = easeIn(p)
            case .easeOut: e = easeOut(p)
            case .linear: e = clamp(p)
            }
            return a.1 + (b.1 - a.1) * e
        }
        return keys[keys.count - 1].1
    }

    /// A seeded number in 0..<1 for (seed, key, salt): the same every frame, different per mascot.
    static func random(_ seed: UInt64, _ key: Int, _ salt: UInt64 = 0) -> Double {
        var x = seed &+ UInt64(bitPattern: Int64(key)) &* 0x9E37_79B9_7F4A_7C15 &+ salt &* 0xBF58_476D_1CE4_E5B9
        x = (x ^ (x >> 30)) &* 0xBF58_476D_1CE4_E5B9
        x = (x ^ (x >> 27)) &* 0x94D0_49BB_1331_11EB
        x ^= x >> 31
        return Double(x >> 11) / Double(1 << 53)
    }

    /// The window index of `t` for windows of `length` seconds.
    static func window(_ t: Double, _ length: Double) -> (index: Int, local: Double) {
        let index = Int((t / length).rounded(.down))
        return (index, t - Double(index) * length)
    }

    // MARK: - Blinks

    /// One blink at `start`: shut in 60 ms, held 40 ms, open in 80 ms. 1 = open.
    static func blinkOpen(_ t: Double, _ start: Double) -> Double {
        let d = t - start
        guard d > 0, d < 0.18 else { return 1 }
        if d < 0.06 { return 1 - smooth(d / 0.06) }
        if d < 0.1 { return 0 }
        return smooth((d - 0.1) / 0.08)
    }

    /// Random blinks: one in every 4.2 s window at a random spot in its middle (so they come
    /// 2.5 to 6 s apart), about one in five a double blink. `slow` stretches the gaps.
    static func blinks(_ t: Double, seed: UInt64, slow: Double = 1) -> Double {
        let length = 4.2 * slow
        let (k, _) = window(t, length)
        let start = Double(k) * length + length * (0.3 + 0.4 * random(seed, k, 11))
        var open = blinkOpen(t, start)
        if random(seed, k, 12) < 0.2 { open = min(open, blinkOpen(t, start + 0.26)) }
        return open
    }
}
