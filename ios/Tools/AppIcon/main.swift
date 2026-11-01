// Renders the OpenDuet app icon candidates (M29). Every face comes from the shared MascotFace
// (OpenDuet/Components/Mascot/MascotFace.swift): a candidate only picks where the circle sits,
// how big it is (the canvas crops it), and a pose within MascotFace's documented ranges. No eye
// or body is drawn here.
//
// Appearances, per Apple's iOS 18 icon variants:
//   light   1024x1024 RGB, opaque, square full bleed (the system applies the rounded mask).
//   dark    1024x1024 RGBA, transparent background (the system puts its dark gradient behind
//           it); body #C7604A and eyes #141413 as in light, the floor shadow turns light.
//   tinted  1024x1024 grayscale + alpha, transparent background; the system tints by luminance,
//           so the body is white (full tint) and the eyes black.
//
//   cd ios && xcrun swiftc -swift-version 6 OpenDuet/Components/Mascot/MascotFace.swift \
//     Tools/AppIcon/main.swift -o /tmp/appicon
//   /tmp/appicon C3 light out.png           one candidate (C0...C6), light / dark / tinted
//   /tmp/appicon C3 light out.png --white   the light icon on pure white instead of #F7F3EE
//   /tmp/appicon all <directory>            every candidate: C<n>-light|dark|tinted.png, the
//                                           pure white C1-C5 as C<n>-light-white.png, and
//                                           contact-sheet.png; prints an eye / mask check
// The user chose C4 (2026-10-30). AppIcon.appiconset holds its three appearances:
//   S=OpenDuet/Resources/Assets.xcassets/AppIcon.appiconset
//   /tmp/appicon C4 light $S/AppIcon-1024.png; /tmp/appicon C4 dark $S/AppIcon-1024-dark.png
//   /tmp/appicon C4 tinted $S/AppIcon-1024-tinted.png
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum Look: String, CaseIterable, Sendable { case light, dark, tinted }

/// One composition, in fractions of the icon side (y down).
struct Candidate: Sendable {
    let id: String
    /// The contact sheet's caption.
    let label: String
    let face: MascotFace
    /// The circle's resting centre and radius.
    let cx: Double, cy: Double, r: Double
    /// Light background #F7F3EE (warm, with a pure white variant for comparison) or #FFFFFF.
    let warm: Bool
}

enum Icon {
    static let side = 1024
    static let warmRGB: UInt32 = 0xF7F3EE
    static let whiteRGB: UInt32 = 0xFFFFFF
    /// Slightly heavier eyes so the 29 pt (87 px) icon still reads; MascotFace thickens only the
    /// short side of each eye.
    static let eyeWeight = 1.15

    static let candidates: [Candidate] = [
        Candidate(id: "C0", label: "对照：白底居中正脸",
                  face: .neutral, cx: 0.5, cy: 0.5, r: 0.3, warm: false),
        Candidate(id: "C1", label: "从右边探头，看向左边",
                  face: MascotFace(yaw: -26, pitch: -4, tilt: -7),
                  cx: 0.816, cy: 0.55, r: 0.46, warm: true),
        Candidate(id: "C2", label: "从下边探头，往上看",
                  face: MascotFace(yaw: -10, pitch: -25, spread: 1.04),
                  cx: 0.56, cy: 0.915, r: 0.42, warm: true),
        Candidate(id: "C3", label: "侧过脸，看右上",
                  face: MascotFace(yaw: 30, pitch: -12, tilt: 6),
                  cx: 0.42, cy: 0.58, r: 0.37, warm: true),
        Candidate(id: "C4", label: "从左下角出画，看右上",
                  face: MascotFace(yaw: 26, pitch: -20, tilt: 10),
                  cx: 0.32, cy: 0.70, r: 0.60, warm: true),
        Candidate(id: "C5", label: "跳起来的瞬间，看一边",
                  face: MascotFace(yaw: -18, pitch: -6, eyeHeight: 1.1, tilt: -8, squash: -0.05, hop: 0.22),
                  cx: 0.5, cy: 0.523, r: 0.31, warm: true),
        Candidate(id: "C6", label: "橙色铺满，凑近看你",
                  face: MascotFace(yaw: -12, pitch: -8, tilt: -4),
                  cx: 0.5, cy: 0.52, r: 0.74, warm: true),
    ]
}

// MARK: - Rendering

func bitmap(_ side: Int, opaque: Bool = false) -> CGContext {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
    guard let gc = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
                             space: space, bitmapInfo: info)
    else { fatalError("could not create a \(side) px bitmap") }
    gc.interpolationQuality = .high
    return gc
}

/// The candidate's mascot in pixels of a `side` px icon, y down.
func drawing(_ c: Candidate, side: Double = Double(Icon.side)) -> MascotDrawing {
    c.face.drawing(center: CGPoint(x: c.cx * side, y: c.cy * side), radius: c.r * side, eyeWeight: Icon.eyeWeight)
}

/// MascotDrawing.fill's order (shadow, body, eyes) with other colours, for dark and tinted.
func fill(_ d: MascotDrawing, in gc: CGContext, body: CGColor, eyes: CGColor, shadow: CGColor) {
    if let path = d.shadow {
        gc.addPath(path)
        gc.setFillColor(shadow)
        gc.fillPath()
    }
    gc.addPath(d.body)
    gc.setFillColor(body)
    gc.fillPath()
    gc.addPath(d.eyes)
    gc.setFillColor(eyes)
    gc.fillPath()
}

/// The icon: light is opaque on its background; dark and tinted keep a transparent background.
func render(_ c: Candidate, _ look: Look, white: Bool = false, side: Int = Icon.side) -> CGImage {
    let gc = renderContext(c, look, white: white, side: side)
    if look == .tinted { return grayAlpha(gc) }
    guard let image = gc.makeImage() else { fatalError("could not make the image") }
    return image
}

/// The icon drawn into an sRGB context (tinted: gray values only), row 0 at the top.
func renderContext(_ c: Candidate, _ look: Look, white: Bool = false, side: Int = Icon.side) -> CGContext {
    let gc = bitmap(side, opaque: look == .light)
    gc.translateBy(x: 0, y: CGFloat(side))  // y down, as MascotFace draws
    gc.scaleBy(x: 1, y: -1)
    let s = Double(side)
    let d = drawing(c, side: s)
    switch look {
    case .light:
        gc.setFillColor(MascotFace.color(white || !c.warm ? Icon.whiteRGB : Icon.warmRGB))
        gc.fill(CGRect(x: 0, y: 0, width: s, height: s))
        d.fill(in: gc)
    case .dark:
        // Same body and eyes; the black floor shadow would vanish on the dark backdrop.
        fill(d, in: gc, body: MascotFace.color(MascotFace.bodyRGB), eyes: MascotFace.color(MascotFace.eyeRGB),
             shadow: CGColor(gray: 1, alpha: CGFloat(d.shadowAlpha * 1.5)))
    case .tinted:
        fill(d, in: gc, body: CGColor(gray: 1, alpha: 1), eyes: CGColor(gray: 0, alpha: 1),
             shadow: CGColor(gray: 1, alpha: CGFloat(d.shadowAlpha * 2)))
    }
    return gc
}

/// A gray + alpha image from an RGBA context whose colours are all gray (the tinted icon).
func grayAlpha(_ gc: CGContext) -> CGImage {
    guard let src = gc.data?.assumingMemoryBound(to: UInt8.self) else { fatalError("no bitmap data") }
    let w = gc.width, h = gc.height, row = gc.bytesPerRow
    var out = [UInt8](repeating: 0, count: w * h * 2)
    for y in 0..<h {
        for x in 0..<w {
            out[(y * w + x) * 2] = src[y * row + x * 4]
            out[(y * w + x) * 2 + 1] = src[y * row + x * 4 + 3]
        }
    }
    guard let provider = CGDataProvider(data: Data(out) as CFData),
          let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 16, bytesPerRow: w * 2,
                              space: CGColorSpace(name: CGColorSpace.genericGrayGamma2_2)!,
                              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                              provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    else { fatalError("could not make the gray image") }
    return image
}

func writePNG(_ image: CGImage, _ path: String) {
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                                     UTType.png.identifier as CFString, 1, nil)
    else { fatalError("could not create \(path)") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(path)") }
}

// MARK: - The home screen mask and the eye check

/// The iOS icon outline on a square of `side` at (x, y): a rounded square whose corners take
/// 22.37% of the side and ease into the edges with continuous curvature (a straight run, a
/// clothoid-like cubic, a short arc, mirrored), close to the system's squircle.
func iconMask(_ side: Double, x: Double = 0, y: Double = 0) -> CGPath {
    let r = 0.2237 * side
    let a = 1.528665 * r, b = 1.08849296 * r, c = 0.86840694 * r, d = 0.63149379 * r
    let e = 0.37282383 * r, f = 0.07491139 * r, g = 0.16905956 * r
    let path = CGMutablePath()
    // Each corner as (corner point, unit vector into the corner along the incoming edge, unit
    // vector out of it along the next edge), going round the square.
    let corners: [(CGPoint, (Double, Double), (Double, Double))] = [
        (CGPoint(x: x + side, y: y), (1, 0), (0, 1)),
        (CGPoint(x: x + side, y: y + side), (0, 1), (-1, 0)),
        (CGPoint(x: x, y: y + side), (-1, 0), (0, -1)),
        (CGPoint(x: x, y: y), (0, -1), (1, 0)),
    ]
    for (i, (p, inn, out)) in corners.enumerated() {
        // A point `along` before the corner on the incoming edge, `across` inside it.
        func at(_ along: Double, _ across: Double) -> CGPoint {
            CGPoint(x: p.x - inn.0 * along + out.0 * across, y: p.y - inn.1 * along + out.1 * across)
        }
        // The same with the roles swapped: on the outgoing edge.
        func on(_ along: Double, _ across: Double) -> CGPoint {
            CGPoint(x: p.x + out.0 * along - inn.0 * across, y: p.y + out.1 * along - inn.1 * across)
        }
        if i == 0 { path.move(to: at(a, 0)) } else { path.addLine(to: at(a, 0)) }
        path.addCurve(to: at(d, f), control1: at(b, 0), control2: at(c, 0))
        path.addCurve(to: on(d, f), control1: at(e, g), control2: on(e, g))
        path.addCurve(to: on(a, 0), control1: on(c, 0), control2: on(b, 0))
    }
    path.closeSubpath()
    return path
}

/// Bounding boxes of the two eyes (each eye is one subpath of `MascotDrawing.eyes`).
func eyeBoxes(_ eyes: CGPath) -> [CGRect] {
    var boxes: [CGRect] = []
    var points: [CGPoint] = []
    func flush() {
        guard let first = points.first else { return }
        var box = CGRect(origin: first, size: .zero)
        for p in points { box = box.union(CGRect(origin: p, size: .zero)) }
        boxes.append(box)
        points = []
    }
    eyes.applyWithBlock { element in
        let e = element.pointee
        switch e.type {
        case .moveToPoint: flush(); points.append(e.points[0])
        case .addLineToPoint: points.append(e.points[0])
        case .addQuadCurveToPoint: points.append(contentsOf: [e.points[0], e.points[1]])
        case .addCurveToPoint: points.append(contentsOf: [e.points[0], e.points[1], e.points[2]])
        default: break
        }
    }
    flush()
    return boxes
}

/// One line per candidate: how much of the body leaves each edge, the eyes' distance from the
/// icon edge, whether they clear the home screen mask with 2% to spare, and the narrowest eye
/// at 29 pt @3x (87 px).
func check(_ c: Candidate) -> String {
    let s = Double(Icon.side)
    let d = drawing(c, side: s)
    let body = d.body.boundingBoxOfPath
    func pct(_ v: Double) -> String { String(format: "%.0f%%", max(v, 0) * 100) }
    let out = "out L \(pct(-body.minX / body.width)) R \(pct((body.maxX - s) / body.width))"
        + " T \(pct(-body.minY / body.height)) B \(pct((body.maxY - s) / body.height))"
    let boxes = eyeBoxes(d.eyes)
    let edge = boxes.map { min($0.minX, $0.minY, s - $0.maxX, s - $0.maxY) / s }.min() ?? 0
    let mask = iconMask(s)
    let clear = boxes.allSatisfy { box in
        let b = box.insetBy(dx: -0.02 * s, dy: -0.02 * s)
        return (0...8).allSatisfy { i in
            let t = Double(i) / 8
            return [CGPoint(x: b.minX + t * b.width, y: b.minY), CGPoint(x: b.minX + t * b.width, y: b.maxY),
                    CGPoint(x: b.minX, y: b.minY + t * b.height), CGPoint(x: b.maxX, y: b.minY + t * b.height)]
                .allSatisfy { mask.contains($0) }
        }
    }
    let narrow = boxes.map { min($0.width, $0.height) }.min() ?? 0
    let corners = [CGPoint(x: 0, y: 0), CGPoint(x: s, y: 0), CGPoint(x: 0, y: s), CGPoint(x: s, y: s)]
    let bleed = corners.allSatisfy { d.body.contains($0) } ? "  body covers all corners" : ""
    return "\(c.id): \(out); eyes \(pct(edge)) from the edge, clear of the mask: \(clear ? "yes" : "NO");"
        + String(format: " narrowest eye %.1f px at 87 px", narrow / s * 87) + bleed
}

// MARK: - Contact sheet

/// Stand-ins for the home screen: wallpapers, the iOS 18 dark icon backdrop, and a tint colour.
enum Sheet {
    static let width = 2000, header = 100, rowHeight = 380
    static let paperRGB: UInt32 = 0xFBFAF8
    static let lightWall: (UInt32, UInt32) = (0xDCE6F2, 0xC4D3E6)
    static let darkWall: (UInt32, UInt32) = (0x1C2230, 0x07090D)
    static let darkBackdrop: (UInt32, UInt32) = (0x3A3A3C, 0x121214)
    static let tint: UInt32 = 0xF2B84B
}

/// The sheet's own coordinates are y up; `top` measures from the sheet's top edge.
func flipRect(_ x: Double, top: Double, _ w: Double, _ h: Double, in gc: CGContext) -> CGRect {
    CGRect(x: x, y: Double(gc.height) - top - h, width: w, height: h)
}

func gradient(_ gc: CGContext, _ rect: CGRect, _ colors: (UInt32, UInt32), path: CGPath? = nil) {
    gc.saveGState()
    gc.addPath(path ?? CGPath(rect: rect, transform: nil))
    gc.clip()
    let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                       colors: [MascotFace.color(colors.0), MascotFace.color(colors.1)] as CFArray,
                       locations: [0, 1])!
    gc.drawLinearGradient(g, start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.minY),
                          options: [])
    gc.restoreGState()
}

/// The tinted home screen, roughly: the glyph's luminance mixes from the backdrop to the tint.
func tintedPreview(_ c: Candidate, side: Int) -> CGImage {
    let src = renderContext(c, .tinted, side: side)
    let out = bitmap(side)
    let rect = CGRect(x: 0, y: 0, width: side, height: side)
    gradient(out, rect, (0x2A2418, 0x0E0C08))
    guard let s = src.data?.assumingMemoryBound(to: UInt8.self),
          let o = out.data?.assumingMemoryBound(to: UInt8.self) else { fatalError("no bitmap data") }
    let tint = [Double((Sheet.tint >> 16) & 0xFF), Double((Sheet.tint >> 8) & 0xFF), Double(Sheet.tint & 0xFF)]
    for i in stride(from: 0, to: src.bytesPerRow * side, by: 4) {
        let alpha = Double(s[i + 3]) / 255
        guard alpha > 0 else { continue }
        let lum = Double(s[i]) / 255 / alpha  // un-premultiplied gray
        let level = 0.12 + 0.88 * lum
        for k in 0..<3 {
            let glyph = tint[k] * level
            o[i + k] = UInt8(min(max(Double(o[i + k]) * (1 - alpha) + glyph * alpha, 0), 255))
        }
    }
    guard let image = out.makeImage() else { fatalError("could not make the tinted preview") }
    return image
}

/// One icon as the home screen shows it: rendered at `side` px, inside the rounded mask; dark
/// over the system's dark backdrop, tinted as tinted.
func cell(_ gc: CGContext, _ c: Candidate, _ look: Look, white: Bool = false, x: Double, top: Double, side: Int) {
    let rect = flipRect(x, top: top, Double(side), Double(side), in: gc)
    let mask = iconMask(Double(side), x: rect.minX, y: rect.minY)
    gc.saveGState()
    gc.addPath(mask)
    gc.clip()
    switch look {
    case .light: gc.draw(render(c, .light, white: white, side: side), in: rect)
    case .dark:
        gradient(gc, rect, Sheet.darkBackdrop)
        gc.draw(render(c, .dark, side: side), in: rect)
    case .tinted: gc.draw(tintedPreview(c, side: side), in: rect)
    }
    gc.restoreGState()
    gc.addPath(mask)  // a hairline so a light icon on a light wall keeps its edge
    gc.setStrokeColor(gray: 0, alpha: 0.10)
    gc.setLineWidth(1)
    gc.strokePath()
}

func text(_ gc: CGContext, _ string: String, x: Double, top: Double, size: Double, bold: Bool = false,
          gray: Double = 0.1, width: Double = 600) {
    let font = CTFontCreateWithName((bold ? "PingFangSC-Semibold" : "PingFangSC-Regular") as CFString, CGFloat(size), nil)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: CGFloat(gray), alpha: 1),
    ]
    let setter = CTFramesetterCreateWithAttributedString(NSAttributedString(string: string, attributes: attributes))
    let box = flipRect(x, top: top, width, size * 3, in: gc)
    let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), CGPath(rect: box, transform: nil), nil)
    CTFrameDraw(frame, gc)
}

/// One row per candidate: the id and caption; the light icon large; a light wallpaper with the
/// light icon at 60 pt (warm, then pure white), 40 pt and 29 pt; a dark wallpaper with the dark
/// and tinted icons at 60 pt and the dark one at 29 pt. Sizes are @3x pixels.
func contactSheet() -> CGImage {
    let rows = Icon.candidates.count
    let height = Sheet.header + rows * Sheet.rowHeight + 30
    let gc = CGContext(data: nil, width: Sheet.width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                       space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    gc.interpolationQuality = .high
    gc.setFillColor(MascotFace.color(Sheet.paperRGB))
    gc.fill(CGRect(x: 0, y: 0, width: Sheet.width, height: height))
    text(gc, "OpenDuet 图标候选（M29）", x: 40, top: 16, size: 28, bold: true, width: 700)
    text(gc, "大图 300 px", x: 330, top: 62, size: 20, gray: 0.45)
    text(gc, "浅色壁纸：60 pt 暖白 · 60 pt 纯白 · 40 pt · 29 pt（@3x 像素）", x: 700, top: 62, size: 20, gray: 0.45, width: 640)
    text(gc, "深色壁纸：60 pt 深色 · 60 pt 着色 · 29 pt 深色", x: 1410, top: 62, size: 20, gray: 0.45, width: 640)
    for (i, c) in Icon.candidates.enumerated() {
        let top = Double(Sheet.header + i * Sheet.rowHeight)
        let mid = top + Double(Sheet.rowHeight) / 2
        if i > 0 {
            gc.setFillColor(gray: 0, alpha: 0.08)
            gc.fill(flipRect(40, top: top, Double(Sheet.width - 80), 1, in: gc))
        }
        text(gc, c.id, x: 40, top: mid - 70, size: 56, bold: true, width: 260)
        text(gc, c.label, x: 40, top: mid + 10, size: 22, gray: 0.35, width: 260)
        cell(gc, c, .light, x: 330, top: mid - 150, side: 300)
        // Light wallpaper.
        let light = flipRect(700, top: mid - 130, 690, 260, in: gc)
        gradient(gc, light, Sheet.lightWall, path: CGPath(roundedRect: light, cornerWidth: 28, cornerHeight: 28, transform: nil))
        cell(gc, c, .light, x: 730, top: mid - 90, side: 180)
        cell(gc, c, .light, white: c.warm, x: 935, top: mid - 90, side: 180)
        cell(gc, c, .light, x: 1140, top: mid - 60, side: 120)
        cell(gc, c, .light, x: 1285, top: mid - 43.5, side: 87)
        // Dark wallpaper.
        let dark = flipRect(1410, top: mid - 130, 550, 260, in: gc)
        gradient(gc, dark, Sheet.darkWall, path: CGPath(roundedRect: dark, cornerWidth: 28, cornerHeight: 28, transform: nil))
        cell(gc, c, .dark, x: 1440, top: mid - 90, side: 180)
        cell(gc, c, .tinted, x: 1645, top: mid - 90, side: 180)
        cell(gc, c, .dark, x: 1850, top: mid - 43.5, side: 87)
    }
    guard let image = gc.makeImage() else { fatalError("could not make the contact sheet") }
    return image
}

// MARK: - Command line

let args = Array(CommandLine.arguments.dropFirst())
func usage() -> Never {
    print("usage: appicon <C0...C6> <light|dark|tinted> <output.png> [--white]\n       appicon all <directory>")
    exit(2)
}

if args.first == "all" {
    guard args.count == 2 else { usage() }
    let dir = args[1]
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    for c in Icon.candidates {
        for look in Look.allCases { writePNG(render(c, look), "\(dir)/\(c.id)-\(look.rawValue).png") }
        if c.warm { writePNG(render(c, .light, white: true), "\(dir)/\(c.id)-light-white.png") }
        print(check(c))
    }
    writePNG(contactSheet(), "\(dir)/contact-sheet.png")
    print("wrote \(Icon.candidates.count) candidates and contact-sheet.png to \(dir)")
} else {
    guard args.count == 3 || (args.count == 4 && args[3] == "--white"),
          let c = Icon.candidates.first(where: { $0.id.lowercased() == args[0].lowercased() }),
          let look = Look(rawValue: args[1])
    else { usage() }
    writePNG(render(c, look, white: args.count == 4), args[2])
    print("wrote \(args[2]) (\(c.id) \(look.rawValue), \(Icon.side)x\(Icon.side)\(look == .light ? ", opaque" : ", transparent background"))")
    print(check(c))
}
