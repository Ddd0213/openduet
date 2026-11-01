// M23 contract: the source of background writes, the brief's unchecked sources and the cards'
// suggestionId decode; payloads from before M23 still decode; an unknown source kind reads nil.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M23 contract")
struct DataM23ContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    @Test("A fact or suggestion from before M23 has no source; a newer source kind keeps the title")
    func sources() throws {
        let old = try decode(MemoryFact.self, #"{"id":"m","text":"x","source":"assistant","sourceMessageId":null,"createdAt":"2026-11-02T01:00:00.000Z"}"#)
        #expect(old.sourceRef == nil)
        let fact = try decode(MemoryFact.self, #"{"id":"m","text":"x","createdAt":"2026-11-02T01:00:00.000Z","sourceRef":{"app":"Gmail","kind":"fax","title":"Re: Q4","at":null}}"#)
        #expect(fact.sourceRef?.kind == nil)
        #expect(fact.sourceRef?.title == "Re: Q4")
        let suggestion = try decode(Suggestion.self, #"{"id":"s","channelId":null,"title":"T","body":"","app":"Gmail","origin":"checkin","createdAt":"2026-11-02T01:00:00.000Z"}"#)
        #expect(suggestion.sourceRef == nil)
    }

    @Test("The brief's unchecked sources and the cards' suggestionId decode; older payloads read nil")
    func briefAndCards() throws {
        let text = try decode(TextPayload.self, #"{"skill":null,"attachments":[],"brief":{"unchecked":["Gmail"]}}"#)
        #expect(text.brief?.unchecked == ["Gmail"])
        let plain = try decode(TextPayload.self, #"{"skill":null,"attachments":[]}"#)
        #expect(plain.brief == nil)
        let card = try decode(ProactiveSuggestionPayload.self, #"{"title":"T","body":"B","prompt":"P","state":"open","taskId":null,"suggestionId":"sug_1"}"#)
        #expect(card.suggestionId == "sug_1")
        let older = try decode(ProactiveSuggestionPayload.self, #"{"title":"T","body":"B","prompt":"P","state":"open","taskId":null}"#)
        #expect(older.suggestionId == nil)
    }
}
