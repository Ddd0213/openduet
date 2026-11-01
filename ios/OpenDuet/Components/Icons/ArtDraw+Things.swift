// Drawings: things, places and money (DuetArt). `i` = ink, `t` = accent (see ArtDraw.swift).
import SwiftUI

extension ArtDraw {
    static func chartLine(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(3.6, 3.8), (3.6, 20.4), (20.6, 20.4)], corner: 2.2)
        i.poly([(7.4, 15.6), (11.0, 11.2), (14.0, 13.6), (19.6, 6.4)], corner: 1.4)
        t.poly([(6.8, 16.8), (11.0, 11.8), (14.0, 14.2), (19.4, 7.6), (19.4, 19.6), (6.8, 19.6)], corner: 1.2, closed: true)
    }

    static func bars(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(3.6, 12.6, 7.4, 20.4, r: 1.6, bows: (0, 0, 0, 0))
        i.box(10.1, 8.0, 13.9, 20.4, r: 1.6, bows: (0, 0, 0, 0))
        i.box(16.6, 3.6, 20.4, 20.4, r: 1.6, bows: (0, 0, 0, 0))
        t.band(16.6, 3.8, 20.4, 20.4)
    }

    static func banknote(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(2.6, 6.0, 21.4, 18.0, r: 2.6)
        i.ring((12, 12), 2.8)
        i.dot((6.2, 12))
        i.dot((17.8, 12))
        t.blob((12.2, 12.2), 3.6, 3.4, seed: 1)
    }

    static func coin(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.ring((12, 12), 8.8)
        i.smooth([(14.6, 8.8), (12.4, 7.8), (9.8, 8.6), (9.8, 10.8), (12, 12), (14.2, 13.2), (14.2, 15.4), (11.6, 16.2), (9.4, 15.2)], tension: 0.95)
        i.line((12, 5.6), (12, 7.0))
        i.line((12, 17.0), (12, 18.4))
        t.blob((12.2, 12.2), 6.6, 6.6, seed: 0)
    }

    static func cart(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(2.6, 3.6), (4.6, 3.6), (7.2, 14.8), (18.2, 14.8), (20.4, 7.0), (5.6, 7.0)], corners: [0, 0.9, 1.4, 1.4, 1.0, 0])
        i.ring((8.6, 19.0), 1.5, wobble: 0)
        i.ring((16.6, 19.0), 1.5, wobble: 0)
        t.poly([(6.2, 7.6), (19.6, 7.6), (17.8, 14.2), (7.8, 14.2)], corner: 1.4, closed: true)
    }

    static func gift(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(4.4, 11.4, 19.6, 20.6, r: 2.2)
        i.box(3.2, 7.6, 20.8, 11.4, r: 1.6, bows: (0, 0, 0, 0))
        i.line((12, 7.8), (12, 20.4))
        i.smooth([(12, 7.4), (9.2, 3.8), (7.0, 4.6), (7.6, 6.8), (12, 7.4)], tension: 0.9)
        i.smooth([(12, 7.4), (14.8, 3.8), (17.0, 4.6), (16.4, 6.8), (12, 7.4)], tension: 0.9)
        t.band(10.2, 7.8, 13.8, 20.4)
    }

    static func mapPin(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.smooth([(12, 21.0), (9.0, 17.4), (5.6, 12.6), (5.4, 8.4), (8.0, 4.2), (12, 3.0), (16.0, 4.2), (18.6, 8.4), (18.4, 12.6), (15.0, 17.4), (12, 21.0)], tension: 0.95)
        i.ring((12, 9.4), 2.6, wobble: 0)
        t.blob((12.2, 9.8), 4.6, 4.8, seed: 2)
    }

    static func house(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(2.8, 11.2), (12, 3.2), (21.2, 11.2)], corner: 1.6)
        i.poly([(5.4, 9.8), (5.4, 20.6), (18.6, 20.6), (18.6, 9.8)], corners: [0, 2.2, 2.2, 0])
        i.poly([(10.0, 20.4), (10.0, 15.0), (14.0, 15.0), (14.0, 20.4)], corners: [0, 1.4, 1.4, 0])
        t.poly([(9.6, 20.6), (9.6, 14.8), (14.4, 14.8), (14.4, 20.6)], corner: 1.2, closed: true)
    }

    static func plane(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.rotate(45, nudge: (1.1, -1.1))
        i.poly([
            (12, 3.0), (13.3, 5.4), (13.3, 10.6), (21.0, 15.0), (21.0, 16.6), (13.3, 14.4), (13.3, 18.6),
            (15.8, 20.4), (15.8, 21.4), (12, 20.4), (8.2, 21.4), (8.2, 20.4), (10.7, 18.6), (10.7, 14.4),
            (3.0, 16.6), (3.0, 15.0), (10.7, 10.6), (10.7, 5.4),
        ], corners: [1.3, 0.8, 0.6, 0.8, 0.6, 0.6, 0.6, 0.5, 0.5, 0.6, 0.5, 0.5, 0.6, 0.6, 0.6, 0.8, 0.6, 0.8], closed: true)
        i.rotate(0)
        t.rotate(45, nudge: (1.1, -1.1))
        t.band(4.0, 12.4, 20.0, 15.4)
        t.rotate(0)
    }

    static func book(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.move((12, 6.6))
        i.curve((2.8, 5.2), (9.6, 4.8), (5.4, 4.6))
        i.to((2.8, 18.0))
        i.curve((12, 19.6), (5.4, 17.6), (9.6, 17.8))
        i.move((12, 6.6))
        i.curve((21.2, 5.2), (14.4, 4.8), (18.6, 4.6))
        i.to((21.2, 18.0))
        i.curve((12, 19.6), (18.6, 17.6), (14.4, 17.8))
        i.line((12, 6.8), (12, 19.4))
        t.move((12.4, 7.0))
        t.curve((20.6, 5.8), (14.6, 5.4), (18.4, 5.2))
        t.to((20.6, 17.6))
        t.curve((12.4, 19.0), (18.2, 17.4), (14.4, 17.4))
        t.close()
    }

    static func notebook(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(4.6, 3.0, 19.4, 21.0, r: 2.4)
        i.line((8.4, 3.3), (8.4, 20.7))
        i.poly([(13.2, 3.3), (13.2, 9.0), (14.9, 7.6), (16.6, 9.0), (16.6, 3.3)], corners: [0, 0.5, 0.4, 0.5, 0])
        t.band(4.8, 3.2, 8.4, 20.8)
    }

    static func tray(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(6.6, 4.6), (17.4, 4.6), (20.8, 13.0), (20.8, 19.4), (3.2, 19.4), (3.2, 13.0)], corners: [1.6, 1.6, 1.4, 2.4, 2.4, 1.4], closed: true)
        i.poly([(3.6, 13.0), (8.4, 13.0), (9.6, 15.4), (14.4, 15.4), (15.6, 13.0), (20.4, 13.0)], corners: [0, 0.9, 0.9, 0.9, 0.9, 0])
        t.poly([(3.4, 13.4), (8.2, 13.4), (9.4, 15.8), (14.6, 15.8), (15.8, 13.4), (20.6, 13.4), (20.6, 19.2), (3.4, 19.2)], corner: 1.6, closed: true)
    }

    static func archive(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.box(2.8, 4.0, 21.2, 8.6, r: 1.6, bows: (0, 0, 0, 0))
        i.poly([(4.4, 8.8), (4.4, 20.4), (19.6, 20.4), (19.6, 8.8)], corners: [0, 2.2, 2.2, 0])
        i.line((9.8, 12.6), (14.2, 12.6))
        t.band(3.0, 4.2, 21.0, 8.6)
    }

    static func stack(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(3.2, 13.4), (3.2, 3.2), (14.4, 3.2), (14.4, 6.0)], corners: [0, 2.4, 2.4, 0])
        i.box(7.6, 7.6, 20.8, 20.8, r: 2.6)
        t.poly([(3.4, 3.4), (14.2, 3.4), (14.2, 7.4), (7.4, 7.4), (7.4, 13.2), (3.4, 13.2)], corner: 1.6, closed: true)
    }

    static func cube(_ i: inout ArtPen, _ t: inout ArtPen) {
        i.poly([(12, 2.8), (20.0, 7.4), (20.0, 16.6), (12, 21.2), (4.0, 16.6), (4.0, 7.4)], corner: 1.6, closed: true)
        i.poly([(4.4, 7.6), (12, 12.0), (19.6, 7.6)], corner: 0.8)
        i.line((12, 12.0), (12, 20.8))
        t.poly([(12, 3.4), (19.2, 7.6), (12, 11.6), (4.8, 7.6)], corner: 1.4, closed: true)
    }
}
