// Make tab artifacts: self-contained HTML built on the assistant's computer
// (backend/src/contract/artifacts.ts). The HTML itself is GET /api/artifacts/:id/html.
import Foundation

enum ArtifactType: String, Codable, CaseIterable, Sendable {
    case webPage = "web_page"
    case docs, slides, dashboard, design
    case designSystem = "design_system"
}

struct ArtifactSource: Decodable, Hashable, Sendable {
    var name: String
    var app: String?
    var detail: String
}

struct ArtifactSummary: Decodable, Hashable, Sendable, Identifiable {
    enum Status: String, Decodable, Sendable { case building, ready, failed }
    var id: ID
    var channelId: ID
    var type: ArtifactType
    var title: String
    var status: Status
    var sourceCount: Int
    var refreshSchedule: Schedule?
    var pinnedToTabBar: Bool
    var createdAt: Date
    var updatedAt: Date
    /// M10: pinned to the top of Make (separate from `pinnedToTabBar`); the server sorts pinned first.
    var pinned: Bool = false
    /// M24: when the user last opened it (GET /api/artifacts/:id sets it); nil = made and never
    /// opened ("Just made"), or an older server.
    var lastOpenedAt: Date? = nil
    /// M27: when the page itself was last saved; `updatedAt` is content time (the later of this and
    /// the live data's last change). nil = an older server (M27Models.swift `pageVersion`).
    var pageUpdatedAt: Date? = nil
    /// M27: +1 on every change of the live data; 0 = no data ever (older servers, non-dashboards).
    var dataVersion: Int = 0
}

extension ArtifactSummary {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, type, title, status, sourceCount, refreshSchedule, pinnedToTabBar, createdAt, updatedAt, pinned, lastOpenedAt
        case pageUpdatedAt, dataVersion
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        channelId = try c.decode(ID.self, forKey: .channelId)
        type = try c.decode(ArtifactType.self, forKey: .type)
        title = try c.decode(String.self, forKey: .title)
        status = try c.decode(Status.self, forKey: .status)
        sourceCount = try c.decode(Int.self, forKey: .sourceCount)
        refreshSchedule = try c.decodeIfPresent(Schedule.self, forKey: .refreshSchedule)
        pinnedToTabBar = try c.decode(Bool.self, forKey: .pinnedToTabBar)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        lastOpenedAt = try c.decodeIfPresent(Date.self, forKey: .lastOpenedAt)
        // M27: tolerant (a bad value reads as an older server's: nil / 0)
        pageUpdatedAt = (try? c.decodeIfPresent(Date.self, forKey: .pageUpdatedAt)) ?? nil
        dataVersion = max(0, (try? c.decodeIfPresent(Int.self, forKey: .dataVersion)) ?? 0)
    }
}

/// GET /api/artifacts/:id: the summary fields plus prompt and sources (one flat JSON object).
struct ArtifactDetail: Decodable, Hashable, Sendable, Identifiable {
    var summary: ArtifactSummary
    var prompt: String
    var sources: [ArtifactSource]

    var id: ID { summary.id }

    private enum CodingKeys: String, CodingKey { case prompt, sources }

    init(from decoder: Decoder) throws {
        summary = try ArtifactSummary(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        prompt = try c.decode(String.self, forKey: .prompt)
        sources = try c.decode([ArtifactSource].self, forKey: .sources)
    }
}

/// GET /api/artifacts
struct ArtifactList: Decodable, Sendable {
    var artifacts: [ArtifactSummary]
}

/// POST /api/artifacts (Describe sheet / gallery hero composer); progress arrives as events.
struct CreateArtifactRequest: Codable, Hashable, Sendable {
    var type: ArtifactType
    var prompt: String
    var channelId: ID
}

/// POST /api/artifacts/:id/edit (✎: ask the assistant for changes).
struct EditArtifactRequest: Codable, Hashable, Sendable {
    var prompt: String
}

/// PATCH /api/artifacts/:id (Add to / Remove from tab bar, rename).
struct UpdateArtifactRequest: Codable, Hashable, Sendable {
    var pinnedToTabBar: Bool?
    var title: String?
    /// .clear removes the schedule; nil leaves it as it is.
    var refreshSchedule: RefreshScheduleUpdate?
    /// M10: Pin / Unpin in Make (long-press).
    var pinned: Bool?

    enum RefreshScheduleUpdate: Hashable, Sendable {
        case set(RefreshSchedule)
        case clear
    }

    private enum CodingKeys: String, CodingKey { case pinnedToTabBar, title, refreshSchedule, pinned }

    init(pinnedToTabBar: Bool? = nil, title: String? = nil, refreshSchedule: RefreshScheduleUpdate? = nil, pinned: Bool? = nil) {
        self.pinnedToTabBar = pinnedToTabBar
        self.title = title
        self.refreshSchedule = refreshSchedule
        self.pinned = pinned
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pinnedToTabBar = try c.decodeIfPresent(Bool.self, forKey: .pinnedToTabBar)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned)
        if c.contains(.refreshSchedule) {
            refreshSchedule = try c.decodeNil(forKey: .refreshSchedule)
                ? .clear : .set(try c.decode(RefreshSchedule.self, forKey: .refreshSchedule))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(pinnedToTabBar, forKey: .pinnedToTabBar)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(pinned, forKey: .pinned)
        switch refreshSchedule {
        case .set(let schedule)?: try c.encode(schedule, forKey: .refreshSchedule)
        case .clear?: try c.encodeNil(forKey: .refreshSchedule)
        case nil: break
        }
    }
}

/// An artifact's refresh schedule ("Refreshes daily at 5:30 AM"), in the user's timezone.
struct RefreshSchedule: Codable, Hashable, Sendable {
    enum Cadence: String, Codable, Sendable { case daily, weekdays, hourly }
    var cadence: Cadence
    var hour: Int
    var minute: Int
}

struct ArtifactResponse: Decodable, Sendable {
    var artifact: ArtifactSummary
}
