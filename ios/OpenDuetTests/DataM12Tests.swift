// M12 data: the tri-state request bodies (left out = unchanged, null = back to the default), the
// model_error payload, the channel's model fields and Features.models with older servers.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum M12Data {
    static func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONCoding.encoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    static func channel(_ extra: String) -> String { channelTemplate.replacingOccurrences(of: "EXTRA", with: extra) }

    static func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(text.utf8))
    }

    static let channelTemplate = """
    {"id":"ch_1","isMain":false,"name":"Shop","icon":"checkbox","colorHex":"#E69F4E","purpose":"",
     "archived":false,"unreadCount":0,"lastReadAt":null,"lastMessageAt":null,"createdAt":"2026-11-01T09:00:00.000Z"EXTRA}
    """
}

@Suite("M12 tri-state requests")
struct DataM12TriStateTests {
    @Test("UpdateChannelRequest: nil leaves the key out, .clear sends null, .set the value")
    func channel() throws {
        var body = UpdateChannelRequest()
        #expect(try M12Data.json(body).isEmpty)
        body.modelId = .clear
        var object = try M12Data.json(body)
        #expect(object.keys.sorted() == ["modelId"])
        #expect(object["modelId"] is NSNull)
        body.modelId = .set("mdl_1")
        body.thinkingLevel = .set(.high)
        object = try M12Data.json(body)
        #expect(object["modelId"] as? String == "mdl_1")
        #expect(object["thinkingLevel"] as? String == "high")
    }

    @Test("UpdateChannelRequest decodes a null as .clear and a missing key as unchanged")
    func channelDecode() throws {
        let cleared = try M12Data.decode(UpdateChannelRequest.self, #"{"modelId":null}"#)
        #expect(cleared.modelId == .clear)
        #expect(cleared.thinkingLevel == nil)
        let older = try M12Data.decode(UpdateChannelRequest.self, #"{"archived":true}"#)
        #expect(older.archived == true && older.modelId == nil)
    }

    @Test("UpdateModelDefaultsRequest and UpdateModelEntryRequest keep the three states apart")
    func defaultsAndEntry() throws {
        let defaults = UpdateModelDefaultsRequest(defaultModelId: nil, defaultThinking: .set(.high), utilityModelId: .clear)
        let object = try M12Data.json(defaults)
        #expect(object.keys.sorted() == ["defaultThinking", "utilityModelId"])
        #expect(object["utilityModelId"] is NSNull)
        let entry = UpdateModelEntryRequest(label: "Sonnet", defaultThinking: .clear)
        let entryObject = try M12Data.json(entry)
        #expect(entryObject.keys.sorted() == ["defaultThinking", "label"])
        #expect(entryObject["defaultThinking"] is NSNull)
    }

    @Test("Patch(value) is .set, Patch(nil) is .clear")
    func patchInit() {
        #expect(Patch<String>("a") == .set("a"))
        #expect(Patch<String>(nil) == .clear)
        #expect(Patch<String>.set("a").value == "a")
        #expect(Patch<String>.clear.value == nil)
    }

    @Test("MessageActionRequest: retry with and without a model; modelId is left out when nil")
    func retry() throws {
        let plain = try M12Data.json(MessageActionRequest(action: .retry, itemId: nil))
        #expect(plain.keys.sorted() == ["action"])
        #expect(plain["action"] as? String == "retry")
        let pinned = try M12Data.json(MessageActionRequest(action: .retry, itemId: nil, modelId: "mdl_flash"))
        #expect(pinned["modelId"] as? String == "mdl_flash")
    }

    @Test("CreateModelProviderRequest sends the protocol under its wire name")
    func providerProtocol() throws {
        let body = CreateModelProviderRequest(kind: .custom, wireProtocol: .anthropic, baseUrl: "https://llm.example.com", auth: .bearer, key: "k")
        let object = try M12Data.json(body)
        #expect(object["protocol"] as? String == "anthropic")
        #expect(object["auth"] as? String == "bearer")
        #expect(object["name"] == nil && object["headers"] == nil)
    }
}

@Suite("M12 payloads")
struct DataM12PayloadTests {
    @Test("a model_error message decodes into its card")
    func modelError() throws {
        let text = """
        {"id":"m1","channelId":"ch_1","taskId":null,"role":"system","text":"","status":"sent","clientId":null,
         "reactions":[],"createdAt":"2026-11-01T09:00:05.000Z","updatedAt":"2026-11-01T09:00:05.000Z",
         "kind":"model_error","payload":{"phrase":{"key":"system.no_model"},"modelId":null,"modelLabel":null,
         "runId":"run_1","retry":false,"state":"open"}}
        """
        let message = try M12Data.decode(Message.self, text)
        guard case .modelError(let card) = message.content else {
            Issue.record("decoded as \(message.content)")
            return
        }
        #expect(card.phrase.key == "system.no_model")
        #expect(card.retry == false && card.state == .open && card.modelId == nil)
    }

    @Test("a channel without the M12 fields uses the default; with them they're read")
    func channelFields() throws {
        let older = try M12Data.decode(Channel.self, M12Data.channel(""))
        #expect(older.modelId == nil && older.thinkingLevel == nil)
        let newer = try M12Data.decode(Channel.self, M12Data.channel(#","modelId":"mdl_1","thinkingLevel":"xhigh""#))
        #expect(newer.modelId == "mdl_1" && newer.thinkingLevel == .xhigh)
        let unknown = try M12Data.decode(Channel.self, M12Data.channel(#","thinkingLevel":"ultra""#))
        #expect(unknown.thinkingLevel == nil)
    }

    @Test("Features.models is true when an older server leaves it out")
    func features() throws {
        let older = try M12Data.decode(Features.self, #"{"connectors":true,"webSearch":false,"push":null,"computer":true}"#)
        #expect(older.models)
        let none = try M12Data.decode(Features.self, #"{"connectors":true,"webSearch":false,"push":"ntfy","computer":true,"models":false}"#)
        #expect(!none.models && none.push == .ntfy)
    }

    @Test("the thinking format's none reads as noThinking")
    func formatNone() throws {
        let format = try M12Data.decode([ThinkingFormat].self, #"["none","budget"]"#)
        #expect(format == [.noThinking, .budget])
    }
}
