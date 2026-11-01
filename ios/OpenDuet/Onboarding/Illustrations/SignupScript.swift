// Page 3's timeline (prompt L25) as pure functions of time: the user bubble at 0.4s, the
// browser card at 1.0s, the cursor gliding ~0.5s to each field and typing ~14 chars/s, the
// drift to the card's bottom-right corner, then the assistant's reply under the card.
import Foundation

struct SignupScript {
    static let bubbleIn = 0.4
    static let cardIn = 1.0
    static let cursorIn = 1.3
    static let glide = 0.5
    static let pause = 0.15
    static let charsPerSecond = 14.0
    static let drift = 0.8

    /// The sample values, already resolved for the current language, typed one character at
    /// a time (so Chinese types its translation).
    let values: [String]
    private let leaves: [Double]
    private let arrivals: [Double]
    let driftStart: Double

    init(values: [String]) {
        self.values = values
        var leaves: [Double] = [], arrivals: [Double] = []
        var clock = Self.cursorIn + 0.05
        for value in values {
            leaves.append(clock)
            arrivals.append(clock + Self.glide)
            clock += Self.glide + Double(value.count) / Self.charsPerSecond + Self.pause
        }
        self.leaves = leaves
        self.arrivals = arrivals
        driftStart = clock
    }

    /// Name, Team and Dates in the current language.
    static func localized() -> SignupScript {
        SignupScript(values: [
            String(localized: "Alex Kim", comment: "Sample name OpenDuet types into the sign-up form (onboarding page 3)"),
            String(localized: "Product design", comment: "Sample team OpenDuet types into the sign-up form (onboarding page 3)"),
            String(localized: "May 12 to 14", comment: "Sample dates OpenDuet types into the sign-up form (onboarding page 3)"),
        ])
    }

    var replyIn: Double { driftStart + 0.5 }
    /// Nothing moves after this, so the TimelineView can pause.
    var finishTime: Double { replyIn + 0.6 }

    /// The part of field i typed so far.
    func typed(_ i: Int, at t: Double) -> String {
        let count = Int(max(t - arrivals[i], 0) * Self.charsPerSecond)
        return String(values[i].prefix(count))
    }

    /// The field's 1pt orange border: on while the cursor is in it.
    func focus(_ i: Int, at t: Double) -> Double {
        let on = IllustrationTiming.progress(t, from: arrivals[i] - 0.12, over: 0.15)
        let off = IllustrationTiming.progress(t, from: i + 1 < values.count ? leaves[i + 1] : driftStart, over: 0.2)
        return on * (1 - off)
    }

    /// The cursor tip and opacity. `stops` are the entry point, one point per field, and the
    /// resting point at the card's bottom-right corner.
    func cursor(at t: Double, stops: [CGPoint], reduceMotion: Bool) -> (point: CGPoint, opacity: Double) {
        let legs = Array(zip(leaves, arrivals)) + [(driftStart, driftStart + Self.drift)]
        guard stops.count == legs.count + 1 else { return (.zero, 0) }
        if reduceMotion { return crossfade(at: t, stops: stops, legs: legs) }
        var point = stops[0]
        for (k, leg) in legs.enumerated() where t > leg.0 {
            let p = IllustrationTiming.progress(t, from: leg.0, over: leg.1 - leg.0)
            point = IllustrationTiming.lerp(stops[k], stops[k + 1], IllustrationTiming.easeInOut(p))
        }
        return (point, IllustrationTiming.progress(t, from: Self.cursorIn - 0.15, over: 0.2))
    }

    /// Reduce Motion: no gliding; the cursor fades in on the first field, then crossfades
    /// from stop to stop.
    private func crossfade(at t: Double, stops: [CGPoint], legs: [(Double, Double)]) -> (point: CGPoint, opacity: Double) {
        var point = stops[1]
        var opacity = IllustrationTiming.progress(t, from: legs[0].0, over: legs[0].1 - legs[0].0)
        for k in 1..<legs.count where t > legs[k].0 {
            let p = IllustrationTiming.progress(t, from: legs[k].0, over: legs[k].1 - legs[k].0)
            point = p < 0.5 ? stops[k] : stops[k + 1]
            opacity = abs(1 - 2 * p)
        }
        return (point, opacity)
    }
}
