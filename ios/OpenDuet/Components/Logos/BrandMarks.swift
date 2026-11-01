// Small vector stand-ins for the app marks the onboarding draws (prompt L21, L23, L29).
// Drawn in code (no image assets); each fills a square frame.
import SwiftUI

/// Google Drive's tri-colour triangle (green left, blue bottom, yellow right).
struct DriveMark: View {
    var body: some View {
        Canvas { gc, size in
            let w = size.width, h = size.height * 0.9, top = size.height * 0.05
            let outer = [CGPoint(x: w / 2, y: top), CGPoint(x: 0, y: top + h), CGPoint(x: w, y: top + h)]
            let c = CGPoint(x: w / 2, y: top + h * 2 / 3)
            let inner = outer.map { CGPoint(x: c.x + ($0.x - c.x) * 0.36, y: c.y + ($0.y - c.y) * 0.36) }
            let bands: [(Int, Int, UInt32)] = [(0, 1, 0x0F9D58), (1, 2, 0x4285F4), (2, 0, 0xF4B400)]
            for (a, b, color) in bands {
                var p = Path()
                p.addLines([outer[a], outer[b], inner[b], inner[a]])
                p.closeSubpath()
                gc.fill(p, with: .color(Color(hex: color)))
            }
        }
    }
}

/// Gmail's M: blue and green legs, a red chevron, yellow and dark red corners.
struct GmailMark: View {
    var body: some View {
        Canvas { gc, size in
            let w = size.width, h = size.height
            let leg = w * 0.2, top = h * 0.2, bottom = h * 0.84
            // A loop, not a helper closure: a closure can't capture the inout context.
            for (x, color) in [(CGFloat(0), UInt32(0x4285F4)), (w - leg, UInt32(0x34A853))] {
                gc.fill(Path(roundedRect: CGRect(x: x, y: top, width: leg, height: bottom - top), cornerRadius: leg * 0.3), with: .color(Color(hex: color)))
            }
            var chevron = Path()
            chevron.move(to: CGPoint(x: leg / 2, y: top + leg * 0.4))
            chevron.addLine(to: CGPoint(x: w / 2, y: h * 0.56))
            chevron.addLine(to: CGPoint(x: w - leg / 2, y: top + leg * 0.4))
            gc.stroke(chevron, with: .color(Color(hex: 0xEA4335)), style: StrokeStyle(lineWidth: leg, lineCap: .round, lineJoin: .round))
            gc.fill(Path(ellipseIn: CGRect(x: w - leg, y: top - leg * 0.1, width: leg, height: leg)), with: .color(Color(hex: 0xFBBC04)))
            gc.fill(Path(ellipseIn: CGRect(x: 0, y: top - leg * 0.1, width: leg, height: leg)), with: .color(Color(hex: 0xC5221F)))
        }
    }
}

/// Google Calendar's blue "31" tile.
struct CalendarMark: View {
    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            RoundedRectangle(cornerRadius: s * 0.22, style: .continuous)
                .fill(Color(hex: 0x4285F4))
                .overlay(
                    // A logo glyph, not UI text: never localized.
                    Text(verbatim: "31")
                        .font(.system(size: s * 0.52, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .minimumScaleFactor(0.5)
                )
        }
    }
}

/// GitHub: a black circle with a white cat head.
struct GitHubMark: View {
    var body: some View {
        Canvas { gc, size in
            let s = min(size.width, size.height)
            gc.fill(Path(ellipseIn: CGRect(x: 0, y: 0, width: s, height: s)), with: .color(Color(hex: 0x181717)))
            var cat = Path()
            cat.addEllipse(in: CGRect(x: s * 0.26, y: s * 0.3, width: s * 0.48, height: s * 0.4))
            cat.move(to: CGPoint(x: s * 0.29, y: s * 0.42))
            cat.addLine(to: CGPoint(x: s * 0.3, y: s * 0.2))
            cat.addLine(to: CGPoint(x: s * 0.44, y: s * 0.32))
            cat.move(to: CGPoint(x: s * 0.71, y: s * 0.42))
            cat.addLine(to: CGPoint(x: s * 0.7, y: s * 0.2))
            cat.addLine(to: CGPoint(x: s * 0.56, y: s * 0.32))
            cat.addRoundedRect(in: CGRect(x: s * 0.42, y: s * 0.62, width: s * 0.16, height: s * 0.24), cornerSize: CGSize(width: s * 0.05, height: s * 0.05))
            gc.fill(cat, with: .color(.white))
        }
    }
}

/// Slack's four-colour mark: a bar and a dot per colour, turned 90° each.
struct SlackMark: View {
    var body: some View {
        Canvas { gc, size in
            let s = min(size.width, size.height)
            let w = s * 0.18, gap = s * 0.025
            let colors: [UInt32] = [0x36C5F0, 0x2EB67D, 0xECB22E, 0xE01E5A]
            for (i, color) in colors.enumerated() {
                var piece = Path()
                let barY = s / 2 - gap / 2 - w
                piece.addRoundedRect(in: CGRect(x: s * 0.04, y: barY, width: s / 2 - gap / 2 - s * 0.04, height: w), cornerSize: CGSize(width: w / 2, height: w / 2))
                piece.addEllipse(in: CGRect(x: s / 2 - gap / 2 - w, y: barY - gap - w, width: w, height: w))
                let turn = CGAffineTransform(translationX: s / 2, y: s / 2)
                    .rotated(by: CGFloat(i) * .pi / 2)
                    .translatedBy(x: -s / 2, y: -s / 2)
                gc.fill(piece.applying(turn), with: .color(Color(hex: color)))
            }
        }
    }
}
