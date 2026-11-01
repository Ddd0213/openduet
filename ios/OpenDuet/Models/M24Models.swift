// M24 contract (backend/src/contract/m24.ts): artifact versions and restore (undo), the card's line
// chart. The fields M24 adds to older models (ArtifactSummary.lastOpenedAt, CardBlock.CheckItem.id,
// CardBlock.lineChart, MessageActionRequest check / uncheck) sit next to those models.
// Tolerant like the rest: an unknown value reads nil, a missing field takes its default.
import Foundation

/// One saved state of an artifact's page (the page itself is never in the list). Every save writes
/// one; the newest is the page as it is now. A restore saves the chosen one again as the newest.
struct ArtifactVersion: Decodable, Hashable, Sendable, Identifiable {
    enum By: String, AssistantValue, Sendable { case user, assistant }
    /// M27: `data` = live data updates (one run's within 10 minutes merged into one row; the page is
    /// the same as the row before it).
    enum Reason: String, Decodable, Sendable { case create, edit, refresh, restore, data }
    var id: ID
    var artifactId: ID
    /// nil: a value from a newer server
    var by: By?
    /// nil: a value from a newer server
    var reason: Reason?
    /// create: the artifact's request; edit: the change asked for; nil otherwise
    var prompt: String?
    /// M27 reason `data`: when the first merged update was saved (the row holds the state after the last)
    var createdAt: Date
    /// M27: reason `data`: how many data updates the row holds (1+); 0 otherwise and from older servers
    var dataUpdates: Int = 0

    private enum CodingKeys: String, CodingKey { case id, artifactId, by, reason, prompt, createdAt, dataUpdates }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        artifactId = try c.decode(ID.self, forKey: .artifactId)
        by = try? c.decodeIfPresent(By.self, forKey: .by)
        reason = try? c.decodeIfPresent(Reason.self, forKey: .reason)
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        dataUpdates = max(0, (try? c.decodeIfPresent(Int.self, forKey: .dataUpdates)) ?? 0)
    }
}

/// GET /api/artifacts/:id/versions: newest first, at most 10; empty before the first page is saved.
struct ArtifactVersionList: Decodable, Hashable, Sendable {
    var versions: [ArtifactVersion]

    /// Undo restores the version before the newest; nil when there is none (one version or none).
    var undoTarget: ArtifactVersion? { versions.count >= 2 ? versions[1] : nil }

    private enum CodingKeys: String, CodingKey { case versions }

    init(versions: [ArtifactVersion]) { self.versions = versions }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        versions = try c.decodeIfPresent([ArtifactVersion].self, forKey: .versions) ?? []
    }
}

/// POST /api/artifacts/:id/restore -> ArtifactResponse (the artifact, its updatedAt moved on).
struct RestoreArtifactRequest: Codable, Hashable, Sendable {
    var versionId: ID
}

/// CardBlock.lineChart: 1-3 series over 2-24 shared labels; each series has one value per label
/// and nil is a gap (no data for that label).
struct CardLineChart: Decodable, Hashable, Sendable {
    struct Series: Decodable, Hashable, Sendable {
        var name: String
        var values: [Double?]
    }
    var labels: [String]
    var series: [Series]
    /// "kg", "$", "steps"; nil for plain numbers
    var unit: String?
}
