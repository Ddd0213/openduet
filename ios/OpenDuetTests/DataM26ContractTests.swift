// M26 contract: a file row carries its origin, workspace path, task and artifact (an unknown or
// missing origin reads nil, an older server's row decodes with nils); a deleted file card keeps its
// kind and sets file.deletedAt; DELETE /api/files/:id takes alsoWorkspace and answers the deleted
// file, the message as it now reads and what became of the original.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M26 contract")
struct DataM26ContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    private let row = #"{"id":"f1","channelId":"ch_main","messageId":"m1","name":"build.mjs","mime":"text/javascript","size":18316,"source":"assistant","url":"/api/files/f1/content","createdAt":"2026-10-26T08:24:17.000Z","origin":"write","workspacePath":"tasks/t1/build.mjs","taskId":"t1","taskTitle":"AI model dashboard","artifactId":null,"deletedAt":null}"#

    @Test("A task's working file reads its origin, path, task id and title")
    func taskFile() throws {
        let file = try decode(ChannelFile.self, row)
        #expect(file.origin == .write)
        #expect(file.workspacePath == "tasks/t1/build.mjs")
        #expect(file.taskId == "t1" && file.taskTitle == "AI model dashboard")
        #expect(file.artifactId == nil && file.deletedAt == nil && !file.isDeleted)
    }

    @Test("Every origin decodes; an unknown one reads nil and the row still decodes")
    func origins() throws {
        for origin in FileOrigin.allCases {
            let json = row.replacingOccurrences(of: #""origin":"write""#, with: #""origin":"\#(origin.rawValue)""#)
            #expect(try decode(ChannelFile.self, json).origin == origin)
        }
        let newer = row.replacingOccurrences(of: #""origin":"write""#, with: #""origin":"email""#)
        let file = try decode(ChannelFile.self, newer)
        #expect(file.origin == nil && file.name == "build.mjs")
    }

    @Test("A row from a server before M26 decodes with every new field nil")
    func olderServer() throws {
        let older = #"{"id":"f2","channelId":"ch_main","messageId":"m2","name":"iana.html","mime":"text/html","size":10948,"source":"assistant","url":"/api/files/f2/content","createdAt":"2026-10-24T07:00:00.000Z"}"#
        let file = try decode(ChannelFile.self, older)
        #expect(file.origin == nil && file.workspacePath == nil && file.taskId == nil)
        #expect(file.taskTitle == nil && file.artifactId == nil && file.deletedAt == nil)
        let list = try decode(ChannelFileList.self, #"{"files":[\#(older)]}"#)
        #expect(list.files.count == 1)
    }

    @Test("A task deleted since keeps the task id with no title; an artifact's page names the artifact")
    func goneTaskAndArtifact() throws {
        let gone = row.replacingOccurrences(of: #""taskTitle":"AI model dashboard""#, with: #""taskTitle":null"#)
        let file = try decode(ChannelFile.self, gone)
        #expect(file.taskId == "t1" && file.taskTitle == nil)
        let page = row
            .replacingOccurrences(of: #""workspacePath":"tasks/t1/build.mjs""#, with: #""workspacePath":"artifacts/art_1/index.html""#)
            .replacingOccurrences(of: #""artifactId":null"#, with: #""artifactId":"art_1""#)
        #expect(try decode(ChannelFile.self, page).artifactId == "art_1")
    }

    @Test("A deleted file card keeps its kind, caption and name and sets deletedAt")
    func deletedCard() throws {
        let deletedRow = row.replacingOccurrences(of: #""deletedAt":null"#, with: #""deletedAt":"2026-10-30T09:15:00.000Z""#)
        let json = #"{"id":"m1","channelId":"ch_main","taskId":"t1","role":"assistant","kind":"file","text":"","status":"sent","clientId":null,"reactions":[],"stopped":false,"callId":null,"payload":{"file":\#(deletedRow),"caption":"The build script"},"createdAt":"2026-10-26T08:24:17.000Z","updatedAt":"2026-10-30T09:15:00.000Z"}"#
        let message = try decode(Message.self, json)
        guard case .file(let payload) = message.content else {
            Issue.record("expected a file card, got \(message.content)")
            return
        }
        #expect(payload.file.isDeleted && payload.file.name == "build.mjs" && payload.caption == "The build script")
        let image = json.replacingOccurrences(of: #""kind":"file""#, with: #""kind":"image""#)
        guard case .image(let shot) = try decode(Message.self, image).content else {
            Issue.record("expected an image card")
            return
        }
        #expect(shot.file.isDeleted)
    }

    @Test("DeleteFileRequest round-trips alsoWorkspace")
    func deleteRequest() throws {
        let body = try JSONCoding.encoder().encode(DeleteFileRequest(alsoWorkspace: true))
        let object = try JSONSerialization.jsonObject(with: body) as? [String: Bool]
        #expect(object == ["alsoWorkspace": true])
        #expect(try decode(DeleteFileRequest.self, #"{"alsoWorkspace":false}"#).alsoWorkspace == false)
    }

    @Test("DeleteFileResponse: the deleted file, the message or none, the workspace result (unknown reads nil)")
    func deleteResponse() throws {
        let deletedRow = row.replacingOccurrences(of: #""deletedAt":null"#, with: #""deletedAt":"2026-10-30T09:15:00.000Z""#)
        let none = try decode(DeleteFileResponse.self, #"{"file":\#(deletedRow),"message":null,"workspace":"deleted"}"#)
        #expect(none.file.isDeleted && none.message == nil && none.workspace == .deleted)
        let asked = try decode(DeleteFileResponse.self, #"{"file":\#(deletedRow),"message":null,"workspace":"not_asked"}"#)
        #expect(asked.workspace == .notAsked)
        let missing = try decode(DeleteFileResponse.self, #"{"file":\#(deletedRow),"message":null,"workspace":"missing"}"#)
        #expect(missing.workspace == .missing)
        let newer = try decode(DeleteFileResponse.self, #"{"file":\#(deletedRow),"message":null,"workspace":"archived"}"#)
        #expect(newer.workspace == nil)
    }

    @Test("The refusal codes match the server's")
    func refusals() {
        #expect(FileDeleteRefusal.allCases.map(\.rawValue) == ["protected_path", "computer_unreachable", "computer_busy"])
        let error = APIError(status: 409, body: Data(#"{"error":{"code":"protected_path","message":"This file belongs to an artifact."}}"#.utf8))
        #expect(error == .server(status: 409, code: FileDeleteRefusal.protectedPath.rawValue))
    }

    @Test("Code that builds a ChannelFile without the M26 fields still compiles and gets nils")
    func memberwise() {
        let file = ChannelFile(
            id: "f3", channelId: "ch_main", messageId: nil, name: "File", mime: "application/octet-stream",
            size: 0, source: .assistant, url: "/api/files/f3/content", createdAt: .now
        )
        #expect(file.origin == nil && file.deletedAt == nil && file.workspacePath == nil)
    }
}
