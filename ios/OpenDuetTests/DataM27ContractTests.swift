// M27 contract A: a dashboard's live data. The summary's pageUpdatedAt / dataVersion (an older server's
// payload decodes with the fallbacks), the data fetch's exact JSON text, the version reason "data" with
// its merged count, an `artifact` event that moved only the data, and update_artifact_data's arguments
// and results as run records show them (unknown values read nil).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M27 contract")
struct DataM27ContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    private let older = #"{"id":"a","channelId":"c","type":"dashboard","title":"Links","status":"ready","sourceCount":1,"refreshSchedule":null,"pinnedToTabBar":false,"createdAt":"2026-11-02T08:00:00.000Z","updatedAt":"2026-11-02T09:00:00.000Z"}"#

    @Test("An older server's summary: no page time (pageVersion = updatedAt), dataVersion 0")
    func olderSummary() throws {
        let summary = try decode(ArtifactSummary.self, older)
        #expect(summary.pageUpdatedAt == nil && summary.dataVersion == 0)
        #expect(summary.pageVersion == summary.updatedAt)
    }

    @Test("A data update moves updatedAt and dataVersion, not the page time; bad values read as an older server's")
    func liveSummary() throws {
        let live = older.replacingOccurrences(of: #""updatedAt":"2026-11-02T09:00:00.000Z""#, with: #""updatedAt":"2026-11-02T09:42:10.000Z","pageUpdatedAt":"2026-11-02T09:03:10.000Z","dataVersion":10"#)
        let summary = try decode(ArtifactSummary.self, live)
        #expect(summary.dataVersion == 10)
        #expect(summary.pageVersion == JSONCoding.parseDate("2026-11-02T09:03:10.000Z"))
        #expect(summary.pageVersion < summary.updatedAt)
        let bad = older.replacingOccurrences(of: #""title":"Links""#, with: #""title":"Links","pageUpdatedAt":"soon","dataVersion":"ten""#)
        let tolerant = try decode(ArtifactSummary.self, bad)
        #expect(tolerant.pageUpdatedAt == nil && tolerant.dataVersion == 0)
    }

    @Test("The data fetch keeps the JSON text exactly; no data reads nil")
    func dataResponse() throws {
        let text = #"{"total":312,"categories":[{"name":"AI","count":131}],"人工智能":7,"ratio":0.5}"#
        let body = try JSONSerialization.data(withJSONObject: ["artifactId": "a", "dataVersion": 10, "dataUpdatedAt": "2026-11-02T09:42:10.000Z", "json": text])
        let response = try JSONCoding.decoder().decode(ArtifactDataResponse.self, from: body)
        #expect(response.json == text && response.dataVersion == 10 && response.dataUpdatedAt != nil)
        let none = try decode(ArtifactDataResponse.self, #"{"artifactId":"a","dataVersion":0,"dataUpdatedAt":null,"json":null}"#)
        #expect(none.json == nil && none.dataUpdatedAt == nil)
        #expect(ArtifactLiveData.elementId == "duet-data" && ArtifactLiveData.versionAttribute == "data-version" && ArtifactLiveData.event == "duet:data")
    }

    @Test("A data version row carries its merged count; older rows read 0")
    func dataVersionRow() throws {
        let list = try decode(ArtifactVersionList.self, #"{"versions":[{"id":"v6","artifactId":"a","by":"assistant","reason":"data","prompt":null,"createdAt":"2026-11-02T09:38:00.000Z","dataUpdates":5},{"id":"v4","artifactId":"a","by":"user","reason":"refresh","prompt":null,"createdAt":"2026-11-02T09:05:00.000Z"}]}"#)
        #expect(list.versions[0].reason == .data && list.versions[0].dataUpdates == 5)
        #expect(list.versions[1].reason == .refresh && list.versions[1].dataUpdates == 0)
        #expect(list.undoTarget?.id == "v4")
    }

    @Test("An artifact event that only moved the data decodes with the new dataVersion")
    func dataEvent() throws {
        let summary = older.replacingOccurrences(of: #""updatedAt":"2026-11-02T09:00:00.000Z""#, with: #""updatedAt":"2026-11-02T09:42:10.000Z","pageUpdatedAt":"2026-11-02T09:03:10.000Z","dataVersion":10"#)
        let event = try decode(DuetEvent.self, #"{"id":3101,"type":"artifact","channelId":"c","createdAt":"2026-11-02T09:42:10.000Z","payload":{"artifact":"# + summary + #","buildStatus":null,"editStatus":null,"refreshStatus":null}}"#)
        guard case let .artifact(update) = event.body else { Issue.record("not an artifact event: \(event.body)"); return }
        #expect(update.artifact.dataVersion == 10 && update.buildStatus == nil)
        #expect(update.artifact.pageVersion < update.artifact.updatedAt)
    }

    @Test("update_artifact_data's arguments: ops with mixed paths, a whole replace; unknown ops read nil")
    func toolInput() throws {
        let input = try decode(UpdateArtifactDataInput.self, #"{"artifactId":"a","ops":[{"op":"increment","path":["categories",0,"count"],"by":12},{"op":"append","path":["recent"],"value":{"t":"x"},"max":10},{"op":"set","path":["error"],"value":null},{"op":"merge","path":["x"]}],"expectedVersion":9}"#)
        let ops = try #require(input.ops)
        #expect(ops[0].op == .increment && ops[0].path == [.key("categories"), .index(0), .key("count")] && ops[0].by == 12)
        #expect(ops[1].op == .append && ops[1].max == 10 && ops[1].value?["t"]?.string == "x")
        #expect(ops[2].op == .set && ops[2].value == .null)
        #expect(ops[3].op == nil)
        #expect(input.expectedVersion == 9 && input.data == nil)
        let replace = try decode(UpdateArtifactDataInput.self, #"{"artifactId":"a","ops":null,"data":{"total":0},"metrics":[{"label":"Links","value":0,"unit":null},{"label":"AI","value":0,"unit":null}]}"#)
        #expect(replace.ops == nil && replace.data?["total"]?.number == 0 && replace.metrics?.count == 2)
    }

    @Test("update_artifact_data's results: saved, refused with a code, and a code from a newer server")
    func toolResult() throws {
        let saved = try decode(UpdateArtifactDataResult.self, #"{"status":"updated","artifactId":"a","title":"Links","dataVersion":10,"bytes":498,"note":"Saved."}"#)
        #expect(saved.saved && saved.status == .updated && saved.dataVersion == 10)
        let conflict = try decode(UpdateArtifactDataResult.self, #"{"error":"The data changed.","code":"version_conflict","dataVersion":10,"retryAfterMs":null}"#)
        #expect(!conflict.saved && conflict.code == .versionConflict && conflict.dataVersion == 10)
        let busy = try decode(UpdateArtifactDataResult.self, #"{"error":"Too often.","code":"too_frequent","dataVersion":10,"retryAfterMs":2400}"#)
        #expect(busy.code == .tooFrequent && busy.retryAfterMs == 2400)
        let newer = try decode(UpdateArtifactDataResult.self, #"{"error":"Locked.","code":"locked"}"#)
        #expect(!newer.saved && newer.code == nil && newer.error == "Locked.")
    }
}
