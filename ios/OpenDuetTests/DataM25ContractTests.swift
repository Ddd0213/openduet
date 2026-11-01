// M25 contract: the built-in connectors list decodes (an unknown id drops its row, an unknown state
// reads nil); an uploaded skill reads "upload" and an unknown source still reads as written by you;
// the upload preview answers "upload"; X-Region is two letters or nothing.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M25 contract")
struct DataM25ContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    @Test("Built-in connectors: every known id in order; an unknown id is dropped; an unknown state reads nil")
    func builtinConnectors() throws {
        let list = try decode(BuiltinConnectorList.self, #"{"connectors":[{"id":"web_search","state":"on","providers":["Exa","Parallel"],"keyless":true,"checkedAt":"2027-01-19T08:00:00.000Z"},{"id":"weather","state":"unreachable","providers":["Open-Meteo"],"keyless":true,"checkedAt":"2027-01-19T08:05:00.000Z"},{"id":"exchange_rate","state":"off","providers":[],"keyless":true,"checkedAt":null},{"id":"stock_quote","state":"on","providers":["Somebody"],"keyless":true,"checkedAt":null},{"id":"read_feed","state":"paused","providers":[],"keyless":true,"checkedAt":null}]}"#)
        #expect(list.connectors.map(\.kind) == [.webSearch, .weather, .exchangeRate, .readFeed])
        #expect(list.connectors.map(\.id) == ["web_search", "weather", "exchange_rate", "read_feed"])
        #expect(list.connectors[0].providers == ["Exa", "Parallel"] && list.connectors[0].keyless && list.connectors[0].checkedAt != nil)
        #expect(list.connectors[1].state == .unreachable)
        #expect(list.connectors[2].state == .off && list.connectors[2].checkedAt == nil)
        #expect(list.connectors[3].state == nil)
        #expect(try decode(BuiltinConnectorList.self, #"{"connectors":[]}"#).connectors.isEmpty)
    }

    @Test("A configured search provider with its key reads keyless false; missing optional fields take defaults")
    func builtinDefaults() throws {
        let row = try decode(BuiltinConnector.self, #"{"id":"web_search","state":"on","providers":["Tavily"],"keyless":false,"checkedAt":null}"#)
        #expect(row.providers == ["Tavily"] && !row.keyless)
        let bare = try decode(BuiltinConnector.self, #"{"id":"read_feed"}"#)
        #expect(bare.state == nil && bare.providers.isEmpty && bare.keyless && bare.checkedAt == nil)
    }

    private let skill = #"{"id":"s1","name":"meeting-notes","description":"Turn notes into minutes","instructions":"Write the minutes.","createdAt":"2027-01-19T08:00:00.000Z","source":"upload","sourceUrl":null,"files":[],"scope":"all","channelIds":[]}"#

    @Test("An uploaded skill reads upload; a source from a newer server reads as written by you")
    func skillSource() throws {
        #expect(try decode(Skill.self, skill).source == .upload)
        let newer = skill.replacingOccurrences(of: #""source":"upload""#, with: #""source":"marketplace""#)
        #expect(try decode(Skill.self, newer).source == .manual)
        let older = skill.replacingOccurrences(of: #""source":"upload","#, with: "")
        #expect(try decode(Skill.self, older).source == .manual)
    }

    @Test("The upload preview answers source upload; GitHub and zip previews still decode")
    func uploadPreview() throws {
        let preview = #"{"importId":"imp_1","source":"upload","sourceUrl":null,"skills":[{"name":"meeting-notes","description":"Turn notes into minutes","excerpt":"Write the minutes.","files":[],"hasScripts":false,"exists":false}],"warnings":[]}"#
        #expect(try decode(SkillImportPreview.self, preview).source == .upload)
        let zip = preview.replacingOccurrences(of: #""source":"upload""#, with: #""source":"zip""#)
        #expect(try decode(SkillImportPreview.self, zip).source == .zip)
    }

    @Test("X-Region: two ASCII letters, upper-cased; a UN M.49 number, an empty or missing region sends nothing")
    func region() {
        #expect(RegionCode.header("US") == "US")
        #expect(RegionCode.header("cn") == "CN")
        #expect(RegionCode.header("001") == nil)
        #expect(RegionCode.header("419") == nil)
        #expect(RegionCode.header("") == nil)
        #expect(RegionCode.header(nil) == nil)
        #expect(RegionCode.header("USA") == nil)
        #expect(RegionCode.header("Ü1") == nil)
    }
}
