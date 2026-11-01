// The mascot's continuous motion per state (M29), built around each state's key pose by changing
// MascotFace's parameters over time. Eyes move in saccades (fast snaps with a small overshoot)
// and the body follows a beat later; hops have a squat before and a squash after. `t` is seconds
// since the state began, `energy` (0.55...1) calms the body down for small drawings.
import Foundation

enum MascotMotion {
    typealias C = MascotCurve

    /// How lively the body is at this circle diameter: 1 from 30 pt, about 0.6 at 15 pt.
    static func energy(diameter: Double) -> Double {
        0.55 + 0.45 * C.clamp((diameter - 12) / 18)
    }

    /// The frame of `pose` at `t`.
    static func face(_ pose: MascotPose, t: Double, seed: UInt64, energy e: Double) -> MascotFace {
        switch pose {
        case .idle: idle(t, seed, e)
        case .thinking: thinking(t, seed, e)
        case .searching: searching(t, seed, e)
        case .writing: writing(t, seed, e)
        case .tasks: tasks(t, seed, e)
        case .starting: starting(t, seed, e)
        case .working: working(t, seed, e)
        }
    }

    /// Breathing: a slow squash about the floor (the top rises and sinks, the bottom stays) and a
    /// slower sway. Zero at t = 0, so the first frame is the key pose itself.
    private static func breathe(_ f: inout MascotFace, _ t: Double, _ e: Double, amount: Double = 1) {
        f.squash += 0.026 * e * amount * sin(2 * .pi * t / 3.2)
        f.tilt += 1.6 * e * amount * sin(2 * .pi * t / 7.3)
    }

    // MARK: - States

    /// Breathes, blinks (now and then twice), and every so often glances aside: the eyes snap
    /// over first, the head tilts after them, holds, snaps back (often with a blink).
    private static func idle(_ t: Double, _ seed: UInt64, _ e: Double) -> MascotFace {
        var f = MascotFace.neutral
        breathe(&f, t, e)
        f.open = C.blinks(t, seed: seed)
        let (k, _) = C.window(t, 7)
        guard k > 0, C.random(seed, k, 21) < 0.5 else { return f }
        let start = Double(k) * 7 + 0.5 + 3.5 * C.random(seed, k, 22)
        let hold = 0.9 + 0.7 * C.random(seed, k, 23)
        let side: Double = C.random(seed, k, 24) < 0.5 ? -1 : 1
        let dy = -4 + 8 * C.random(seed, k, 25)
        let eyes = C.snap(t, start) - C.snap(t, start + hold)
        let body = C.follow(t, start) - C.follow(t, start + hold)
        f.yaw += side * 15 * eyes
        f.pitch += dy * eyes
        f.tilt += side * 4 * e * body
        if C.random(seed, k, 26) < 0.55 { f.open = min(f.open, C.blinkOpen(t, start + hold - 0.02)) }
        return f
    }

    /// Looks up right, one eye higher; the head tilts slowly further and back while the eyes wander
    /// between spots up there in small slow saccades. Blinks are slower.
    private static func thinking(_ t: Double, _ seed: UInt64, _ e: Double) -> MascotFace {
        var f = MascotFace.thinking
        breathe(&f, t, e, amount: 0.6)
        f.tilt += 4 * e * sin(2 * .pi * t / 4.6)
        f.skew += 0.018 * sin(2 * .pi * t / 5.9)
        let (k, local) = C.window(t, 1.9)
        func spot(_ i: Int) -> (Double, Double) {
            i < 0 ? (0, 0) : (-4 + 9 * C.random(seed, i, 31), -3 + 6 * C.random(seed, i, 32))
        }
        let a = spot(k - 1), b = spot(k)
        let p = C.snap(local, 0, 0.14)
        f.yaw += a.0 + (b.0 - a.0) * p
        f.pitch += a.1 + (b.1 - a.1) * p
        f.open = C.blinks(t, seed: seed, slow: 1.3)
        return f
    }

    /// Quick scans: right, left, right, then a shorter look straight ahead; the eyes snap, the head
    /// turns after them, and each turn starts with a small squash.
    private static func searching(_ t: Double, _ seed: UInt64, _ e: Double) -> MascotFace {
        var f = MascotFace.searching
        breathe(&f, t, e, amount: 0.7)
        let cycle = 2.6
        let starts = [0.0, 0.62, 1.24, 1.92]
        let yaws = [0.0, -34, 0, -17]
        let tilts = [0.0, -10, 0, -5]
        let (k, local) = C.window(t, cycle)
        // Each turn a little later than its slot (never earlier, so a snap is never cut short).
        func startOf(_ j: Int) -> Double { starts[j] + (j == 0 ? 0 : 0.1 * C.random(seed, k, 41 + UInt64(j))) }
        var i = starts.count - 1
        while i > 0 && local < startOf(i) { i -= 1 }
        let start = startOf(i)
        // Fixations numbered across cycles; before the first one the key pose itself.
        let current = k * starts.count + i, previous = current - 1
        func yaw(_ j: Int) -> Double { j < 0 ? 0 : yaws[j % starts.count] }
        func tilt(_ j: Int) -> Double { j < 0 ? 0 : tilts[j % starts.count] }
        func pitch(_ j: Int) -> Double { j <= 0 ? 0 : -3 + 6 * C.random(seed, j, 45) }
        let p = C.snap(local, start, 0.075), q = C.follow(local, start, lag: 0.06, settle: 0.28)
        f.yaw += yaw(previous) + (yaw(current) - yaw(previous)) * p
        f.pitch += pitch(previous) + (pitch(current) - pitch(previous)) * p
        // The head is still settling from the turn before when the next one starts: both add up.
        let previousStart = i == 0 ? startOf(starts.count - 1) - cycle : startOf(i - 1)
        let settling = C.follow(local, previousStart, lag: 0.06, settle: 0.28)
        f.tilt += (tilt(previous - 1) + (tilt(previous) - tilt(previous - 1)) * settling
            + (tilt(current) - tilt(previous)) * q) * e
        // Each turn's squash leads it a little (the cycle's first starts on it, not across the cycle's start).
        let lead = (0..<starts.count).reduce(0.0) { max($0, C.bump(local, $1 == 0 ? 0 : startOf($1) - 0.03, rise: 0.05, fall: 0.22)) }
        f.squash += 0.035 * e * lead
        f.open = C.blinks(t, seed: seed)
        return f
    }

    /// Reads a line: three small saccades left to right, then a return sweep with a small nod and
    /// a slight squash; every few lines the gaze steps down the page.
    private static func writing(_ t: Double, _ seed: UInt64, _ e: Double) -> MascotFace {
        var f = MascotFace.writing
        breathe(&f, t, e, amount: 0.6)
        let line = 1.75
        let (k, local) = C.window(t, line)
        let hops: [(Double, Double)] = [(0.0, -8), (0.42, -1), (0.86, 6), (1.3, 12)]
        var i = hops.count - 1
        while i > 0 && local < hops[i].0 { i -= 1 }
        let from = i == 0 ? (k == 0 ? 0.0 : hops[hops.count - 1].1) : hops[i - 1].1
        let p = C.snap(local, hops[i].0, i == 0 ? 0.12 : 0.07)
        f.yaw += from + (hops[i].1 - from) * p
        let rows = Double(k % 3)
        let drop = { (r: Double) in r * 2 }
        let fromRow = k == 0 ? 0 : drop(Double((k + 2) % 3))
        f.pitch += fromRow + (drop(rows) - fromRow) * C.snap(local, 0, 0.12)
        let nod = C.bump(local, 0.0, rise: 0.08, fall: 0.25)
        f.pitch += 4 * nod
        f.squash += 0.025 * e * nod
        f.open = C.blinks(t, seed: seed, slow: 1.2)
        return f
    }

    /// Two small hops and a rest, over and over: a squat before each, a stretch on the way up and
    /// a squash with a little bounce on landing. The eyes stay narrowed (no blinks on pills).
    private static func tasks(_ t: Double, _ seed: UInt64, _ e: Double) -> MascotFace {
        var f = MascotFace.tasks
        breathe(&f, t, e, amount: 0.4)
        let (_, local) = C.window(t, 1.5)
        let height = 0.09 * (0.5 + 0.5 * e)
        for start in [0.12, 0.5] {
            let d = local - start
            if d > -0.08 && d < 0 { f.squash += 0.05 * e * C.smooth((d + 0.08) / 0.08) }
            if d >= 0 && d < 0.26 {
                let s = d / 0.26
                f.hop += height * 4 * s * (1 - s)
                f.squash += 0.05 * e * (1 - s) - 0.06 * e * sin(.pi * s)
                f.pitch += -2 * sin(.pi * s)
            }
            if d >= 0.26 && d < 0.6 {
                // Landing: squashes within 30 ms, then a damped bounce.
                let u = d - 0.26
                f.squash += 0.06 * e * min(u / 0.03, 1) * exp(-u / 0.08) * cos(max(u - 0.03, 0) * 25)
            }
        }
        return f
    }

    /// Squats, springs up (stretched, eyes wide, a little past the top), hovers, lands, rests;
    /// the key pose is the top of the spring. Repeats every 1.6 s.
    private static func starting(_ t: Double, _ seed: UInt64, _ e: Double) -> MascotFace {
        var f = MascotFace.starting
        let (_, local) = C.window(t, 1.6)
        let h = (0.5 + 0.5 * e)
        f.hop = h * C.track(local, [
            (0, 0, .linear), (0.24, 0, .linear), (0.42, 0.11, .easeOut),
            (0.58, 0.087, .smooth), (0.74, 0.093, .smooth), (0.92, 0, .easeIn),
        ])
        f.squash = e * C.track(local, [
            (0, 0, .linear), (0.24, 0.11, .smooth), (0.32, -0.09, .easeOut), (0.46, -0.07, .smooth),
            (0.74, -0.05, .smooth), (0.9, -0.02, .easeIn), (0.95, 0.07, .easeOut), (1.12, -0.01, .smooth),
            (1.3, 0, .smooth),
        ])
        f.eyeHeight = C.track(local, [
            (0, 1, .linear), (0.24, 0.8, .smooth), (0.36, 1.26, .easeOut), (0.5, 1.22, .smooth),
            (0.95, 1.22, .linear), (1.1, 1, .smooth),
        ])
        f.pitch = C.track(local, [(0, -2, .linear), (0.24, 2, .smooth), (0.4, -5.2, .easeOut), (1.1, -5.2, .linear), (1.4, -2, .smooth)])
        f.open = C.blinkOpen(local, 1.2)
        return f
    }

    /// Looks down to the side at a screen, eyes hopping from spot to spot on it; every so often
    /// the eyes snap up at you (wider, head straightening after them), hold, and go back down.
    private static func working(_ t: Double, _ seed: UInt64, _ e: Double) -> MascotFace {
        var f = MascotFace.working
        breathe(&f, t, e, amount: 0.6)
        let (k, local) = C.window(t, 0.95)
        func spot(_ i: Int) -> (Double, Double) {
            i < 0 ? (0, 0) : (-5 + 10 * C.random(seed, i, 51), -2 + 4 * C.random(seed, i, 52))
        }
        let a = spot(k - 1), b = spot(k)
        let p = C.snap(local, 0.1 * C.random(seed, k, 53), 0.07)
        f.yaw += a.0 + (b.0 - a.0) * p
        f.pitch += a.1 + (b.1 - a.1) * p
        f.open = C.blinks(t, seed: seed)

        let (g, _) = C.window(t, 6.5)
        guard g > 0, C.random(seed, g, 54) < 0.7 else { return f }
        let start = Double(g) * 6.5 + 1 + 3.4 * C.random(seed, g, 55)
        let hold = 0.75 + 0.5 * C.random(seed, g, 56)
        let eyes = C.snap(t, start, 0.09) - C.snap(t, start + hold, 0.1)
        let body = C.follow(t, start) - C.follow(t, start + hold)
        f.yaw += (0 - f.yaw) * eyes
        f.pitch += (-3 - f.pitch) * eyes
        f.eyeHeight += 0.22 * eyes
        f.tilt += (0 - f.tilt) * body
        f.open = min(f.open, C.blinkOpen(t, start + hold + 0.05))
        return f
    }
}
