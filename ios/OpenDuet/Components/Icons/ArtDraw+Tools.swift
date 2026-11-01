// Drawings: apps, tools and actions (DuetArt). `i` = ink, `t` = accent (see ArtDraw.swift).
import SwiftUI

extension ArtDraw {
    static func wrench(_ i: inout ArtPen, _ t: inout ArtPen) {
        // An open-end spanner: a round head with its jaw cut out and a handle, turned 45°.
        i.rotate(45)
        i.move((10.0, 3.0))
        i.to((10.0, 6.6))
        i.quad((14.0, 6.6), (12, 8.6))
        i.to((14.0, 3.0))
        i.ring((12, 7.0), 4.6, from: -65, sweep: 130, wobble: 0, join: false)
        i.move((14.0, 3.0))
        i.quad((14.6, 11.2), (17.4, 7.6))
        i.to((14.6, 19.6))
        i.quad((9.4, 19.6), (12, 22.4))
        i.to((9.4, 11.2))
        i.quad((10.0, 3.0), (6.6, 7.6))
        i.rotate(0)
        t.rotate(45)
        t.band(9.6, 12.6, 14.4, 19.6)
        t.rotate(0)
    }

    static func terminal(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(2.6, 4.2, 21.4, 19.8, r: 2.8)
        i.poly([(7.0, 9.0), (10.4, 12.0), (7.0, 15.0)], corner: 0.9)
        i.line((12.4, 15.4), (16.8, 15.4))
        t.blob((9.4, 12.2), 3.2, 3.6, seed: 2)
    }

    static func code(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(7.6, 6.6), (2.8, 12), (7.6, 17.4)], corner: 1.0)
        i.poly([(16.4, 6.6), (21.2, 12), (16.4, 17.4)], corner: 1.0)
        i.line((13.6, 5.2), (10.4, 18.8), bow: 0.06)
        t.blob((12.2, 12.2), 3.4, 4.8, seed: 0, tilt: 14)
    }

    static func database(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 6.2), 7.8, 2.8)
        i.ring((12, 12.0), 7.8, 2.8, from: 0, sweep: 180, wobble: 0)
        i.ring((12, 17.8), 7.8, 2.8, from: 0, sweep: 180, wobble: 0)
        i.line((4.2, 6.2), (4.2, 17.8))
        i.line((19.8, 6.2), (19.8, 17.8))
        t.blob((12.2, 6.4), 6.8, 2.4, seed: 1)
    }

    static func paperclip(_ i: inout ArtPen, _ t: inout ArtPen) {
        // A hairpin line drawn upright, turned 40°.
        i.rotate(40)
        i.poly([(16.6, 6.9), (16.6, 15.4), (16.6, 19.8), (12, 19.8), (7.4, 19.8), (7.4, 15.4), (7.4, 5.8), (7.4, 3.0), (10.3, 3.0), (13.2, 3.0), (13.2, 5.8), (13.2, 15.4)],
               corners: [0, 0, 4.0, 0, 4.0, 0, 0, 2.6, 0, 2.6, 0, 0])
        i.rotate(0)
        t.rotate(40)
        t.blob((12, 16.0), 3.0, 2.6, seed: 2)
        t.rotate(0)
    }

    static func seal(_ i: inout ArtPen, _ t: inout ArtPen) {
        var pts: [GP] = []
        for k in 0..<24 {
            let a = CGFloat(k) * .pi / 12
            let r: CGFloat = k % 2 == 0 ? 8.8 : 7.8
            pts.append((12 + cos(a) * r, 12 + sin(a) * r))
        }
        i.smooth(pts, closed: true, tension: 0.9)
        tick(&i, 8.0, 8.6, 8.0, 6.6)
        t.blob((12.2, 12.2), 6.0, 6.0, seed: 1)
    }

    static func shield(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.smooth([(12, 2.8), (16.2, 4.6), (19.6, 5.6), (19.2, 12.4), (16.4, 17.8), (12, 21.2), (7.6, 17.8), (4.8, 12.4), (4.4, 5.6), (7.8, 4.6)], closed: true, tension: 0.85)
        tick(&i, 8.2, 8.6, 7.6, 6.4)
        t.blob((12.2, 12.0), 5.2, 6.2, seed: 0)
    }

    static func stamp(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 5.4), 2.6)
        i.poly([(10.4, 7.6), (10.4, 10.2), (5.4, 12.0), (5.4, 15.8), (18.6, 15.8), (18.6, 12.0), (13.6, 10.2), (13.6, 7.6)], corners: [0, 0.8, 1.6, 1.4, 1.4, 1.6, 0.8, 0])
        i.line((4.4, 20.4), (19.6, 20.4), bow: 0.15)
        t.band(4.4, 18.6, 19.6, 21.6)
    }

    static func signature(_ i: inout ArtPen, _ t: inout ArtPen) {
        // The mascot's cursive "ee" over a baseline, like a name signed on a line.
        var pts: [GP] = [(2.8, 15.6), (4.8, 14.0)]
        for k in 0...28 {
            let s = -CGFloat.pi + 4 * .pi * CGFloat(k) / 28
            pts.append((12 + 1.15 * s - 2.9 * sin(s), 11.0 - 2.9 * cos(s)))
        }
        pts += [(18.8, 14.0), (21.2, 12.6)]
        i.smooth(pts, tension: 0.95)
        i.line((3.0, 19.6), (21.0, 19.6), bow: 0.08)
        t.blob((9.0, 10.6), 3.4, 3.4, seed: 2)
    }

    static func trash(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.line((3.6, 6.6), (20.4, 6.6), bow: 0.1)
        i.poly([(9.0, 6.4), (9.0, 3.6), (15.0, 3.6), (15.0, 6.4)], corner: 1.0)
        i.poly([(5.6, 7.0), (6.6, 21.0), (17.4, 21.0), (18.4, 7.0)], corners: [0, 2.0, 2.0, 0])
        i.line((10.2, 10.8), (10.2, 17.2))
        i.line((13.8, 10.8), (13.8, 17.2))
        t.poly([(6.2, 7.4), (17.8, 7.4), (17.0, 20.4), (7.0, 20.4)], corner: 1.6, closed: true)
    }

    static func paperPlane(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(21.0, 3.0), (3.0, 10.4), (10.0, 13.8), (13.4, 21.0)], corner: 1.2, closed: true)
        i.line((10.0, 13.8), (21.0, 3.0), bow: 0)
        t.poly([(10.4, 14.2), (20.4, 4.0), (13.6, 20.0)], corner: 1.2, closed: true)
    }

    static func pin(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.rotate(45, about: (12, 12), nudge: (0.6, -0.4))
        i.poly([(9.0, 3.2), (15.0, 3.2), (14.0, 9.6), (16.8, 13.4), (7.2, 13.4), (10.0, 9.6)], corners: [1.0, 1.0, 0.8, 1.0, 1.0, 0.8], closed: true)
        i.line((12, 13.6), (12, 21.0))
        i.rotate(0)
        t.rotate(45, about: (12, 12), nudge: (0.6, -0.4))
        t.poly([(9.4, 3.6), (14.6, 3.6), (13.6, 9.8), (16.2, 13.0), (7.8, 13.0), (10.4, 9.8)], corner: 1.0, closed: true)
        t.rotate(0)
    }

    static func eye(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.move((2.6, 12))
        i.quad((21.4, 12), (12, 0.6))
        i.quad((2.6, 12), (12, 23.4))
        i.close()
        i.ring((12, 12), 3.2)
        t.blob((12.2, 12.2), 3.0, 3.0, seed: 0)
    }

    /// A pencil from its tip `a` to its end `b`, `w` units half-wide.
    static func pencilBody(_ i: inout ArtPen, _ t: inout ArtPen, _ a: GP, _ b: GP, w: CGFloat = 2.2, cone: CGFloat = 4.0, eraser: Bool = true) {
        let dx = b.0 - a.0, dy = b.1 - a.1
        let len = (dx * dx + dy * dy).squareRoot()
        let d = (dx / len, dy / len), n = (-dy / len * w, dx / len * w)
        let base: GP = (a.0 + d.0 * cone, a.1 + d.1 * cone)
        i.poly([a, (base.0 + n.0, base.1 + n.1), (b.0 + n.0, b.1 + n.1), (b.0 - n.0, b.1 - n.1), (base.0 - n.0, base.1 - n.1)], corners: [0.5, 0.6, 1.2, 1.2, 0.6], closed: true)
        i.line((base.0 + n.0 * 0.9, base.1 + n.1 * 0.9), (base.0 - n.0 * 0.9, base.1 - n.1 * 0.9))
        guard eraser else { return }
        let e: GP = (b.0 - d.0 * 3.2, b.1 - d.1 * 3.2)
        t.poly([(e.0 + n.0, e.1 + n.1), (b.0 + n.0, b.1 + n.1), (b.0 - n.0, b.1 - n.1), (e.0 - n.0, e.1 - n.1)], corner: 0.8, closed: true)
    }

    static func pencil(_ i: inout ArtPen, _ t: inout ArtPen) {
        pencilBody(&i, &t, (3.6, 20.4), (18.6, 5.4))
    }
}
