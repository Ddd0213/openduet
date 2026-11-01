// The big outline drawing of a Make type (prompt L147, L149): the hero card and the Describe
// sheet show it above the composer. Thin strokes in the type's tint, drawn in a 4:3 box; the
// Build view's skeleton uses the same layouts as filled blocks (SkeletonLayout).
import SwiftUI

struct TypeIllustration: View {
    var type: ArtifactType
    var lineWidth: CGFloat = 2

    var body: some View {
        Canvas { context, size in
            let box = CGRect(origin: .zero, size: size).insetBy(dx: lineWidth, dy: lineWidth)
            let style = StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
            let ink = GraphicsContext.Shading.color(type.tint.opacity(0.85))
            let soft = GraphicsContext.Shading.color(type.tint.opacity(0.35))
            for part in Self.parts(type, in: box) {
                context.stroke(part.path, with: part.strong ? ink : soft, style: style)
            }
        }
        .aspectRatio(4 / 3, contentMode: .fit)
        .accessibilityHidden(true)
    }

    struct Part {
        var path: Path
        var strong = true
    }

    /// The drawing in unit coordinates (0...1 both ways) mapped into `box`.
    static func parts(_ type: ArtifactType, in box: CGRect) -> [Part] {
        func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, corner: CGFloat = 0.03) -> Path {
            let rect = CGRect(x: box.minX + x * box.width, y: box.minY + y * box.height, width: w * box.width, height: h * box.height)
            return Path(roundedRect: rect, cornerRadius: corner * min(box.width, box.height) * 3, style: .continuous)
        }
        func line(_ points: [(CGFloat, CGFloat)]) -> Path {
            var path = Path()
            for (i, p) in points.enumerated() {
                let point = CGPoint(x: box.minX + p.0 * box.width, y: box.minY + p.1 * box.height)
                if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            return path
        }
        func dot(_ x: CGFloat, _ y: CGFloat, _ d: CGFloat) -> Path {
            let s = d * min(box.width, box.height)
            return Path(ellipseIn: CGRect(x: box.minX + x * box.width - s / 2, y: box.minY + y * box.height - s / 2, width: s, height: s))
        }
        switch type {
        case .webPage:
            return [
                Part(path: r(0.06, 0.06, 0.88, 0.88)),
                Part(path: line([(0.06, 0.2), (0.94, 0.2)])),
                Part(path: dot(0.12, 0.13, 0.04)), Part(path: dot(0.17, 0.13, 0.04)), Part(path: dot(0.22, 0.13, 0.04)),
                Part(path: r(0.14, 0.28, 0.72, 0.22), strong: false),
                Part(path: line([(0.24, 0.36), (0.6, 0.36)])), Part(path: line([(0.24, 0.42), (0.48, 0.42)]), strong: false),
                Part(path: r(0.14, 0.58, 0.22, 0.28), strong: false), Part(path: r(0.39, 0.58, 0.22, 0.28), strong: false),
                Part(path: r(0.64, 0.58, 0.22, 0.28), strong: false),
            ]
        case .docs:
            var page = Path()
            page.addPath(line([(0.28, 0.04), (0.64, 0.04), (0.74, 0.16), (0.74, 0.96), (0.28, 0.96), (0.28, 0.04)]))
            var parts = [Part(path: page), Part(path: line([(0.64, 0.04), (0.64, 0.16), (0.74, 0.16)]))]
            parts.append(Part(path: line([(0.35, 0.24), (0.58, 0.24)])))
            let widths: [CGFloat] = [0.32, 0.3, 0.26, 0.32, 0.18, 0.3, 0.24]
            for (i, w) in widths.enumerated() {
                let y = 0.36 + CGFloat(i) * 0.08
                parts.append(Part(path: line([(0.35, y), (0.35 + w, y)]), strong: false))
            }
            return parts
        case .slides:
            return [
                Part(path: r(0.16, 0.06, 0.78, 0.6), strong: false),
                Part(path: r(0.06, 0.18, 0.78, 0.6)),
                Part(path: line([(0.14, 0.3), (0.46, 0.3)])),
                Part(path: line([(0.2, 0.68), (0.2, 0.52)]), strong: false), Part(path: line([(0.3, 0.68), (0.3, 0.44)]), strong: false),
                Part(path: line([(0.4, 0.68), (0.4, 0.56)]), strong: false), Part(path: line([(0.5, 0.68), (0.5, 0.4)]), strong: false),
                Part(path: dot(0.68, 0.54, 0.16), strong: false),
                Part(path: line([(0.3, 0.9), (0.6, 0.9)]), strong: false),
            ]
        case .dashboard:
            return [
                Part(path: r(0.06, 0.06, 0.88, 0.88)),
                Part(path: r(0.12, 0.14, 0.22, 0.2), strong: false), Part(path: r(0.39, 0.14, 0.22, 0.2), strong: false),
                Part(path: r(0.66, 0.14, 0.22, 0.2), strong: false),
                Part(path: line([(0.12, 0.8), (0.26, 0.62), (0.4, 0.7), (0.56, 0.5), (0.7, 0.58), (0.88, 0.42)])),
                Part(path: line([(0.12, 0.86), (0.88, 0.86)]), strong: false),
            ]
        case .design:
            return [
                Part(path: r(0.08, 0.06, 0.84, 0.88)),
                Part(path: dot(0.36, 0.42, 0.34), strong: false),
                Part(path: line([(0.5, 0.78), (0.66, 0.46), (0.82, 0.78), (0.5, 0.78)]), strong: false),
                Part(path: line([(0.62, 0.16), (0.86, 0.4)])), Part(path: line([(0.6, 0.12), (0.66, 0.18)])),
            ]
        case .designSystem:
            var parts = [Part(path: r(0.06, 0.06, 0.88, 0.88))]
            for row in 0..<2 {
                for col in 0..<4 {
                    parts.append(Part(path: dot(0.2 + CGFloat(col) * 0.2, 0.26 + CGFloat(row) * 0.2, 0.12), strong: row == 0))
                }
            }
            parts.append(Part(path: line([(0.14, 0.68), (0.5, 0.68)])))
            parts.append(Part(path: line([(0.14, 0.78), (0.4, 0.78)]), strong: false))
            parts.append(Part(path: line([(0.14, 0.86), (0.32, 0.86)]), strong: false))
            parts.append(Part(path: r(0.6, 0.66, 0.26, 0.2, corner: 0.06), strong: false))
            return parts
        }
    }
}
