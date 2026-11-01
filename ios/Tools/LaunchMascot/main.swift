// Renders the launch-screen image (prompt L185, M29): the still neutral face exactly as LaunchView
// draws it (MascotSwoop(size: 64, animated: false)): a 64 pt circle centred on a transparent
// 80 x 80 pt canvas (MascotSwoop.canvas), drawn through the shared MascotFace, so the system
// launch screen centres it where LaunchView does and the hand-over has no jump. The face is the
// same in light and dark mode; both variants are written so the image set stays as it is.
//
//   cd ios && xcrun swiftc -swift-version 6 OpenDuet/Components/Mascot/MascotFace.swift \
//     Tools/LaunchMascot/main.swift -o /tmp/launchmascot && /tmp/launchmascot \
//     OpenDuet/Resources/Assets.xcassets/LaunchMascot.imageset
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let directory = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
// MascotSwoop.canvas(64): 64 x 1.25.
let canvas = CGSize(width: 80, height: 80)
let diameter = 64.0

func render(scale: Int, to name: String) {
    let width = Int(canvas.width) * scale, height = Int(canvas.height) * scale
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let gc = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                             space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fatalError("could not create the bitmap context") }

    // Points, y-down, as MascotFace draws.
    gc.translateBy(x: 0, y: CGFloat(height))
    gc.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))
    gc.clear(CGRect(origin: .zero, size: canvas))

    let center = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
    MascotFace.neutral
        .drawing(center: center, radius: diameter / 2, eyeWeight: MascotFace.eyeWeight(diameter: diameter))
        .fill(in: gc)

    let url = URL(fileURLWithPath: directory).appendingPathComponent(name)
    guard let image = gc.makeImage(),
          let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { fatalError("could not create \(name)") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
    print("wrote \(url.path) (\(width)x\(height))")
}

for scale in [2, 3] {
    render(scale: scale, to: "LaunchMascot@\(scale)x.png")
    render(scale: scale, to: "LaunchMascot-dark@\(scale)x.png")
}
