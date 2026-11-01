// The Build view's pieces (prompt L150, L187): the skeleton card (pulsing grey blocks shaped
// like the type), the orange progress line running around its border, and the disabled
// "OpenDuet is working on it..." pill that stands in for the composer. Reduce Motion: the line
// holds still and breathes, the blocks don't pulse.
import SwiftUI

/// Grey blocks in the layout of a type (unit coordinates, portrait card).
struct BuildSkeleton: View {
    var type: ArtifactType

    var body: some View {
        Canvas { context, size in
            for block in Self.blocks(type) {
                let rect = CGRect(x: block.minX * size.width, y: block.minY * size.height, width: block.width * size.width, height: block.height * size.height)
                let corner = min(rect.height / 2, 10)
                context.fill(Path(roundedRect: rect, cornerRadius: corner, style: .continuous), with: .color(Palette.skeleton))
            }
        }
        .skeletonPulse()
        .accessibilityHidden(true)
    }

    static func blocks(_ type: ArtifactType) -> [CGRect] {
        func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect { CGRect(x: x, y: y, width: w, height: h) }
        switch type {
        case .dashboard:
            return [r(0.07, 0.05, 0.5, 0.045), r(0.07, 0.115, 0.32, 0.03),
                    r(0.07, 0.19, 0.27, 0.13), r(0.365, 0.19, 0.27, 0.13), r(0.66, 0.19, 0.27, 0.13),
                    r(0.07, 0.36, 0.86, 0.28),
                    r(0.07, 0.68, 0.86, 0.06), r(0.07, 0.76, 0.86, 0.06), r(0.07, 0.84, 0.6, 0.06)]
        case .docs:
            var blocks = [r(0.1, 0.06, 0.62, 0.05), r(0.1, 0.13, 0.36, 0.03)]
            let widths: [CGFloat] = [0.8, 0.76, 0.8, 0.5, 0.8, 0.72, 0.8, 0.4, 0.78, 0.8, 0.62]
            for (i, w) in widths.enumerated() { blocks.append(r(0.1, 0.21 + CGFloat(i) * 0.067, w, 0.028)) }
            return blocks
        case .slides:
            return [r(0.07, 0.06, 0.86, 0.48), r(0.07, 0.6, 0.27, 0.15), r(0.365, 0.6, 0.27, 0.15), r(0.66, 0.6, 0.27, 0.15),
                    r(0.07, 0.81, 0.5, 0.04), r(0.07, 0.88, 0.34, 0.03)]
        case .webPage:
            return [r(0.07, 0.04, 0.86, 0.04), r(0.07, 0.12, 0.86, 0.3), r(0.2, 0.46, 0.6, 0.04), r(0.3, 0.52, 0.4, 0.03),
                    r(0.07, 0.6, 0.27, 0.22), r(0.365, 0.6, 0.27, 0.22), r(0.66, 0.6, 0.27, 0.22), r(0.07, 0.87, 0.86, 0.06)]
        case .design:
            return [r(0.07, 0.05, 0.86, 0.66), r(0.07, 0.76, 0.56, 0.05), r(0.07, 0.84, 0.36, 0.04)]
        case .designSystem:
            var blocks = [r(0.07, 0.05, 0.5, 0.045)]
            for col in 0..<5 { blocks.append(r(0.07 + CGFloat(col) * 0.176, 0.14, 0.14, 0.09)) }
            blocks += [r(0.07, 0.3, 0.7, 0.05), r(0.07, 0.38, 0.55, 0.04), r(0.07, 0.45, 0.42, 0.03),
                       r(0.07, 0.54, 0.4, 0.07), r(0.53, 0.54, 0.4, 0.07), r(0.07, 0.66, 0.86, 0.26)]
            return blocks
        }
    }
}

/// An orange line running around a rounded rectangle's perimeter (the build is in progress).
struct ProgressPerimeter: View {
    var corner: CGFloat
    var lineWidth: CGFloat = 3
    var color: Color = Palette.justMade
    /// One lap, in seconds.
    var period: Double = 2.6
    /// The lit part of the perimeter, 0...1.
    var length: CGFloat = 0.22

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            // Holds still: the whole border breathes softly instead.
            TimelineView(.animation(minimumInterval: 1 / 15)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .strokeBorder(color.opacity(0.35 + 0.25 * (sin(t * 1.6) + 1) / 2), lineWidth: lineWidth)
            }
            .accessibilityHidden(true)
        } else {
            TimelineView(.animation) { context in
                let phase = CGFloat(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period)
                let end = phase + length
                ZStack {
                    segment(from: phase, to: min(end, 1))
                    if end > 1 { segment(from: 0, to: end - 1) }
                }
            }
            .accessibilityHidden(true)
        }
    }

    private func segment(from: CGFloat, to: CGFloat) -> some View {
        InsetRoundedRect(corner: corner, inset: lineWidth / 2)
            .trim(from: from, to: to)
            .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
    }
}

/// A rounded rectangle inset by half the stroke, so the line sits on the card's edge.
private struct InsetRoundedRect: Shape {
    var corner: CGFloat
    var inset: CGFloat

    func path(in rect: CGRect) -> Path {
        Path(roundedRect: rect.insetBy(dx: inset, dy: inset), cornerRadius: max(corner - inset, 0), style: .continuous)
    }
}

/// The composer's stand-in while the assistant builds: a disabled pill with a spinner.
struct WorkingPill: View {
    var title: Text = Text("OpenDuet is working on it...")

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 16

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .tint(Palette.secondaryText)
            title
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.secondaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity, minHeight: 48)
        .chromeSurface(Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}
