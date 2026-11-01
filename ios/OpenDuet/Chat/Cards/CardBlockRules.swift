// M24 (review-make P2-4): the rules behind two chat card blocks. The line chart's series break
// at a null (no data for that label) into runs, a run of one is drawn as a dot, and the x axis
// names only as many labels as fit. The checkable checklist sends one tick at a time (the card
// takes one action at a time): a tap shows at once, later taps queue, and a failed request puts
// back what the card says. Pure Foundation (host-tested).
import Foundation

enum LineChartRules {
    struct Point: Hashable, Sendable {
        var index: Int
        var value: Double
    }

    /// One unbroken stretch of a series.
    struct Run: Hashable, Sendable {
        var points: [Point]
        var isDot: Bool { points.count == 1 }
    }

    /// The series split at each null; empty when it has no values at all.
    static func runs(_ values: [Double?]) -> [Run] {
        var out: [Run] = []
        var current: [Point] = []
        for (index, value) in values.enumerated() {
            if let value, value.isFinite {
                current.append(Point(index: index, value: value))
            } else if !current.isEmpty {
                out.append(Run(points: current))
                current = []
            }
        }
        if !current.isEmpty { out.append(Run(points: current)) }
        return out
    }

    /// How many x labels fit across a card, by the longest label (CJK counts double).
    static func fit(longest: Int) -> Int {
        switch longest {
        case ...3: 7
        case ...5: 5
        case ...8: 4
        case ...12: 3
        default: 2
        }
    }

    static func width(_ label: String) -> Int {
        label.unicodeScalars.reduce(0) { $0 + ($1.value >= 0x2E80 ? 2 : 1) }
    }

    /// The labels the x axis names: evenly spaced, always the last (the newest).
    static func labelIndices(count: Int, fit: Int) -> [Int] {
        guard count > 0 else { return [] }
        guard count > fit, fit > 1 else { return Array(0..<count) }
        let step = Int((Double(count - 1) / Double(fit - 1)).rounded(.up))
        return stride(from: count - 1, through: 0, by: -step).reversed()
    }

    static func labelIndices(_ labels: [String]) -> [Int] {
        labelIndices(count: labels.count, fit: fit(longest: labels.map(width).max() ?? 0))
    }
}

/// A checkable checklist's taps until the card says so: what the user wants for each item and the
/// one tick on its way.
struct ChecklistTicks: Hashable, Sendable {
    struct Tick: Hashable, Sendable {
        var itemId: String
        var done: Bool
    }

    /// item id -> done, as tapped, until the card agrees
    var wanted: [String: Bool] = [:]
    /// the request in flight (one per card)
    var sending: Tick?

    var isSending: Bool { sending != nil }

    /// Ticked as shown: the user's latest tap, else the card.
    func isDone(_ item: CardBlock.CheckItem) -> Bool {
        guard let id = item.id else { return item.done }
        return wanted[id] ?? item.done
    }

    /// A tap flips what the row shows.
    mutating func tap(_ item: CardBlock.CheckItem) {
        guard let id = item.id else { return }
        wanted[id] = !isDone(item)
    }

    /// The next tick to send (the first item whose wish differs from the card), marked as sending;
    /// nil while one is on its way or nothing differs (the wishes the card already shows go).
    mutating func next(_ items: [CardBlock.CheckItem]) -> Tick? {
        guard sending == nil else { return nil }
        for item in items {
            guard let id = item.id, let want = wanted[id] else { continue }
            if want == item.done {
                wanted[id] = nil
                continue
            }
            let tick = Tick(itemId: id, done: want)
            sending = tick
            return tick
        }
        return nil
    }

    /// The server took the tick (the card it sent back shows it): its wish is done unless the
    /// user tapped the row again meanwhile.
    mutating func sent() {
        if let sending, wanted[sending.itemId] == sending.done { wanted[sending.itemId] = nil }
        sending = nil
    }

    /// The request failed: every row shows the card again (nothing unsent is kept).
    mutating func failed() {
        wanted = [:]
        sending = nil
    }
}
