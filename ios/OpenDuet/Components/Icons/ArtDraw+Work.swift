// Drawings: work and documents (DuetArt). `i` = ink, `t` = accent (see ArtDraw.swift).
import SwiftUI

/// The shared check stroke (also the animated HandDrawnCheck in CheckMarks.swift): a marker
/// check with a soft elbow, in a unit square.
enum ArtCheck {
    static let start = CGPoint(x: 0.06, y: 0.56)
    static let elbowControl = CGPoint(x: 0.2, y: 0.68)
    static let elbow = CGPoint(x: 0.38, y: 0.86)
    static let endControl = CGPoint(x: 0.56, y: 0.42)
    static let end = CGPoint(x: 0.95, y: 0.12)
}

extension ArtDraw {
    /// A check in the box (x, y, w, h) of the grid.
    static func tick(_ i: inout ArtPen, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
        func g(_ q: CGPoint) -> GP { (x + q.x * w, y + q.y * h) }
        i.move(g(ArtCheck.start))
        i.quad(g(ArtCheck.elbow), g(ArtCheck.elbowControl))
        i.quad(g(ArtCheck.end), g(ArtCheck.endControl))
    }

    /// A page with its top-right corner folded (fold `f` units). The sides lean a touch, like
    /// one drawn by hand; the folded flap prints in the accent.
    static func page(_ i: inout ArtPen, _ t: inout ArtPen, _ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat, fold f: CGFloat = 4.6, tone: Bool = true) {
        let r: CGFloat = 2.3
        i.move((x0 + r, y0))
        i.to((x1 - f - 0.5, y0))
        i.quad((x1 - f + 0.35, y0 + 0.35), (x1 - f, y0))
        i.to((x1 - 0.35, y0 + f - 0.35))
        i.quad((x1, y0 + f + 0.5), (x1, y0 + f))
        i.edge((x1, y0 + f + 0.5), (x1, y1 - r), 0.2)
        i.quad((x1 - r, y1), (x1, y1))
        i.edge((x1 - r, y1), (x0 + r, y1), -0.18)
        i.quad((x0, y1 - r), (x0, y1))
        i.edge((x0, y1 - r), (x0, y0 + r), -0.2)
        i.quad((x0 + r, y0), (x0, y0))
        i.close()
        // The crease.
        i.poly([(x1 - f, y0 + 0.9), (x1 - f, y0 + f), (x1 - 0.9, y0 + f)], corner: 1.1)
        if tone {
            t.poly([(x1 - f - 0.9, y0 - 0.6), (x1 + 0.7, y0 + f + 0.9), (x1 - f - 0.9, y0 + f + 0.9)], corner: 1.0, closed: true)
        }
    }

    static func bulb(_ i: inout ArtPen, _ t: inout ArtPen) {
        // The glass: one organic line from the neck round the top and back.
        i.smooth([(9.4, 15.4), (8.3, 13.1), (6.3, 10.6), (6.4, 6.9), (9.0, 3.6), (12, 2.8), (15.0, 3.6), (17.6, 6.9), (17.7, 10.6), (15.7, 13.1), (14.6, 15.4)])
        i.line((9.0, 18.4), (15.0, 18.4), bow: 0.1)
        i.line((10.2, 21.0), (13.8, 21.0))
        t.blob((12.3, 8.6), 4.5, 4.6, seed: 0, tilt: -8)
    }

    static func doc(_ i: inout ArtPen, _ t: inout ArtPen) {
        // Two lines of writing, the first one highlighted.
        page(&i, &t, 5.5, 3, 18.5, 21, tone: false)
        i.line((8.8, 12.6), (15.2, 12.6), bow: 0.15)
        i.line((8.8, 16.6), (13.0, 16.6), bow: -0.1)
        t.band(7.6, 10.6, 16.2, 13.6)
    }

    static func file(_ i: inout ArtPen, _ t: inout ArtPen) {
        page(&i, &t, 5.5, 3, 18.5, 21)
    }

    static func pages(_ i: inout ArtPen, _ t: inout ArtPen) {
        // The back sheet peeks out top-left as an L behind the front one.
        i.poly([(13.6, 3.0), (6.6, 3.0), (4.6, 3.0), (4.6, 5.0), (4.6, 15.6)], corners: [0, 0, 2.0, 0, 0])
        page(&i, &t, 8.4, 6.6, 19.6, 21, fold: 4.0, tone: false)
        i.line((11.4, 14.6), (16.2, 14.6), bow: 0.12)
        t.blob((6.4, 6.6), 2.6, 3.2, seed: 1)
    }

    static func zipDoc(_ i: inout ArtPen, _ t: inout ArtPen) {
        page(&i, &t, 5.5, 3, 18.5, 21)
        // The zip: staggered teeth down the page and a square pull.
        for (n, y) in [5.2, 7.2, 9.2].enumerated() {
            let x: CGFloat = n % 2 == 0 ? 9.8 : 11.6
            i.line((x, y), (x + 1.6, y))
        }
        i.box(9.4, 12.0, 13.8, 16.6, r: 1.2, bows: (0, 0, 0, 0))
    }

    static func sheetGrid(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(3.6, 4.6, 20.4, 19.4, r: 2.6)
        i.line((3.9, 9.6), (20.1, 9.6), bow: 0.12)
        i.line((3.9, 14.5), (20.1, 14.5), bow: -0.1)
        i.line((9.6, 4.9), (9.6, 19.1), bow: 0.1)
        t.band(3.8, 9.6, 9.6, 19.4)
    }

    static func slides(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(3.4, 3.6, 20.6, 15.4, r: 2.4)
        i.poly([(8.2, 21.0), (12, 15.6), (15.8, 21.0)], corner: 1.4)
        i.smooth([(6.6, 12.0), (9.4, 9.4), (12.2, 11.0), (14.8, 7.4), (17.4, 8.0)], tension: 0.8)
        t.blob((10.6, 9.6), 4.4, 3.4, seed: 2)
    }

    static func gauge(_ i: inout ArtPen, _ t: inout ArtPen) {
        let c: GP = (12, 14.2)
        i.ring(c, 8.8, from: 150, sweep: 240, wobble: 0.01)
        i.line(c, (15.9, 7.4), bow: 0.08)
        i.dot(c)
        // The used part of the dial.
        t.move(c)
        t.ring(c, 7.4, from: 150, sweep: 150, wobble: 0, join: true)
        t.close()
    }

    static func window(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(3.2, 4.2, 20.8, 19.8, r: 2.8)
        i.line((3.5, 9.4), (20.5, 9.4), bow: 0.1)
        i.dot((6.4, 6.8))
        i.dot((8.9, 6.8))
        t.blob((12.6, 14.2), 5.6, 2.9, seed: 0, tilt: -4)
    }

    static func brush(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.line((20.4, 3.6), (12.6, 11.4), bow: 0.15)
        // The bristles: a teardrop from the ferrule to a point at the bottom left.
        i.smooth([(10.0, 10.0), (13.8, 13.4), (12.8, 16.6), (8.8, 19.2), (3.6, 20.4), (5.2, 15.6), (7.0, 12.2), (10.0, 10.0)], tension: 0.9)
        t.blob((7.8, 17.0), 3.6, 2.6, seed: 1, tilt: -30)
    }

    static func checklist(_ i: inout ArtPen, _ t: inout ArtPen) {
        tick(&i, 3.4, 4.0, 4.6, 3.8)
        tick(&i, 3.4, 10.2, 4.6, 3.8)
        i.dot((5.6, 18.4))
        i.line((11.0, 6.0), (20.6, 6.0), bow: 0.14)
        i.line((11.0, 12.2), (20.6, 12.2), bow: -0.1)
        i.line((11.0, 18.4), (17.4, 18.4), bow: 0.1)
        t.band(10.2, 4.4, 20.8, 7.4)
    }

    static func clipboard(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(9.0, 4.6), (5.4, 4.6), (5.4, 21.0), (18.6, 21.0), (18.6, 4.6), (15.0, 4.6)], corners: [0, 2.4, 2.4, 2.4, 2.4, 0])
        i.box(9.0, 3.0, 15.0, 6.4, r: 1.4, bows: (0, 0, 0, 0))
        tick(&i, 8.6, 10.6, 6.8, 6.0)
        t.band(8.6, 2.8, 15.4, 6.8)
    }

    static func calendar(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(3.6, 4.8, 20.4, 20.2, r: 2.8)
        i.line((3.9, 9.8), (20.1, 9.8), bow: 0.1)
        i.line((8.4, 2.8), (8.4, 6.6))
        i.line((15.6, 2.8), (15.6, 6.6))
        for (x, y) in [(8.0, 13.6), (12.0, 13.6), (16.0, 13.6), (8.0, 17.0), (12.0, 17.0)] as [GP] {
            i.dot((x, y))
        }
        t.band(3.8, 5.0, 20.2, 9.8)
    }

    static func clock(_ i: inout ArtPen, _ t: inout ArtPen) {
        let c: GP = (12, 12)
        i.ring(c, 8.8)
        i.poly([(12, 6.6), (12, 12.2), (15.6, 14.2)], corner: 0.9)
        // The time gone by, as a wedge from 12 to the hand.
        t.move(c)
        t.ring(c, 7.6, from: -90, sweep: 120, wobble: 0, join: true)
        t.close()
    }

    static func timer(_ i: inout ArtPen, _ t: inout ArtPen) {
        let c: GP = (12, 13.2)
        i.ring(c, 7.8)
        i.line((12, 5.4), (12, 3.8))
        i.line((9.8, 2.8), (14.2, 2.8))
        i.line((17.6, 7.6), (18.8, 6.4))
        i.line(c, (15.3, 10.3), bow: 0.05)
        t.move(c)
        t.ring(c, 6.6, from: -90, sweep: 45, wobble: 0, join: true)
        t.close()
    }

    static func sunrise(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.line((2.8, 18.6), (21.2, 18.6), bow: 0.15)
        i.ring((12, 18.2), 5.2, from: 180, sweep: 180, wobble: 0.01)
        i.line((12, 9.4), (12, 7.4))
        i.line((5.6, 11.8), (4.2, 10.4))
        i.line((18.4, 11.8), (19.8, 10.4))
        t.blob((12.2, 16.0), 4.2, 2.6, seed: 2)
    }
}
