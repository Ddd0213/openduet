// Drawings: objects (DuetArt). `i` = ink, `t` = accent (see ArtDraw.swift).
import SwiftUI

extension ArtDraw {
    static func car(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(5.0, 17.4), (2.8, 17.4), (2.8, 12.6), (6.2, 11.4), (8.4, 7.0), (15.6, 7.0), (18.0, 11.4), (21.2, 12.6), (21.2, 17.4), (19.0, 17.4)], corners: [0, 1.4, 1.6, 1.2, 1.4, 1.4, 1.2, 1.6, 1.4, 0])
        i.line((9.2, 17.4), (14.8, 17.4))
        i.ring((7.1, 17.6), 2.0, wobble: 0)
        i.ring((16.9, 17.6), 2.0, wobble: 0)
        t.poly([(8.0, 11.4), (9.4, 8.0), (14.6, 8.0), (16.0, 11.4)], corner: 1.0, closed: true)
    }

    static func camera(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(2.8, 7.4), (7.2, 7.4), (8.8, 4.6), (15.2, 4.6), (16.8, 7.4), (21.2, 7.4), (21.2, 19.6), (2.8, 19.6)], corners: [2.4, 1.0, 1.0, 1.0, 1.0, 2.4, 2.4, 2.4], closed: true)
        i.ring((12, 13.2), 3.8)
        t.blob((12.2, 13.4), 3.6, 3.6, seed: 1)
    }

    static func photo(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(2.8, 4.2, 21.2, 19.8, r: 2.8)
        i.poly([(3.2, 16.8), (8.8, 11.4), (13.0, 15.2), (15.8, 12.8), (20.8, 17.2)], corners: [0, 1.4, 1.2, 1.2, 0])
        i.ring((15.4, 8.6), 1.7, wobble: 0)
        t.poly([(3.4, 17.2), (8.8, 12.0), (13.0, 15.8), (15.8, 13.4), (20.6, 17.6), (20.6, 19.4), (3.4, 19.4)], corner: 1.6, closed: true)
    }

    static func music(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((7.0, 17.8), 2.6, 2.1, wobble: 0, tilt: -20)
        i.ring((17.2, 16.0), 2.6, 2.1, wobble: 0, tilt: -20)
        i.line((9.5, 17.0), (9.5, 5.6))
        i.line((19.7, 15.2), (19.7, 3.8))
        i.line((9.5, 5.6), (19.7, 3.8), bow: -0.1)
        t.blob((7.2, 18.0), 2.6, 2.2, seed: 0, tilt: -20)
    }

    static func mic(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(8.8, 2.8, 15.2, 14.6, r: 3.2, bows: (0, 0, 0, 0))
        i.smooth([(5.6, 11.4), (6.6, 15.4), (12, 18.0), (17.4, 15.4), (18.4, 11.4)], tension: 0.9)
        i.line((12, 18.2), (12, 21.0))
        i.line((9.0, 21.0), (15.0, 21.0))
        t.band(9.0, 3.0, 15.0, 14.4)
    }

    static func waveform(_ i: inout ArtPen, _ t: inout ArtPen) {
        for (x, h) in [(4.0, 3.4), (8.0, 9.0), (12.0, 14.4), (16.0, 7.0), (20.0, 3.4)] as [GP] {
            i.line((x, 12 - h / 2), (x, 12 + h / 2))
        }
    }

    static func keyboard(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(2.4, 5.4, 21.6, 18.6, r: 2.6)
        for x in [6.0, 9.6, 13.2, 16.8] as [CGFloat] { i.dot((x, 9.4)) }
        for x in [7.8, 11.4, 15.0, 18.4] as [CGFloat] { i.dot((x, 12.2)) }
        i.line((8.0, 15.2), (16.0, 15.2))
    }

    static func flask(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.line((8.4, 3.0), (15.6, 3.0))
        i.poly([(9.6, 3.2), (9.6, 9.0), (4.0, 19.0), (4.4, 21.0), (19.6, 21.0), (20.0, 19.0), (14.4, 9.0), (14.4, 3.2)], corners: [0, 1.0, 1.4, 1.2, 1.2, 1.4, 1.0, 0])
        t.poly([(7.0, 14.2), (17.0, 14.2), (19.4, 19.2), (19.0, 20.6), (5.0, 20.6), (4.6, 19.2)], corner: 1.2, closed: true)
    }

    static func scissors(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((6.6, 17.2), 3.0)
        i.ring((17.4, 17.2), 3.0)
        i.line((8.6, 14.8), (18.6, 3.4), bow: 0.08)
        i.line((15.4, 14.8), (5.4, 3.4), bow: -0.08)
        t.blob((6.8, 17.4), 2.8, 2.8, seed: 2)
    }

    static func bag(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(5.6, 8.6), (18.4, 8.6), (19.6, 21.0), (4.4, 21.0)], corners: [1.2, 1.2, 2.2, 2.2], closed: true)
        i.ring((12, 8.6), 3.6, from: 180, sweep: 180, wobble: 0)
        t.blob((12.2, 15.6), 4.8, 3.6, seed: 1)
    }

    static func sprout(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.smooth([(12, 21.0), (11.8, 16.0), (12.2, 12.0), (12.6, 9.6)], tension: 0.9)
        i.leaf((12.4, 11.6), (4.0, 6.0), bulge: 2.4)
        i.leaf((12.6, 9.8), (20.0, 3.4), bulge: 2.2)
        t.leaf((12.4, 11.6), (4.0, 6.0), bulge: 2.3)
    }

    static func briefcase(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(2.8, 7.0, 21.2, 20.4, r: 2.6)
        i.poly([(8.8, 7.0), (8.8, 3.8), (15.2, 3.8), (15.2, 7.0)], corner: 1.4)
        i.line((3.1, 12.8), (20.9, 12.8), bow: 0.14)
        t.band(3.0, 7.2, 21.0, 12.8)
    }

    static func playScreen(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(2.8, 4.4, 21.2, 19.6, r: 2.8)
        i.poly([(10.0, 8.8), (15.8, 12), (10.0, 15.2)], corner: 1.0, closed: true)
        t.poly([(9.6, 8.2), (16.4, 12), (9.6, 15.8)], corner: 1.2, closed: true)
    }

    static func layers(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(12, 3.4), (20.6, 8.0), (12, 12.6), (3.4, 8.0)], corner: 1.2, closed: true)
        i.poly([(3.6, 12.2), (12, 16.6), (20.4, 12.2)], corner: 1.0)
        i.poly([(3.6, 16.2), (12, 20.6), (20.4, 16.2)], corner: 1.0)
        t.poly([(12, 3.8), (19.8, 8.0), (12, 12.2), (4.2, 8.0)], corner: 1.2, closed: true)
    }

    static func card(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(2.6, 5.4, 21.4, 18.6, r: 2.6)
        i.line((2.9, 9.6), (21.1, 9.6), bow: 0.12)
        i.line((5.8, 14.8), (10.2, 14.8))
        t.band(2.8, 9.6, 21.2, 12.6)
    }

    static func computer(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(2.6, 3.6, 21.4, 16.0, r: 2.6)
        i.line((12, 16.4), (12, 19.6))
        i.line((7.8, 20.6), (16.2, 20.6), bow: 0.08)
        // The mascot on the screen: its squiggle over a soft disc.
        i.wave((7.4, 9.8), (16.6, 9.8), amp: 1.3, periods: 1)
        t.blob((12.0, 9.9), 3.6, 3.6, seed: 0)
    }

    static func grid(_ i: inout ArtPen, _ t: inout ArtPen) {
        let a: CGFloat = 3.4, b: CGFloat = 10.4, c: CGFloat = 13.6, d: CGFloat = 20.6
        i.box(a, a, b, b, r: 2.2, bows: (0, 0, 0, 0))
        i.box(c, a, d, b, r: 2.2, bows: (0, 0, 0, 0))
        i.box(a, c, b, d, r: 2.2, bows: (0, 0, 0, 0))
        i.box(c, c, d, d, r: 2.2, bows: (0, 0, 0, 0))
        t.blob((17.1, 6.9), 3.4, 3.4, seed: 1)
    }
}
