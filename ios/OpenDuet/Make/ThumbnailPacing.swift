// M27 (docs/API.md "## M27" Thumbnails): a gallery thumbnail keeps its key (`updatedAt`, which moves
// with every data change too), but a tile whose only change is live data re-renders at most every
// 30 s while it is on screen; the snapshot it has stays meanwhile (no blank, no pulse). A new page
// or status renders at once. Pure Foundation (host-tested).
import Foundation

enum ThumbnailPacing {
    /// How long a data-only change waits after the snapshot on screen was rendered.
    static let dataInterval: TimeInterval = 30

    /// The newest snapshot of an artifact (one colour scheme) and what it showed.
    struct Shown: Hashable, Sendable {
        var key: ThumbnailKey
        /// nil: unknown (read from disk after a cold start)
        var pageVersion: Date?
        var dataVersion: Int?
        var status: ArtifactSummary.Status?
        /// when it was rendered (distantPast when that is unknown: a disk copy)
        var renderedAt: Date
    }

    enum Decision: Hashable, Sendable {
        case now
        case wait(TimeInterval)
    }

    /// Render now when nothing is on screen, the page or status differs, or the change is
    /// data-only and 30 s have passed since that snapshot rendered; else wait the rest.
    static func decide(shown: Shown?, artifact: ArtifactSummary, now: Date) -> Decision {
        guard let shown, let page = shown.pageVersion, let data = shown.dataVersion, let status = shown.status else { return .now }
        guard page == artifact.pageVersion, status == artifact.status, artifact.dataVersion != data else { return .now }
        let left = dataInterval - now.timeIntervalSince(shown.renderedAt)
        return left > 0 ? .wait(left) : .now
    }
}
