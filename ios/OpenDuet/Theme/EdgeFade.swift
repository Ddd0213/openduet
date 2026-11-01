// The shell's long, soft mask (chat, Tasks, Make; decided by the user after M13, "option A"): the
// blur and tint are solid only right at the screen edge (behind the status bar or the home
// indicator) and ease out over most of the chrome, so the frosted band no longer reads as a thick
// slab. Measured as fractions of the mask's height from the screen edge, so it follows the header
// (offline bar, Build header) and the bottom stack (composer or not, keyboard up).
// Pure Foundation (host tests).
import Foundation

struct EdgeFade: Equatable, Sendable {
    /// Solid from the screen edge to this fraction of the mask's height.
    var solid: Double
    /// Clear from this fraction on (the eased ramp lies between).
    var end: Double

    /// The shell header: on a 170 pt mask (status bar 62 + header 108), solid to ~58, clear at ~140.
    static let shellTop = EdgeFade(solid: 0.34, end: 0.82)
    /// The composer + tab bar: on a 174 pt mask, solid to ~38 (the home indicator), clear at ~136.
    static let shellBottom = EdgeFade(solid: 0.22, end: 0.78)

    /// Distances from the screen edge for a mask `height` tall: where the solid part ends and where
    /// the ramp ends. `layer` 0...1 ends a stronger layer's ramp that much of the way earlier.
    func span(height: Double, layer: Double = 0) -> (near: Double, far: Double) {
        guard height > 0 else { return (0, 0) }
        let near = height * solid
        let far = height * end
        return (near, max(near, far - (far - near) * layer))
    }
}
