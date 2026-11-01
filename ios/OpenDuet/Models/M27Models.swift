// M27 contract A (backend/src/contract/m27.ts): a dashboard's live data, kept apart from its page. The
// fields M27 adds to older models (ArtifactSummary.pageUpdatedAt / dataVersion in Artifacts.swift,
// ArtifactVersion.Reason.data / dataUpdates in M24Models.swift) sit next to those models.
// Tolerant like the rest: an unknown value reads nil, a missing field takes its default.
import Foundation

/// How the served page carries the data and how the app hands it a newer one (docs/API.md "## M27").
enum ArtifactLiveData {
    /// `<script type="application/json" id="duet-data" data-version="N">` in the served page
    static let elementId = "duet-data"
    /// the element's attribute holding the dataVersion its JSON is
    static let versionAttribute = "data-version"
    /// fired on `document` after newer JSON is in the element; the page re-reads the element
    static let event = "duet:data"
}

extension ArtifactSummary {
    /// M27: the page's own save time. The viewer reloads the page only when this moves; when only
    /// `dataVersion` moves it hands the new data to the open page. An older server sends no
    /// pageUpdatedAt: then every change reloads, as before.
    var pageVersion: Date { pageUpdatedAt ?? updatedAt }
}

/// GET /api/artifacts/:id/data: the data as it is now. `json` is the exact compact JSON text the page
/// carries (pass it on as it is; never re-encode it); nil = the artifact has no data.
struct ArtifactDataResponse: Decodable, Hashable, Sendable {
    var artifactId: ID
    var dataVersion: Int
    var dataUpdatedAt: Date?
    var json: String?

    private enum CodingKeys: String, CodingKey { case artifactId, dataVersion, dataUpdatedAt, json }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        artifactId = try c.decode(ID.self, forKey: .artifactId)
        dataVersion = max(0, try c.decode(Int.self, forKey: .dataVersion))
        dataUpdatedAt = (try? c.decodeIfPresent(Date.self, forKey: .dataUpdatedAt)) ?? nil
        json = try c.decodeIfPresent(String.self, forKey: .json)
    }
}

/// update_artifact_data's arguments as a run record shows them (RunStep.input). Server-side only;
/// decoded for the run record and the contract samples.
struct UpdateArtifactDataInput: Decodable, Hashable, Sendable {
    /// One step of a path: an object key or an array index.
    enum PathSegment: Decodable, Hashable, Sendable {
        case key(String)
        case index(Int)

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let index = try? c.decode(Int.self) { self = .index(index) } else { self = .key(try c.decode(String.self)) }
        }
    }

    struct Op: Decodable, Hashable, Sendable {
        enum Kind: String, Decodable, Sendable { case set, increment, append, remove }
        /// nil: an op from a newer server
        var op: Kind?
        var path: [PathSegment]
        /// set / append: the JSON value
        var value: JSONValue?
        /// increment: the amount (default 1)
        var by: Double?
        /// append: keep the newest `max` items
        var max: Int?

        private enum CodingKeys: String, CodingKey { case op, path, value, by, max }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            op = try? c.decodeIfPresent(Kind.self, forKey: .op)
            path = (try? c.decodeIfPresent([PathSegment].self, forKey: .path)) ?? []
            value = c.contains(.value) ? ((try? c.decode(JSONValue.self, forKey: .value)) ?? .null) : nil
            by = (try? c.decodeIfPresent(Double.self, forKey: .by)) ?? nil
            max = (try? c.decodeIfPresent(Int.self, forKey: .max)) ?? nil
        }
    }

    var artifactId: ID
    /// nil: the call replaced the whole data (`data`)
    var ops: [Op]?
    /// the whole new data object, or nil when the call used ops
    var data: JSONValue?
    var expectedVersion: Int?
    /// the chat card's numbers after the change
    var metrics: [ArtifactPayload.Metric]?

    private enum CodingKeys: String, CodingKey { case artifactId, ops, data, expectedVersion, metrics }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        artifactId = try c.decode(ID.self, forKey: .artifactId)
        ops = try c.decodeIfPresent([Op].self, forKey: .ops)
        let data = try c.decodeIfPresent(JSONValue.self, forKey: .data)
        self.data = data == .null ? nil : data
        expectedVersion = (try? c.decodeIfPresent(Int.self, forKey: .expectedVersion)) ?? nil
        metrics = (try? c.decodeIfPresent([ArtifactPayload.Metric].self, forKey: .metrics)) ?? nil
    }
}

/// update_artifact_data's result (RunStep.output): saved (`status`) or refused (`error` + `code`).
struct UpdateArtifactDataResult: Decodable, Hashable, Sendable {
    enum Status: String, Decodable, Sendable { case updated, unchanged }
    enum Code: String, Decodable, Sendable {
        case notFound = "not_found", notDashboard = "not_dashboard", noData = "no_data", notReady = "not_ready"
        case versionConflict = "version_conflict", tooLarge = "too_large", invalidData = "invalid_data"
        case invalidOp = "invalid_op", tooFrequent = "too_frequent"
    }
    /// nil on a refusal (or a status from a newer server)
    var status: Status?
    var artifactId: ID?
    var title: String?
    var dataVersion: Int?
    var bytes: Int?
    var note: String?
    /// refusals: the model-facing reason and its code (nil: a code from a newer server)
    var error: String?
    var code: Code?
    var retryAfterMs: Int?

    var saved: Bool { error == nil && status != nil }

    private enum CodingKeys: String, CodingKey { case status, artifactId, title, dataVersion, bytes, note, error, code, retryAfterMs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try? c.decodeIfPresent(Status.self, forKey: .status)
        artifactId = try? c.decodeIfPresent(ID.self, forKey: .artifactId)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        dataVersion = (try? c.decodeIfPresent(Int.self, forKey: .dataVersion)) ?? nil
        bytes = (try? c.decodeIfPresent(Int.self, forKey: .bytes)) ?? nil
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        code = try? c.decodeIfPresent(Code.self, forKey: .code)
        retryAfterMs = (try? c.decodeIfPresent(Int.self, forKey: .retryAfterMs)) ?? nil
    }
}
