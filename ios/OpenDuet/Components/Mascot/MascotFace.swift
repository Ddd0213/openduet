// The OpenDuet mascot's face (M29), the one definition every mascot drawing uses: DuetMascot
// (the in-app Canvas), MascotSwoop / LaunchView, and the CoreGraphics scripts Tools/AppIcon and
// Tools/LaunchMascot. An orange-red circle with two vertical rounded-bar eyes; no line, no mouth.
// Expressions only change the parameters of `MascotFace`, so states morph by interpolating them
// (`lerp`) and every drawing is the same character. Change the look here and nowhere else.
//
// Units are circle radii R, origin at the circle's resting centre, y points down. Foundation and
// CoreGraphics only, so the scripts compile it with `xcrun swiftc` next to their main.swift.
import CoreGraphics
import Foundation

struct MascotFace: Equatable, Sendable {
    // Eyes. Their centres sit on a sphere that fills the circle, so yaw and pitch turn the head:
    // the eyes slide over, the far eye narrows, eyes near the rim foreshorten.
    /// Turn in degrees, + looks right. Keep within about ±35.
    var yaw: Double = 0
    /// Nod in degrees, + looks down. Keep within about ±25.
    var pitch: Double = 0
    /// Distance between the eyes, 1 = neutral.
    var spread: Double = 1
    /// Eye size multipliers, 1 = neutral (`Eye.width` × `Eye.height`). The ends stay round: wider
    /// than tall is a horizontal pill, equal is a dot.
    var eyeWidth: Double = 1
    var eyeHeight: Double = 1
    /// Bends a horizontal eye into an upward arc (the happy squint "^"): the middle lifts by this
    /// fraction of the centre line's length. 0 = straight; no effect on a vertical eye.
    var bend: Double = 0
    /// Rotates each eye in degrees, mirrored: + leans the tops towards each other ("/ \", sad).
    var eyeTilt: Double = 0
    /// Raises the right eye and lowers the left by this many R.
    var skew: Double = 0
    /// Eyelids for blinks: 1 = open, 0 = shut (a short line `Eye.shut` thick). Don't blink arcs.
    var open: Double = 1

    // Body.
    /// Tilt of the body and face about the centre in degrees, + = clockwise.
    var tilt: Double = 0
    /// + = wider and shorter, - = taller and narrower (x × (1 + squash), y × (1 - squash)), about
    /// the bottom point, so the mascot stays on its floor.
    var squash: Double = 0
    /// Lift off the floor in R; a soft floor shadow shows while lifted.
    var hop: Double = 0
    /// Uniform scale about the centre, 1 = normal (> 1 leans in).
    var scale: Double = 1

    /// Colours, the same in light and dark mode.
    static let bodyRGB: UInt32 = 0xC7604A
    static let eyeRGB: UInt32 = 0x141413

    /// The neutral eye (the approved sketch: circle r 46, eyes 8 × 18 at x 48 / 72, y 64).
    enum Eye {
        static let width = 8.0 / 46
        static let height = 18.0 / 46
        static let x = 12.0 / 46
        static let y = 4.0 / 46
        /// Thickness of a shut eye.
        static let shut = 3.6 / 46
    }

    /// Everything the presets draw stays inside this box (R units, around the resting centre), so
    /// a frame of 2.4 R × 2.65 R (centre 1.45 R from the top) never clips a hop, squash or shadow.
    static let extent = CGRect(x: -1.2, y: -1.45, width: 2.4, height: 2.65)

    /// Interpolates every parameter. `t` may run past 0...1 for springy overshoot.
    static func lerp(_ a: MascotFace, _ b: MascotFace, _ t: Double) -> MascotFace {
        func mix(_ u: Double, _ v: Double) -> Double { u + (v - u) * t }
        return MascotFace(
            yaw: mix(a.yaw, b.yaw), pitch: mix(a.pitch, b.pitch), spread: mix(a.spread, b.spread),
            eyeWidth: mix(a.eyeWidth, b.eyeWidth), eyeHeight: mix(a.eyeHeight, b.eyeHeight),
            bend: mix(a.bend, b.bend), eyeTilt: mix(a.eyeTilt, b.eyeTilt), skew: mix(a.skew, b.skew),
            open: mix(a.open, b.open), tilt: mix(a.tilt, b.tilt), squash: mix(a.squash, b.squash),
            hop: mix(a.hop, b.hop), scale: mix(a.scale, b.scale)
        )
    }

    /// Eye thickening for small drawings (circle diameter in points): 1 from 24 pt up, about 1.26
    /// at 15 pt, 1.35 at 12 pt and below. Only the short side of an eye gets thicker.
    static func eyeWeight(diameter: Double) -> Double {
        1 + 0.35 * min(max((24 - diameter) / 12, 0), 1)
    }
}

/// Key poses, each the most telling frame of a state or event (the approved sketches). Animation
/// moves around and between them; it doesn't invent other looks.
extension MascotFace {
    /// Idle, and the still face of the launch screen and the app icon.
    static let neutral = MascotFace()
    /// "Thinking it through": looks up right, one eye higher, head tilted.
    static let thinking = MascotFace(yaw: 8, pitch: -11, eyeHeight: 0.78, skew: 0.04, tilt: 8)
    /// "Writing a draft": looks down at the page.
    static let writing = MascotFace(yaw: -4, pitch: 12, eyeHeight: 0.69, squash: 0.03)
    /// The looking-up group (web, memory, email, files, calendar, reading): eyes to one side.
    static let searching = MascotFace(yaw: 17, pitch: -2.7, spread: 0.96, eyeHeight: 0.95, tilt: 5)
    /// "Working on your tasks": eyes narrowed to two horizontal pills.
    static let tasks = MascotFace(pitch: 2.6, eyeWidth: 1.375, eyeHeight: 0.39, squash: 0.07)
    /// "Starting a task": the top of the spring up, eyes wide.
    static let starting = MascotFace(pitch: -5.2, eyeHeight: 1.22, squash: -0.07, hop: 0.087)
    /// The working group (working, in the browser, waking the workspace): looks down at a screen.
    static let working = MascotFace(yaw: 13, pitch: 8.4, eyeHeight: 0.78, tilt: 6)

    /// Done (a task finished, a Make build ready): happy arcs at the top of a hop.
    static let done = MascotFace(eyeWidth: 2.625, eyeHeight: 0.389, bend: 0.536, hop: 0.217)
    /// The happy squint on the floor (onboarding: an app lands; the celebration before its hop).
    static let happy = MascotFace(eyeWidth: 2.625, eyeHeight: 0.389, bend: 0.536)
    /// Needs you (approval, sign-in, connection request): looks straight at you, eyes wide, leans in.
    static let needsYou = MascotFace(pitch: -2.6, spread: 1.09, eyeWidth: 1.25, eyeHeight: 1.28, scale: 1.05)
    /// Error: short drooping eyes, body slumps.
    static let error = MascotFace(pitch: 9, spread: 0.92, eyeHeight: 0.74, eyeTilt: 16, tilt: -4, squash: 0.08)
    /// A blink (and a tap): eyes shut to a short line, a slight squash.
    static let blink = MascotFace(open: 0, squash: 0.04)
}

/// One frame of the mascot as paths in the target's coordinates (y down). Fill `shadow` (black at
/// `shadowAlpha`), then `body` (`bodyRGB`), then `eyes` (`eyeRGB`). SwiftUI: `Path(cgPath)`.
struct MascotDrawing {
    let body: CGPath
    let eyes: CGPath
    /// The floor shadow while hopping (nil on the floor).
    let shadow: CGPath?
    let shadowAlpha: Double
}

extension MascotFace {
    /// The paths of this face for a circle of `radius` resting at `center`. `eyeWeight` thickens
    /// the eyes of small drawings (`MascotFace.eyeWeight(diameter:)`).
    func drawing(center: CGPoint, radius: Double, eyeWeight: Double = 1) -> MascotDrawing {
        let deg = Double.pi / 180
        // Unit space to target: squash about the bottom point, scale and tilt about the centre, hop.
        var unit = CGAffineTransform(translationX: center.x, y: center.y - CGFloat(hop * radius))
            .scaledBy(x: CGFloat(radius), y: CGFloat(radius))
            .rotated(by: CGFloat(tilt * deg))
            .scaledBy(x: CGFloat(scale), y: CGFloat(scale))
            .translatedBy(x: 0, y: 1)
            .scaledBy(x: CGFloat(1 + squash), y: CGFloat(1 - squash))
            .translatedBy(x: 0, y: -1)
        let body = CGPath(ellipseIn: CGRect(x: -1, y: -1, width: 2, height: 2), transform: &unit)

        let eyes = CGMutablePath()
        for side in [-1.0, 1.0] {
            let (spot, shape) = eye(side: side, weight: eyeWeight)
            let place = unit.translatedBy(x: spot.x, y: spot.y).rotated(by: CGFloat(-side * eyeTilt * deg))
            eyes.addPath(shape, transform: place)
        }

        let lift = min(max(hop, 0), 1)
        let alpha = 0.08 * min(lift / 0.06, 1)
        var shadow: CGPath?
        if alpha > 0.002 {
            let rx = (0.59 - 0.33 * lift) * radius, ry = 0.065 * radius
            let ground = CGPoint(x: Double(center.x), y: Double(center.y) + (1 + 4.0 / 46) * radius)
            shadow = CGPath(ellipseIn: CGRect(x: ground.x - rx, y: ground.y - ry, width: 2 * rx, height: 2 * ry), transform: nil)
        }
        return MascotDrawing(body: body, eyes: eyes, shadow: shadow, shadowAlpha: alpha)
    }

    /// Foreshortening of an eye at a point on the unit sphere: across (sideways turn) and along.
    private static func foreshortening(_ x: Double, _ y: Double, _ z: Double) -> (w: Double, h: Double) {
        let rim = max((x * x + z * z).squareRoot(), 1e-6)
        return (max(z, 0.05) / rim, rim)
    }

    /// One eye in unit space: its centre on the face and its shape centred on the origin.
    private func eye(side: Double, weight: Double) -> (CGPoint, CGPath) {
        let deg = Double.pi / 180
        // The eye centre on the sphere, turned by yaw (about y), then pitch (about x).
        let x0 = side * Eye.x * spread, y0 = Eye.y
        let z0 = max(1 - x0 * x0 - y0 * y0, 0).squareRoot()
        let x1 = x0 * cos(yaw * deg) + z0 * sin(yaw * deg)
        let z1 = -x0 * sin(yaw * deg) + z0 * cos(yaw * deg)
        let y2 = y0 * cos(pitch * deg) + z1 * sin(pitch * deg)
        let z2 = -y0 * sin(pitch * deg) + z1 * cos(pitch * deg)
        let neutral = Self.foreshortening(Eye.x, Eye.y, (1 - Eye.x * Eye.x - Eye.y * Eye.y).squareRoot())
        let here = Self.foreshortening(x1, y2, z2)
        var w = max(Eye.width * eyeWidth * here.w / neutral.w, 1e-4)
        var h = max(Eye.height * eyeHeight * here.h / neutral.h, 1e-4)

        let o = min(max(open, 0), 1)
        let shut = min(h, Eye.shut)
        h = shut + (h - shut) * o
        w *= 1 + 0.25 * (1 - o)

        if weight != 1 {
            let thick = min(w, h) * weight
            if w <= h { w = thick; h = max(h, thick) } else { h = thick; w = max(w, thick) }
        }

        let shape: CGPath
        let chord = max(w - h, 0), rise = bend * chord
        if rise > 1e-4 {
            // A round-capped stroke along a quad curve, endpoints and apex centred on the eye.
            let line = CGMutablePath()
            line.move(to: CGPoint(x: -chord / 2, y: rise / 2))
            line.addQuadCurve(to: CGPoint(x: chord / 2, y: rise / 2), control: CGPoint(x: 0, y: -1.5 * rise))
            shape = line.copy(strokingWithWidth: CGFloat(h), lineCap: .round, lineJoin: .round, miterLimit: 10)
        } else {
            let corner = min(w, h) / 2 * 0.999
            shape = CGPath(roundedRect: CGRect(x: -w / 2, y: -h / 2, width: w, height: h),
                           cornerWidth: corner, cornerHeight: corner, transform: nil)
        }
        return (CGPoint(x: x1, y: y2 - side * skew), shape)
    }

    static func color(_ rgb: UInt32, alpha: Double = 1) -> CGColor {
        CGColor(srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
                blue: CGFloat(rgb & 0xFF) / 255, alpha: CGFloat(alpha))
    }
}

extension MascotDrawing {
    /// Fills the frame into a y-down CoreGraphics context (the scripts).
    func fill(in gc: CGContext) {
        if let shadow {
            gc.addPath(shadow)
            gc.setFillColor(gray: 0, alpha: CGFloat(shadowAlpha))
            gc.fillPath()
        }
        gc.addPath(body)
        gc.setFillColor(MascotFace.color(MascotFace.bodyRGB))
        gc.fillPath()
        gc.addPath(eyes)
        gc.setFillColor(MascotFace.color(MascotFace.eyeRGB))
        gc.fillPath()
    }
}
