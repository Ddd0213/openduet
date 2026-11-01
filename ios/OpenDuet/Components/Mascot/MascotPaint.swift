// Draws one MascotFace frame into a SwiftUI Canvas (M29): the floor shadow, the body, the eyes,
// always through MascotFace.drawing, with the small-size eye weight. MascotStill is a fixed frame
// (launch, sign-in, onboarding, the notification tile); DuetMascot animates.
import SwiftUI

enum MascotPaint {
    static let bodyColor = Color(hex: MascotFace.bodyRGB)
    static let eyeColor = Color(hex: MascotFace.eyeRGB)

    /// The frame that holds a circle of `diameter` and every pose, hop and squash around it
    /// (MascotFace.extent: 2.4 R wide), with the circle in the middle (1.45 R above and below,
    /// so a centred mascot sits centred in a circle or a tile).
    static func frame(_ diameter: CGFloat) -> CGSize {
        CGSize(width: diameter * 1.2, height: diameter * 1.45)
    }

    static func draw(_ face: MascotFace, diameter: CGFloat, in gc: inout GraphicsContext, size: CGSize) {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let drawing = face.drawing(center: center, radius: Double(diameter) / 2,
                                   eyeWeight: MascotFace.eyeWeight(diameter: Double(diameter)))
        if let shadow = drawing.shadow {
            gc.fill(Path(shadow), with: .color(.black.opacity(drawing.shadowAlpha)))
        }
        gc.fill(Path(drawing.body), with: .color(bodyColor))
        gc.fill(Path(drawing.eyes), with: .color(eyeColor))
    }
}

/// One still frame of the mascot (default: the neutral face), centred in its own frame.
struct MascotStill: View {
    var face: MascotFace = .neutral
    var size: CGFloat = 30
    /// The canvas; nil = MascotPaint.frame(size).
    var frame: CGSize?

    var body: some View {
        let box = frame ?? MascotPaint.frame(size)
        Canvas { gc, canvas in
            MascotPaint.draw(face, diameter: size, in: &gc, size: canvas)
        }
        .frame(width: box.width, height: box.height)
        .accessibilityHidden(true)
    }
}
