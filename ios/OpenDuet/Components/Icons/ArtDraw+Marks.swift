// Drawings: actions, marks and status (DuetArt). `i` = ink, `t` = accent (see ArtDraw.swift).
import SwiftUI

extension ArtDraw {
    static func compose(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(11.4, 4.2), (3.6, 4.2), (3.6, 20.4), (19.8, 20.4), (19.8, 12.6)], corners: [0, 2.6, 2.6, 2.6, 0])
        pencilBody(&i, &t, (10.4, 13.6), (19.8, 4.2), w: 1.8, cone: 3.2)
    }

    static func make(_ i: inout ArtPen, _ t: inout ArtPen) {
        // The tab bar's Make: a square open at its top right, a +, and a pencil coming in.
        i.poly([(11.5, 5.3), (2.9, 5.3), (2.9, 20.6), (18.2, 20.6), (18.2, 14.4)], corners: [0, 3.4, 3.4, 3.4, 0])
        i.line((7.4, 8.2), (7.4, 12.5))
        i.line((5.3, 10.3), (9.6, 10.3))
        pencilBody(&i, &t, (12.0, 13.4), (21.1, 4.3), w: 1.68, cone: 3.1, eraser: false)
        t.blob((7.6, 10.6), 3.0, 3.0, seed: 0)
    }

    static func share(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(8.4, 9.4), (5.0, 9.4), (5.0, 21.0), (19.0, 21.0), (19.0, 9.4), (15.6, 9.4)], corners: [0, 2.4, 2.4, 2.4, 2.4, 0])
        i.line((12, 14.8), (12, 3.2))
        i.poly([(8.6, 6.4), (12, 3.0), (15.4, 6.4)], corner: 0.8)
    }

    static func refresh(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12.6), 8.2, from: -60, sweep: 290, wobble: 0)
        i.poly([(6.6, 2.8), (11.0, 4.6), (8.4, 8.4)], corner: 0.8)
    }

    static func pointer(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(5.6, 3.2), (19.0, 12.8), (13.0, 14.0), (16.6, 20.6), (14.0, 21.6), (10.8, 15.2), (6.6, 19.0)], corners: [1.0, 1.0, 0.6, 0.8, 0.8, 0.6, 1.0], closed: true)
        t.poly([(6.4, 4.8), (17.4, 12.6), (12.4, 13.8), (10.6, 14.6), (7.2, 17.6)], corner: 1.0, closed: true)
    }

    static func quote(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(8.6, 4.2), (3.0, 9.4), (8.6, 14.6)], corner: 1.0)
        i.move((3.6, 9.4))
        i.curve((20.4, 19.8), (14.6, 9.4), (20.4, 11.8))
    }

    static func sort(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.line((8.0, 4.0), (8.0, 19.8))
        i.poly([(4.4, 7.6), (8.0, 4.0), (11.6, 7.6)], corner: 0.8)
        i.line((16.0, 20.0), (16.0, 4.2))
        i.poly([(12.4, 16.4), (16.0, 20.0), (19.6, 16.4)], corner: 0.8)
    }

    /// A four-point star with concave sides.
    static func sparkleStar(_ i: inout ArtPen, c: GP, r: CGFloat, k: CGFloat = 0.16) {
        let (x, y) = c
        i.move((x, y - r))
        i.quad((x + r, y), (x + r * k, y - r * k))
        i.quad((x, y + r), (x + r * k, y + r * k))
        i.quad((x - r, y), (x - r * k, y + r * k))
        i.quad((x, y - r), (x - r * k, y - r * k))
        i.close()
    }

    static func sparkle(_ i: inout ArtPen, _ t: inout ArtPen) {
        sparkleStar(&i, c: (10.6, 13.4), r: 7.8)
        i.line((18.4, 2.8), (18.4, 7.4))
        i.line((16.1, 5.1), (20.7, 5.1))
        t.blob((10.8, 13.6), 3.6, 3.6, seed: 2)
    }

    static func heart(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.move((12, 20.6))
        i.curve((2.8, 9.6), (7.6, 16.8), (2.8, 13.4))
        i.curve((12, 7.0), (2.8, 3.4), (10.2, 3.0))
        i.curve((21.2, 9.6), (13.8, 3.0), (21.2, 3.4))
        i.curve((12, 20.6), (21.2, 13.4), (16.4, 16.8))
        i.close()
        t.move((12, 19.0))
        t.curve((4.6, 9.8), (8.2, 16.0), (4.6, 13.0))
        t.curve((12, 8.6), (4.6, 5.0), (10.4, 4.6))
        t.curve((19.4, 9.8), (13.6, 4.6), (19.4, 5.0))
        t.curve((12, 19.0), (19.4, 13.0), (15.8, 16.0))
        t.close()
    }

    static func star(_ i: inout ArtPen, _ t: inout ArtPen) {
        var pts: [GP] = []
        for k in 0..<10 {
            let a = (-90 + CGFloat(k) * 36) * .pi / 180
            let r: CGFloat = k % 2 == 0 ? 9.4 : 4.2
            pts.append((12 + cos(a) * r, 12.8 + sin(a) * r))
        }
        i.poly(pts, corners: [1.2, 0.6], closed: true)
        t.poly(pts.map { (12 + ($0.0 - 12) * 0.78, 12.8 + ($0.1 - 12.8) * 0.78) }, corners: [1.2, 0.5], closed: true)
    }

    static func bell(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.smooth([(3.4, 17.4), (5.6, 14.6), (6.0, 9.6), (8.4, 5.4), (12, 4.2), (15.6, 5.4), (18.0, 9.6), (18.4, 14.6), (20.6, 17.4)], tension: 0.9)
        i.line((3.4, 17.4), (20.6, 17.4), bow: 0.08)
        i.ring((12, 18.2), 2.6, from: 20, sweep: 140, wobble: 0)
        i.line((12, 2.6), (12, 4.0))
        t.blob((12.2, 11.0), 4.0, 4.6, seed: 2)
    }

    static func bellOff(_ i: inout ArtPen, _ t: inout ArtPen) {
        bell(&i, &t)
        i.line((3.6, 3.6), (20.4, 20.4))
    }

    static func warning(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(12, 3.4), (21.4, 20.0), (2.6, 20.0)], corner: 2.6, closed: true)
        i.line((12, 9.6), (12, 13.8))
        i.dot((12, 16.9))
        t.poly([(12, 5.4), (19.6, 19.0), (4.4, 19.0)], corner: 2.6, closed: true)
    }

    static func check(_ i: inout ArtPen, _ t: inout ArtPen) {
        tick(&i, 3.0, 4.0, 18.0, 15.0)
        t.blob((8.6, 14.2), 4.2, 3.8, seed: 1)
    }

    static func checkbox(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(3.2, 3.2, 20.8, 20.8, r: 3.2)
        tick(&i, 7.0, 7.6, 10.4, 8.4)
        t.blob((12.2, 12.4), 5.8, 5.8, seed: 2)
    }

    static func done(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12), 8.8)
        tick(&i, 7.4, 7.8, 9.6, 8.2)
        t.blob((12.2, 12.2), 6.6, 6.6, seed: 0)
    }

    static func failed(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12), 8.8)
        i.line((12, 7.2), (12, 12.6))
        i.dot((12, 16.4))
        t.blob((12.2, 12.2), 6.6, 6.6, seed: 1)
    }

    static func pending(_ i: inout ArtPen, _ t: inout ArtPen) {
        for k in 0..<8 {
            i.ring((12, 12), 8.6, from: -90 + CGFloat(k) * 45 + 7, sweep: 27, wobble: 0)
        }
    }

    static func info(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12), 8.8)
        i.dot((12, 7.8))
        i.poly([(10.4, 11.0), (12, 11.0), (12, 16.6)], corner: 0.7)
        t.blob((12.2, 12.2), 6.6, 6.6, seed: 2)
    }

    static func action(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12), 8.8)
        i.line((7.6, 12), (16.0, 12))
        i.poly([(12.6, 8.6), (16.2, 12), (12.6, 15.4)], corner: 0.8)
        t.blob((12.2, 12.2), 6.6, 6.6, seed: 0)
    }

    static func arrowOut(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.line((5.6, 18.4), (18.0, 6.0), bow: 0.18)
        i.poly([(8.6, 5.6), (18.4, 5.6), (18.4, 15.4)], corner: 1.2)
    }

    static func play(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(7.4, 4.2), (19.4, 12), (7.4, 19.8)], corner: 2.0, closed: true)
        t.poly([(8.0, 6.0), (17.6, 12), (8.0, 18.0)], corner: 2.0, closed: true)
    }

    static func wifiOff(_ i: inout ArtPen, _ t: inout ArtPen) {
        for r in [3.6, 7.6, 11.6] as [CGFloat] {
            i.ring((12, 19.2), r, from: 222, sweep: 96, wobble: 0)
        }
        i.dot((12, 19.2))
        i.line((4.0, 3.6), (20.0, 20.4))
    }

    static func slashCircle(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12), 8.8)
        i.line((14.4, 7.2), (9.6, 16.8), bow: 0.05)
        t.blob((12.2, 12.2), 6.6, 6.6, seed: 1)
    }

    static func tasks(_ i: inout ArtPen, _ t: inout ArtPen) {
        // The tab bar's Tasks: two ticks and their lines.
        for y in [7.9, 16.6] as [CGFloat] {
            tick(&i, 2.6, y - 3.2, 6.4, 5.6)
            i.line((12.0, y), (21.2, y), bow: 0.12)
        }
        t.band(11.4, 6.4, 21.4, 9.4)
    }

    static func menu(_ i: inout ArtPen, _ t: inout ArtPen) {
        // The header's ≡: left-aligned, long / medium / short.
        for (y, end) in [(6.5, 20.6), (12.0, 16.8), (17.5, 12.0)] as [GP] {
            i.line((3.4, y), (end, y), bow: 0.1)
        }
    }

    static func contents(_ i: inout ArtPen, _ t: inout ArtPen) {
        for y in [6.0, 12.0, 18.0] as [CGFloat] {
            i.dot((4.6, y))
            i.line((9.0, y), (20.4, y), bow: 0.1)
        }
    }

    static func plus(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.line((12, 4.4), (12, 19.6))
        i.line((4.4, 12), (19.6, 12))
    }

    static func close(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.line((5.6, 5.6), (18.4, 18.4))
        i.line((18.4, 5.6), (5.6, 18.4))
    }

    static func chevronRight(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(9.0, 4.8), (16.2, 12), (9.0, 19.2)], corner: 1.0)
    }

    static func chevronLeft(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(15.0, 4.8), (7.8, 12), (15.0, 19.2)], corner: 1.0)
    }

    static func arrowDown(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.line((12, 4.0), (12, 19.6))
        i.poly([(6.4, 14.0), (12, 19.6), (17.6, 14.0)], corner: 0.9)
    }

    static func ellipsis(_ i: inout ArtPen, _ t: inout ArtPen) {
        for x in [5.0, 12.0, 19.0] as [CGFloat] {
            i.ring((x, 12), 0.55, wobble: 0)
        }
    }
}
