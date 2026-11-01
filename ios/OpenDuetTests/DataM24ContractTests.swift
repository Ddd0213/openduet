// M24 contract: artifact versions and undo, lastOpenedAt, the checkable checklist and the line chart
// decode; payloads from before M24 still decode; an unknown value from a newer server reads nil;
// soul_setup decoding is tolerant (M22 leftover).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M24 contract")
struct DataM24ContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    private let oldArtifact = #"{"id":"a","channelId":"c","type":"docs","title":"Brief","status":"ready","sourceCount":0,"refreshSchedule":null,"pinnedToTabBar":false,"createdAt":"2026-11-01T08:00:00.000Z","updatedAt":"2026-11-01T08:00:00.000Z"}"#

    @Test("lastOpenedAt: absent (older server) and null read nil; a date decodes")
    func lastOpened() throws {
        #expect(try decode(ArtifactSummary.self, oldArtifact).lastOpenedAt == nil)
        let never = oldArtifact.replacingOccurrences(of: #""pinnedToTabBar":false"#, with: #""pinnedToTabBar":false,"lastOpenedAt":null"#)
        #expect(try decode(ArtifactSummary.self, never).lastOpenedAt == nil)
        let opened = oldArtifact.replacingOccurrences(of: #""pinnedToTabBar":false"#, with: #""pinnedToTabBar":false,"lastOpenedAt":"2026-11-03T09:00:00.000Z""#)
        #expect(try decode(ArtifactSummary.self, opened).lastOpenedAt != nil)
        let detail = try decode(ArtifactDetail.self, String(opened.dropLast()) + #","prompt":"p","sources":[]}"#)
        #expect(detail.summary.lastOpenedAt != nil)
    }

    @Test("Versions decode newest first; undo is the one before the newest; unknown by / reason read nil")
    func versions() throws {
        let list = try decode(ArtifactVersionList.self, #"{"versions":[{"id":"v3","artifactId":"a","by":"robot","reason":"merge","prompt":null,"createdAt":"2026-11-03T09:12:00.000Z"},{"id":"v2","artifactId":"a","by":"assistant","reason":"edit","prompt":"Make it blue","createdAt":"2026-11-03T09:05:00.000Z"}]}"#)
        #expect(list.versions.map(\.id) == ["v3", "v2"])
        #expect(list.versions[0].by == nil && list.versions[0].reason == nil)
        #expect(list.versions[1].by == .assistant && list.versions[1].reason == .edit && list.versions[1].prompt == "Make it blue")
        #expect(list.undoTarget?.id == "v2")
        #expect(ArtifactVersionList(versions: [list.versions[0]]).undoTarget == nil)
        #expect(try decode(ArtifactVersionList.self, #"{"versions":[]}"#).undoTarget == nil)
        let body = try JSONCoding.encoder().encode(RestoreArtifactRequest(versionId: "v2"))
        #expect(try JSONSerialization.jsonObject(with: body) as? [String: String] == ["versionId": "v2"])
    }

    @Test("A checklist item's id makes it checkable; older items have none; check / uncheck encode")
    func checklist() throws {
        let block = try decode(CardBlock.self, #"{"type":"checklist","items":[{"text":"Passport","done":true,"id":"c1"},{"text":"Charger","done":false}]}"#)
        guard case .checklist(let items) = block else { Issue.record("not a checklist: \(block)"); return }
        #expect(items.map(\.id) == ["c1", nil])
        let body = try JSONCoding.encoder().encode(MessageActionRequest(action: .uncheck, itemId: "c1"))
        let json = try JSONSerialization.jsonObject(with: body) as? [String: String]
        #expect(json == ["action": "uncheck", "itemId": "c1"])
        #expect(try decode(MessageActionRequest.self, #"{"action":"check","itemId":"c2"}"#).action == .check)
    }

    @Test("A line chart decodes with gaps and a missing unit; an unknown block type is still skipped")
    func lineChart() throws {
        let block = try decode(CardBlock.self, #"{"type":"line_chart","labels":["W40","W41","W42"],"series":[{"name":"Revenue","values":[4200,null,5100]},{"name":"Costs","values":[3100,3000,3350]}]}"#)
        guard case .lineChart(let chart) = block else { Issue.record("not a line chart: \(block)"); return }
        #expect(chart.labels.count == 3 && chart.series.count == 2 && chart.unit == nil)
        #expect(chart.series[0].values == [4200, nil, 5100])
        #expect(try decode(CardBlock.self, #"{"type":"pie","slices":[]}"#) == .unsupported(type: "pie"))
    }

    @Test("soul_setup: an unknown state reads nil (read-only), an unknown field is dropped, the rest show")
    func soulSetupTolerant() throws {
        let payload = try decode(SoulSetupPayload.self, #"{"fields":[{"field":"pronouns","current":"","proposed":"they"},{"field":"name","current":"","proposed":"Duet"}],"reason":"From our chat.","state":"expired"}"#)
        #expect(payload.state == nil)
        #expect(payload.fields.map(\.field) == [.name])
        #expect(SoulSetupPhase(payload.state, request: nil) == .superseded)
        let open = try decode(SoulSetupPayload.self, #"{"fields":[{"field":"tone","current":"plain","proposed":"warm"}],"reason":"","state":"open"}"#)
        #expect(open.state == .open && SoulSetupPhase(open.state, request: nil) == .open)
    }
}
