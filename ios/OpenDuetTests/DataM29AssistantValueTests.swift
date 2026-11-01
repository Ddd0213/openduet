// M29: the wire value for "the assistant did it" is "assistant" (role, by, source, controller). Servers
// before the rename, cached rows and old samples send "claude": every such enum (AssistantValue) reads
// it as .assistant, an unknown value still fails like before, and what the app encodes is only
// "assistant".
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M29 assistant wire value")
struct DataM29AssistantValueTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    private func values<T: Decodable>(_ type: T.Type, _ raw: String) throws -> T {
        try decode([T].self, #"["\#(raw)"]"#)[0]
    }

    @Test("\"assistant\" and the older \"claude\" both read as .assistant in every enum that has it")
    func bothValues() throws {
        for raw in ["assistant", "claude"] {
            #expect(try values(Message.Role.self, raw) == .assistant)
            #expect(try values(Reaction.By.self, raw) == .assistant)
            #expect(try values(TextPayload.ReplyTo.Role.self, raw) == .assistant)
            #expect(try values(MemorySource.self, raw) == .assistant)
            #expect(try values(SkillSource.self, raw) == .assistant)
            #expect(try values(ChannelFile.Source.self, raw) == .assistant)
            #expect(try values(ComputerState.Controller.self, raw) == .assistant)
            #expect(try values(ArtifactVersion.By.self, raw) == .assistant)
        }
        #expect(try values(Message.Role.self, "system") == .system)
        #expect(try values(ComputerState.Controller.self, "user") == .user)
        #expect(try values(MemorySource.self, "dreaming") == .dreaming)
    }

    @Test("A value neither side knows still fails, so the types' own fallbacks apply")
    func unknownValue() throws {
        #expect(throws: DecodingError.self) { try values(Message.Role.self, "robot") }
        #expect(throws: DecodingError.self) { try values(Message.Role.self, "Claude") }
        let version = try decode(ArtifactVersion.self, #"{"id":"v1","artifactId":"a","by":"robot","reason":"edit","prompt":null,"createdAt":"2026-11-03T09:12:00.000Z"}"#)
        #expect(version.by == nil)
        let fact = try decode(MemoryFact.self, #"{"id":"m","text":"x","source":"robot","sourceMessageId":null,"createdAt":"2026-11-02T01:00:00.000Z"}"#)
        #expect(fact.source == .assistant)
    }

    @Test("A message from an older server: role, reactions and the quoted reply all read \"claude\" as the assistant")
    func olderMessage() throws {
        var json = Fx.messageJSON("m1", at: 0, role: "claude")
        json["reactions"] = [["emoji": "👍", "by": "claude"], ["emoji": "❤️", "by": "user"]]
        json["payload"] = ["skill": NSNull(), "attachments": [], "replyTo": ["messageId": "m0", "role": "claude", "excerpt": "Here"]]
        let message = Fx.decode(Message.self, json)
        #expect(message.role == .assistant)
        #expect(message.reactions.map(\.by) == [.assistant, .user])
        guard case .text(let payload) = message.content else { Issue.record("not a text message"); return }
        #expect(payload.replyTo?.role == .assistant)
    }

    @Test("Older computer state, artifact version, file, fact and skill rows read \"claude\" as the assistant")
    func olderRows() throws {
        let computer = try decode(ComputerState.self, #"{"available":true,"browser":"ready","controller":"claude","url":null,"domain":null,"blocked":null}"#)
        #expect(computer.controller == .assistant)
        let version = try decode(ArtifactVersion.self, #"{"id":"v2","artifactId":"a","by":"claude","reason":"edit","prompt":"Make it blue","createdAt":"2026-11-03T09:00:00.000Z"}"#)
        #expect(version.by == .assistant)
        let file = try decode(ChannelFile.self, #"{"id":"f1","channelId":"ch_main","messageId":"m1","name":"a.txt","mime":"text/plain","size":1,"source":"claude","url":"/api/files/f1/content","createdAt":"2026-10-24T07:00:00.000Z"}"#)
        #expect(file.source == .assistant)
        let fact = try decode(MemoryFact.self, #"{"id":"m","text":"x","source":"claude","sourceMessageId":null,"createdAt":"2026-11-02T01:00:00.000Z"}"#)
        #expect(fact.source == .assistant)
        let skill = try decode(Skill.self, #"{"id":"s","name":"n","description":"d","instructions":"i","createdAt":"2026-11-02T01:00:00.000Z","source":"claude"}"#)
        #expect(skill.source == .assistant)
    }

    @Test("What the app encodes is \"assistant\", never \"claude\"")
    func encodesNewValue() throws {
        let data = try JSONCoding.encoder().encode([MemorySource.assistant, .user])
        #expect(String(decoding: data, as: UTF8.self) == #"["assistant","user"]"#)
        let skill = try JSONCoding.encoder().encode([SkillSource.assistant])
        #expect(String(decoding: skill, as: UTF8.self) == #"["assistant"]"#)
        #expect(Message.Role.assistant.rawValue == "assistant")
        #expect(ComputerState.Controller.assistant.rawValue == "assistant")
    }
}
