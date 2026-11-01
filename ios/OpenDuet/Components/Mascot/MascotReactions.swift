// The mascot's one-shot reactions (M29), laid over whatever its state is doing: each blends the
// eyes and body towards its key pose (done, error, needsYou, blink) with anticipation before the
// main move and follow-through after it, then hands back to the state by its `duration`. Also
// the 0.5 s morph between states, in which the eyes arrive first and the body after them.
import Foundation

extension MascotMotion {
    /// `base` (the state's current frame) with `reaction` at `t` seconds since it fired.
    static func react(_ reaction: MascotReaction, base: MascotFace, t: Double, energy e: Double) -> MascotFace {
        guard t >= 0, t < reaction.duration else { return base }
        switch reaction {
        case .done: return done(base, t, e)
        case .error: return error(base, t, e)
        case .needsYou: return needsYou(base, t, e)
        case .tap: return tap(base, t, e)
        }
    }

    /// Reduce Motion: the reaction's face eases in and out in place (no hop, lean or wobble).
    static func reactStill(_ reaction: MascotReaction, base: MascotFace, t: Double) -> MascotFace {
        guard t >= 0, t < reaction.duration else { return base }
        let key: MascotFace
        switch reaction {
        case .done: key = .happy
        case .error: key = MascotFace(pitch: 9, spread: 0.92, eyeHeight: 0.74, eyeTilt: 16)
        case .needsYou: key = MascotFace(pitch: -2.6, spread: 1.09, eyeWidth: 1.25, eyeHeight: 1.28)
        case .tap: key = MascotFace(open: 0)
        }
        let w = C.ramp(t, 0, 0.18) * (1 - C.ramp(t, reaction.duration - 0.25, 0.25))
        var target = key
        target.tilt = base.tilt; target.squash = base.squash; target.hop = base.hop; target.scale = base.scale
        return MascotFace.lerp(base, target, w)
    }

    /// Happy arcs and one hop: a squat (the arcs form), a stretched take-off, the top of the arc
    /// (the `done` key pose), a squash on landing with a small bounce and a happy wiggle.
    private static func done(_ base: MascotFace, _ t: Double, _ e: Double) -> MascotFace {
        var f = mixEyes(base, .happy, C.ramp(t, 0, 0.12) * (1 - C.ramp(t, 1.0, 0.25)))
        let body = C.ramp(t, 0, 0.06) * (1 - C.ramp(t, 1.05, 0.2))
        let jump = happyHop(t - 0.02, height: MascotFace.done.hop * (0.55 + 0.45 * e), energy: e)
        f.hop = base.hop + (jump.hop - base.hop) * body
        f.squash = base.squash + (jump.squash - base.squash) * body
        f.tilt = base.tilt + (jump.tilt - base.tilt) * body
        return f
    }

    /// One happy hop from the floor at `t` = 0 (also the celebration page's): body values only.
    static func happyHop(_ t: Double, height: Double, energy e: Double) -> (hop: Double, squash: Double, tilt: Double) {
        let squat = 0.14, air = 0.38
        if t < 0 { return (0, 0, 0) }
        if t < squat {
            return (0, 0.1 * e * C.smooth(t / squat), 0)
        }
        if t < squat + air {
            // Out of the squat into a stretch within the first 12 % of the flight, round again by 60 %.
            let s = (t - squat) / air
            let release = C.smooth(s / 0.12)
            let stretch = -0.08 * e * (1 - C.smooth((s - 0.12) / 0.48))
            return (height * 4 * s * (1 - s), 0.1 * e * (1 - release) + stretch * release, 0)
        }
        let u = t - squat - air
        let impact = 0.11 * e * min(u / 0.03, 1) * exp(-u / 0.12) * cos(max(u - 0.03, 0) * 20)
        let wiggle = 5 * e * exp(-u / 0.22) * sin(u * 17)
        return (0, impact, wiggle)
    }

    /// Startled for a moment, then the eyes droop short and tilted and the body slumps (a little
    /// past, then settles), a small sigh, and back.
    private static func error(_ base: MascotFace, _ t: Double, _ e: Double) -> MascotFace {
        let startle = MascotFace(eyeWidth: 1.05, eyeHeight: 1.18)
        var f = mixEyes(base, startle, C.ramp(t, 0, 0.06) * (1 - C.ramp(t, 0.1, 0.12)))
        f = mixEyes(f, .error, C.ramp(t, 0.12, 0.22) * (1 - C.ramp(t, 1.15, 0.3)))
        let body = 1 - C.ramp(t, 1.15, 0.33)
        let slump = C.track(t, [
            (0, 0, .linear), (0.08, -0.05, .easeOut), (0.16, 0, .smooth), (0.4, 0.12, .easeOut),
            (0.56, 0.075, .smooth), (0.68, 0.085, .smooth), (0.9, 0.08, .smooth), (1.0, 0.1, .smooth), (1.12, 0.08, .smooth),
        ]) * e
        let lean = C.track(t, [(0, 0, .linear), (0.14, 0, .linear), (0.42, -5, .easeOut), (0.6, -4, .smooth)]) * e
        let sink = C.track(t, [(0, 0, .linear), (0.08, 0.02, .easeOut), (0.16, 0, .smooth)])
        f.squash = base.squash + (slump - base.squash) * body
        f.tilt = base.tilt + (lean - base.tilt) * body
        f.hop = base.hop * (1 - body) + sink * body
        f.open = min(f.open, C.blinkOpen(t, 1.25))
        return f
    }

    /// Snaps round to look straight at you, eyes wide, and leans in twice (a small pull back
    /// before each, a little past each time), then settles back.
    private static func needsYou(_ base: MascotFace, _ t: Double, _ e: Double) -> MascotFace {
        var f = mixEyes(base, .needsYou, C.snap(t, 0, 0.09) * (1 - C.ramp(t, 1.05, 0.3)))
        let body = 1 - C.ramp(t, 1.05, 0.3)
        let lean = C.track(t, [
            (0, 1, .linear), (0.1, 0.985, .smooth), (0.24, 1.075, .easeOut), (0.36, 1.035, .smooth),
            (0.46, 0.995, .smooth), (0.6, 1.075, .easeOut), (0.74, 1.05, .smooth),
        ])
        let squash = C.track(t, [
            (0, 0, .linear), (0.1, 0.05, .smooth), (0.2, -0.04, .easeOut), (0.32, 0, .smooth),
            (0.46, 0.045, .smooth), (0.56, -0.04, .easeOut), (0.7, 0, .smooth),
        ])
        f.scale = 1 + (lean - 1) * (0.5 + 0.5 * e) * body + (base.scale - 1) * (1 - body)
        f.squash = base.squash + (squash * e - base.squash) * body
        f.tilt = base.tilt * (1 - body)
        f.hop = base.hop * (1 - body)
        f.open = min(f.open, C.blinkOpen(t, 0.95))
        return f
    }

    /// A blink and a jelly wobble: squashed by the tap, then wider / taller / wider, dying away,
    /// with a little sideways rock.
    private static func tap(_ base: MascotFace, _ t: Double, _ e: Double) -> MascotFace {
        var f = base
        f.open = min(base.open, C.blinkOpen(t, 0))
        let press = min(t / 0.04, 1)
        let decay = exp(-t / 0.16) * (1 - C.ramp(t, 0.45, 0.15))
        f.squash += 0.1 * e * press * decay * cos(max(t - 0.04, 0) * 34)
        f.tilt += 3 * e * decay * sin(t * 26)
        return f
    }

    /// `base` with its eye parameters moved `w` of the way to `key`'s (the body stays).
    private static func mixEyes(_ base: MascotFace, _ key: MascotFace, _ w: Double) -> MascotFace {
        guard w > 0 else { return base }
        var target = key
        target.tilt = base.tilt; target.squash = base.squash; target.hop = base.hop; target.scale = base.scale
        return MascotFace.lerp(base, target, w)
    }

    // MARK: - Morph

    static let morphDuration = 0.5

    /// From `a` to `b` at `p` (0...1 over the morph): the eyes get there in the first 60 % with
    /// a slight overshoot, the body eases over the whole morph. `plain` (Reduce Motion): together.
    static func morph(_ a: MascotFace, _ b: MascotFace, _ p: Double, plain: Bool = false) -> MascotFace {
        if plain { return MascotFace.lerp(a, b, C.smooth(p)) }
        let eyes = MascotFace.lerp(a, b, C.backOut(p / 0.6, overshoot: 0.9))
        var f = MascotFace.lerp(a, b, C.smooth(p))
        f.yaw = eyes.yaw; f.pitch = eyes.pitch; f.spread = eyes.spread
        f.eyeWidth = max(eyes.eyeWidth, 0.2); f.eyeHeight = max(eyes.eyeHeight, 0.2)
        f.bend = max(eyes.bend, 0); f.eyeTilt = eyes.eyeTilt; f.skew = eyes.skew
        return f
    }
}
