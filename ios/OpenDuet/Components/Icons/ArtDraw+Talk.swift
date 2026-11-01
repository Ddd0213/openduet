// Drawings: talk and people (DuetArt). `i` = ink, `t` = accent (see ArtDraw.swift).
import SwiftUI

extension ArtDraw {
    static func envelope(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(3.0, 5.4, 21.0, 18.6, r: 2.6)
        i.poly([(4.6, 7.4), (12, 12.8), (19.4, 7.4)], corner: 1.6)
        t.poly([(4.0, 6.6), (20.0, 6.6), (12, 12.4)], corner: 2.0, closed: true)
    }

    /// The round speech bubble (the tab bar's Chat and the chat concept): a near-circle with
    /// its tail at the bottom left.
    static func roundBubble(_ i: inout ArtPen, c: GP = (12.6, 11.2), r: CGFloat = 8.6) {
        let a0: CGFloat = 160, a1: CGFloat = 470
        i.ring(c, r, from: a0, sweep: a1 - a0, wobble: 0)
        let start = (c.0 + r * cos(a0 * .pi / 180), c.1 + r * sin(a0 * .pi / 180))
        i.quad((3.0, 20.8), (7.6, 19.8))
        i.quad(start, (4.6, 17.4))
    }

    static func bubble(_ i: inout ArtPen, _ t: inout ArtPen) {
        roundBubble(&i)
        i.wave((8.0, 11.4), (17.4, 11.2), amp: 1.5, periods: 1)
        t.blob((12.8, 11.4), 4.2, 4.3, seed: 0)
    }

    static func chat(_ i: inout ArtPen, _ t: inout ArtPen) {
        bubble(&i, &t)
    }

    static func bubbles(_ i: inout ArtPen, _ t: inout ArtPen) {
        // The back bubble, partly hidden behind the front one; its tail at the bottom left.
        i.poly([(14.4, 6.6), (14.4, 3.4), (3.4, 3.4), (3.4, 15.4), (6.4, 12.8), (7.0, 12.8)], corners: [0, 2.6, 2.6, 0.6, 0.6, 0])
        // The front bubble, its tail at the bottom right.
        i.poly([(13.6, 9.0), (20.6, 9.0), (20.6, 20.8), (17.2, 18.2), (9.6, 18.2), (9.6, 9.0)], corners: [2.6, 2.6, 0.7, 0.9, 2.6, 2.6], closed: true)
        i.wave((12.4, 13.6), (17.8, 13.4), amp: 1.0, periods: 1)
        t.blob((6.6, 7.2), 3.6, 3.2, seed: 2)
    }

    static func replyBubble(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(3.4, 4.4), (20.6, 4.4), (20.6, 16.6), (10.6, 16.6), (6.0, 20.6), (6.0, 16.6), (3.4, 16.6)], corners: [2.8, 2.8, 2.8, 0.9, 0.8, 0.9, 2.2], closed: true)
        i.line((7.4, 8.8), (16.6, 8.8), bow: 0.12)
        i.line((7.4, 12.4), (13.4, 12.4), bow: -0.1)
        t.blob((11.6, 10.4), 5.4, 3.0, seed: 1)
    }

    static func thinkBubble(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((13.2, 10.2), 7.8, 6.8)
        i.ring((5.6, 18.2), 1.4, wobble: 0)
        i.dot((3.2, 21.0))
        for x in [9.8, 13.2, 16.6] as [CGFloat] { i.dot((x, 10.4)) }
        t.blob((13.4, 10.4), 5.2, 4.2, seed: 0)
    }

    static func question(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12), 8.8)
        i.smooth([(9.2, 9.4), (10.0, 7.4), (12.2, 6.8), (14.6, 7.8), (14.8, 10.2), (12.6, 12.0), (12.0, 13.8)], tension: 0.9)
        i.dot((12.0, 17.0))
        t.blob((12.2, 12.2), 6.6, 6.6, seed: 1)
    }

    static func person(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 7.4), 4.2)
        i.smooth([(4.4, 21.0), (5.6, 16.8), (8.6, 14.6), (12, 14.2), (15.4, 14.6), (18.4, 16.8), (19.6, 21.0)], tension: 0.9)
        t.blob((12.2, 7.6), 3.6, 3.6, seed: 2)
    }

    static func personCircle(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12), 9.0)
        i.ring((12, 9.6), 3.2)
        i.smooth([(6.4, 19.0), (8.4, 15.8), (12, 14.8), (15.6, 15.8), (17.6, 19.0)], tension: 0.9)
        t.blob((12.2, 9.8), 2.8, 2.8, seed: 0)
    }

    static func people(_ i: inout ArtPen, _ t: inout ArtPen) {
        // The front person, then the one behind (its head ring skips where the front one stands).
        i.ring((9.2, 8.2), 3.8)
        i.smooth([(2.6, 20.2), (3.8, 16.0), (6.4, 14.0), (9.2, 13.6), (12.0, 14.0), (14.6, 16.0), (15.8, 20.2)], tension: 0.9)
        i.ring((16.4, 7.0), 3.0, from: 220, sweep: 260, wobble: 0)
        i.smooth([(16.2, 12.2), (19.0, 13.0), (20.8, 15.4), (21.4, 18.6)], tension: 0.9)
        t.blob((16.6, 7.2), 2.8, 2.8, seed: 1)
    }

    static func folder(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(2.8, 4.8), (9.0, 4.8), (11.0, 7.0), (21.2, 7.0), (21.2, 19.4), (2.8, 19.4)], corners: [2.2, 1.2, 1.2, 2.2, 2.4, 2.4], closed: true)
        i.line((3.1, 10.6), (20.9, 10.6), bow: 0.14)
        t.poly([(3.0, 5.0), (9.0, 5.0), (11.0, 7.2), (12.4, 10.4), (3.0, 10.4)], corner: 1.4, closed: true)
    }

    static func link(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.rotate(-45)
        i.ring((7.6, 12), 3.6, from: 90, sweep: 180, wobble: 0)
        i.poly([(7.6, 8.4), (10.6, 8.4)], corner: 0)
        i.poly([(7.6, 15.6), (10.6, 15.6)], corner: 0)
        i.ring((16.4, 12), 3.6, from: -90, sweep: 180, wobble: 0)
        i.poly([(16.4, 8.4), (13.4, 8.4)], corner: 0)
        i.poly([(16.4, 15.6), (13.4, 15.6)], corner: 0)
        i.line((9.0, 12), (15.0, 12))
        i.rotate(0)
        t.rotate(-45)
        t.blob((7.6, 12), 3.6, 3.2, seed: 2)
        t.rotate(0)
    }

    static func magnifier(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((10.6, 10.6), 6.8)
        i.line((15.6, 15.6), (20.6, 20.6), bow: 0.08)
        t.blob((10.6, 10.6), 4.8, 4.8, seed: 0)
    }

    static func globe(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12), 8.8)
        i.ring((12, 12), 3.8, 8.6, from: -90, wobble: 0.01)
        i.line((3.6, 12.2), (20.4, 12.2), bow: 0.1)
        t.blob((9.2, 9.0), 5.0, 3.8, seed: 2, tilt: -25)
    }
}
