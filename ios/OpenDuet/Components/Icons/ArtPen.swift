// The pen the hand-drawn icon set (DuetArt) draws with (M9). Every drawing lives on a 24-unit
// grid and is built from a few deliberate hand-drawn moves: a line with a gentle bow, a rounded
// polyline, a smooth curve through fixed points, a ring that isn't quite a circle, an organic
// blob for the accent, and the mascot's squiggle. Everything is fixed control points: no
// randomness, so an icon is identical on every render. Pure SwiftUI (no UIKit, no app types)
// so the macOS contact-sheet script compiles it as is.
import SwiftUI

/// A point on the 24-unit grid.
typealias GP = (CGFloat, CGFloat)

struct ArtPen {
    private let unit: CGFloat
    private let origin: CGPoint
    /// A rotation (degrees, clockwise on screen) about a grid point for the moves that follow.
    private var turn: (sin: CGFloat, cos: CGFloat, about: GP)?
    private(set) var path = Path()

    /// `shift`: the accent layer's misregistration, in grid units.
    init(rect: CGRect, shift: CGVector = .zero) {
        let s = min(rect.width, rect.height)
        unit = s / ArtStyle.grid
        origin = CGPoint(x: rect.midX - s / 2 + shift.dx * unit, y: rect.midY - s / 2 + shift.dy * unit)
    }

    // MARK: - Coordinates

    private func p(_ g: GP) -> CGPoint {
        var x = g.0, y = g.1
        if let turn {
            let dx = x - turn.about.0, dy = y - turn.about.1
            x = turn.about.0 + dx * turn.cos - dy * turn.sin + nudge.0
            y = turn.about.1 + dx * turn.sin + dy * turn.cos + nudge.1
        }
        return CGPoint(x: origin.x + x * unit, y: origin.y + y * unit)
    }

    private var nudge: GP = (0, 0)

    /// Rotates the moves that follow by `degrees` (clockwise) about `about`, then moves them by
    /// `nudge` grid units (to re-centre a turned drawing); 0 ends it.
    mutating func rotate(_ degrees: CGFloat, about: GP = (12, 12), nudge: GP = (0, 0)) {
        guard degrees != 0 else { turn = nil; self.nudge = (0, 0); return }
        let a = degrees * .pi / 180
        turn = (sin(a), cos(a), about)
        self.nudge = nudge
    }

    // MARK: - Turtle moves

    mutating func move(_ a: GP) { path.move(to: p(a)) }
    mutating func to(_ a: GP) { path.addLine(to: p(a)) }
    mutating func quad(_ a: GP, _ c: GP) { path.addQuadCurve(to: p(a), control: p(c)) }
    mutating func curve(_ a: GP, _ c1: GP, _ c2: GP) { path.addCurve(to: p(a), control1: p(c1), control2: p(c2)) }
    mutating func close() { path.closeSubpath() }

    // MARK: - Strokes

    /// A line from `a` to `b` with a gentle bow (grid units; + bows to the right of travel).
    mutating func line(_ a: GP, _ b: GP, bow: CGFloat = 0) {
        move(a)
        guard bow != 0 else { to(b); return }
        let dx = b.0 - a.0, dy = b.1 - a.1
        let len = max((dx * dx + dy * dy).squareRoot(), 0.001)
        let k = bow * 2 * ArtStyle.bowGain
        quad(b, ((a.0 + b.0) / 2 - dy / len * k, (a.1 + b.1) / 2 + dx / len * k))
    }

    /// A round dot as wide as the line.
    mutating func dot(_ a: GP) {
        move(a)
        to((a.0 + 0.01, a.1))
    }

    /// A polyline whose corners round to `corners` (one radius for all, or one per point).
    mutating func poly(_ pts: [GP], corner: CGFloat = 0, corners: [CGFloat]? = nil, closed: Bool = false) {
        guard pts.count > 1 else { return }
        let n = pts.count
        func radius(_ i: Int) -> CGFloat { (corners.map { $0[i % $0.count] } ?? corner) * unit }
        if closed {
            let start: GP = ((pts[n - 1].0 + pts[0].0) / 2, (pts[n - 1].1 + pts[0].1) / 2)
            move(start)
            for i in 0..<n {
                let r = radius(i)
                if r > 0 {
                    path.addArc(tangent1End: p(pts[i]), tangent2End: p(pts[(i + 1) % n]), radius: r)
                } else {
                    to(pts[i])
                }
            }
            close()
        } else {
            move(pts[0])
            for i in 1..<n - 1 {
                let r = radius(i)
                if r > 0 {
                    path.addArc(tangent1End: p(pts[i]), tangent2End: p(pts[i + 1]), radius: r)
                } else {
                    to(pts[i])
                }
            }
            to(pts[n - 1])
        }
    }

    /// A smooth curve through `pts` (Catmull-Rom as cubic Béziers): the organic line where a
    /// ruler would draw straight segments. `tension` 1 = classic, lower = tighter. `join`
    /// continues the current subpath with a line to the first point instead of lifting the pen.
    mutating func smooth(_ pts: [GP], closed: Bool = false, tension: CGFloat = 1, join: Bool = false) {
        let n = pts.count
        guard n > 1 else { return }
        func at(_ i: Int) -> GP {
            closed ? pts[(i % n + n) % n] : pts[min(max(i, 0), n - 1)]
        }
        if join { to(pts[0]) } else { move(pts[0]) }
        let segments = closed ? n : n - 1
        let k = tension / 6
        for i in 0..<segments {
            let p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
            curve(p2, (p1.0 + (p2.0 - p0.0) * k, p1.1 + (p2.1 - p0.1) * k), (p2.0 - (p3.0 - p1.0) * k, p2.1 - (p3.1 - p1.1) * k))
        }
        if closed { close() }
    }

    /// A hand-drawn ring: an ellipse (radii `rx`, `ry`) with a slow fixed wobble, from `from`
    /// degrees (0 = 3 o'clock, clockwise on screen) through `sweep` degrees. A full ring ends a
    /// touch past where it began, like a pen that overlaps its start.
    mutating func ring(_ c: GP, _ rx: CGFloat, _ ry: CGFloat? = nil, from: CGFloat = -100, sweep: CGFloat = 360, wobble: CGFloat = 0.024, tilt: CGFloat = 0, join: Bool = false) {
        let ry = ry ?? rx
        let full = sweep >= 359
        let count = max(Int((abs(sweep) / 22.5).rounded(.up)), 2)
        let tiltRad = tilt * .pi / 180
        var pts: [GP] = []
        for i in 0...count {
            let f = CGFloat(i) / CGFloat(count)
            let a = (from + sweep * f) * .pi / 180
            // The wobble is a fixed shape (2 and 3 lobes), plus a little drift on full rings.
            var m = 1 + wobble * sin(2 * a + 0.7) + wobble * 0.6 * sin(3 * a + 2.1)
            if full { m += 0.022 * f }
            let x = cos(a) * rx * m, y = sin(a) * ry * m
            pts.append((c.0 + x * cos(tiltRad) - y * sin(tiltRad), c.1 + x * sin(tiltRad) + y * cos(tiltRad)))
        }
        if full {
            // Overlap the start a little past the seam.
            let a = (from + sweep + 9) * .pi / 180
            let m = 1.03 + wobble * sin(2 * a + 0.7)
            let x = cos(a) * rx * m, y = sin(a) * ry * m
            pts.append((c.0 + x * cos(tiltRad) - y * sin(tiltRad), c.1 + x * sin(tiltRad) + y * cos(tiltRad)))
        }
        smooth(pts, tension: 1, join: join)
    }

    /// A rounded box whose sides bow very slightly (one fixed pattern), never a ruler rectangle.
    mutating func box(_ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat, r: CGFloat = 2.6, bows: (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0.22, -0.18, -0.22)) {
        let r = min(r, (x1 - x0) / 2, (y1 - y0) / 2)
        // Clockwise from the top-left corner's end; each side a quad with its own bow.
        move((x0 + r, y0))
        edge((x0 + r, y0), (x1 - r, y0), bows.0)
        quad((x1, y0 + r), (x1, y0))
        edge((x1, y0 + r), (x1, y1 - r), bows.1)
        quad((x1 - r, y1), (x1, y1))
        edge((x1 - r, y1), (x0 + r, y1), bows.2)
        quad((x0, y1 - r), (x0, y1))
        edge((x0, y1 - r), (x0, y0 + r), bows.3)
        quad((x0 + r, y0), (x0, y0))
        close()
    }

    /// Continues the current subpath from `a` to `b` with a bow (see `line`).
    mutating func edge(_ a: GP, _ b: GP, _ bow: CGFloat) {
        let dx = b.0 - a.0, dy = b.1 - a.1
        let len = max((dx * dx + dy * dy).squareRoot(), 0.001)
        if bow == 0 { to(b); return }
        let k = bow * 2 * ArtStyle.bowGain
        quad(b, ((a.0 + b.0) / 2 - dy / len * k, (a.1 + b.1) / 2 + dx / len * k))
    }

    /// A closed leaf (two arcs) from `a` to `b`, `bulge` units wide on each side.
    mutating func leaf(_ a: GP, _ b: GP, bulge: CGFloat) {
        let dx = b.0 - a.0, dy = b.1 - a.1
        let len = max((dx * dx + dy * dy).squareRoot(), 0.001)
        let nx = -dy / len * bulge, ny = dx / len * bulge
        let m: GP = ((a.0 + b.0) / 2, (a.1 + b.1) / 2)
        move(a)
        quad(b, (m.0 + nx, m.1 + ny))
        quad(a, (m.0 - nx, m.1 - ny))
        close()
    }

    /// The mascot's squiggle from `a` to `b`: `periods` soft waves of `amp` units.
    mutating func wave(_ a: GP, _ b: GP, amp: CGFloat = 1, periods: CGFloat = 1.5, phase: CGFloat = 0) {
        let steps = max(Int(periods * 6), 6)
        let dx = b.0 - a.0, dy = b.1 - a.1
        let len = max((dx * dx + dy * dy).squareRoot(), 0.001)
        let nx = -dy / len, ny = dx / len
        var pts: [GP] = []
        for i in 0...steps {
            let f = CGFloat(i) / CGFloat(steps)
            // Taper the ends so the line starts and lands calmly.
            let env = min(1, sin(f * .pi) * 1.6 + 0.25)
            let w = sin(f * periods * 2 * .pi + phase) * amp * env
            pts.append((a.0 + dx * f + nx * w, a.1 + dy * f + ny * w))
        }
        smooth(pts)
    }

    // MARK: - Fills (the accent)

    /// An organic blob (an ellipse with a fixed lumpy edge): the accent's soft print shape.
    /// `seed` picks one of a few fixed edge patterns; `tilt` turns it (degrees).
    mutating func blob(_ c: GP, _ rx: CGFloat, _ ry: CGFloat, seed: Int = 0, tilt: CGFloat = 0) {
        let lumps: [[CGFloat]] = [
            [1.0, 1.06, 0.95, 1.03, 0.97, 1.05, 0.94, 1.02],
            [0.97, 1.04, 1.02, 0.94, 1.05, 0.98, 1.03, 0.95],
            [1.04, 0.96, 1.02, 1.05, 0.95, 1.0, 0.97, 1.04],
        ]
        let lump = lumps[seed % lumps.count]
        let t = tilt * .pi / 180
        var pts: [GP] = []
        for i in 0..<8 {
            let a = CGFloat(i) * .pi / 4 + 0.3
            let x = cos(a) * rx * lump[i], y = sin(a) * ry * lump[i]
            pts.append((c.0 + x * cos(t) - y * sin(t), c.1 + x * sin(t) + y * cos(t)))
        }
        smooth(pts, closed: true)
    }

    /// A soft band (a lumpy rounded rectangle): calendar headers, card stripes, tabs.
    mutating func band(_ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat) {
        let h = y1 - y0, inset = min(h, x1 - x0) * 0.32
        smooth([
            (x0 + inset, y0 - 0.05), ((x0 + x1) / 2, y0 + 0.08), (x1 - inset, y0),
            (x1 + 0.05, (y0 + y1) / 2),
            (x1 - inset, y1), ((x0 + x1) / 2, y1 + 0.06), (x0 + inset, y1 - 0.04),
            (x0 - 0.05, (y0 + y1) / 2),
        ], closed: true, tension: 1.1)
    }
}
