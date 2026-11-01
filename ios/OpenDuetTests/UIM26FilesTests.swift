// M26 W2: the Files page's groups (FileGroups: every origin, a list from a server before M26, a
// task deleted since, a task's send staying in "OpenDuet sent you", empty groups left out, the
// order), the delete confirmation's switch, the request's query, the refusal lines by code, what
// counts as deleted, and a deleted file leaving a loaded list (FileDeleteRules, FileLists).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private func row(
    _ id: String, origin: FileOrigin?, source: ChannelFile.Source = .assistant, task: String? = nil, title: String? = nil,
    path: String? = nil, artifact: String? = nil, deleted: Bool = false, at t: Int
) -> ChannelFile {
    ChannelFile(
        id: id, channelId: Fx.main, messageId: "m_\(id)", name: "\(id).txt", mime: "text/plain", size: 10,
        source: source, url: "/api/files/\(id)/content", createdAt: Fx.date(t),
        origin: origin, workspacePath: path, taskId: task, taskTitle: title, artifactId: artifact,
        deletedAt: deleted ? Fx.date(t + 1) : nil
    )
}

@Suite("Files page: groups by origin (M26)")
struct UIM26FileGroupTests {
    @Test("every origin lands in its group, and the groups come in the page's order")
    func everyOrigin() {
        let files = [
            row("old", origin: nil, at: 95),
            row("taskWrite", origin: .write, task: "t1", title: "Dashboard", at: 90),
            row("shot", origin: .screenshot, at: 80),
            row("up", origin: .upload, source: .user, at: 70),
            row("chatWrite", origin: .write, at: 60),
            row("send", origin: .send, at: 50),
        ]
        let groups = FileGroups.groups(files)
        #expect(groups.map(\.kind) == [.sent, .uploaded, .screenshots, .task(id: "t1", title: "Dashboard"), .other])
        #expect(groups[0].files.map(\.id) == ["chatWrite", "send"])
        #expect(groups[1].files.map(\.id) == ["up"])
        #expect(groups[2].files.map(\.id) == ["shot"])
        #expect(groups[3].files.map(\.id) == ["taskWrite"])
        #expect(groups[4].files.map(\.id) == ["old"])
    }

    @Test("a list from a server before M26: the user's files under You uploaded, OpenDuet's under Other")
    func preM26() {
        func json(_ id: String, source: String, at t: Int) -> [String: Any] {
            [
                "id": id, "channelId": Fx.main, "messageId": "m_\(id)", "name": "\(id).pdf", "mime": "application/pdf",
                "size": 2048, "source": source, "url": "/api/files/\(id)/content", "createdAt": Fx.iso(t),
            ]
        }
        let list = Fx.decode(ChannelFileList.self, ["files": [json("c1", source: "assistant", at: 30), json("u1", source: "user", at: 20), json("c2", source: "assistant", at: 10)]])
        let groups = FileGroups.groups(list.files)
        #expect(groups.map(\.kind) == [.uploaded, .other])
        #expect(groups[0].files.map(\.id) == ["u1"])
        #expect(groups[1].files.map(\.id) == ["c1", "c2"])
    }

    @Test("a task deleted since: its group has no title and opens nothing")
    func deletedTask() {
        let groups = FileGroups.groups([
            row("a", origin: .write, task: "gone", at: 30),
            row("b", origin: .write, task: "live", title: "Weekly report", at: 20),
            row("c", origin: .write, task: "gone", at: 10),
        ])
        #expect(groups.map(\.kind) == [.task(id: "gone", title: nil), .task(id: "live", title: "Weekly report")])
        #expect(groups[0].files.map(\.id) == ["a", "c"])
        #expect(groups[0].taskLink == nil)
        #expect(groups[1].taskLink?.absoluteString == "duet://tasks/live")
        #expect(groups[1].taskLink.flatMap(DuetRoute.init) == .task(id: "live"))
    }

    @Test("a send or screenshot made in a task stays in its own group and names the task")
    func sendInATaskStays() {
        let send = row("s", origin: .send, task: "t1", title: "Dashboard", at: 30)
        let shot = row("p", origin: .screenshot, task: "t1", title: "Dashboard", at: 20)
        let work = row("w", origin: .write, task: "t1", title: "Dashboard", at: 10)
        let groups = FileGroups.groups([send, shot, work])
        #expect(groups.map(\.kind) == [.sent, .screenshots, .task(id: "t1", title: "Dashboard")])
        #expect(FileGroups.taskLine(send) == "Dashboard")
        #expect(FileGroups.taskLine(shot) == "Dashboard")
        // The task group says it already; a chat file and a send from a deleted task have none.
        #expect(FileGroups.taskLine(work) == nil)
        #expect(FileGroups.taskLine(row("c", origin: .send, at: 0)) == nil)
        #expect(FileGroups.taskLine(row("d", origin: .send, task: "gone", at: 0)) == nil)
    }

    @Test("empty groups are left out")
    func emptyGroupsHidden() {
        #expect(FileGroups.groups([]).isEmpty)
        #expect(FileGroups.groups([row("u", origin: .upload, source: .user, at: 0)]).map(\.kind) == [.uploaded])
        // A deleted row never shows (lists don't carry them, but a stale copy mustn't make a group).
        #expect(FileGroups.groups([row("x", origin: .screenshot, deleted: true, at: 0)]).isEmpty)
    }

    @Test("task groups come newest task first; every group keeps the list's newest-first order")
    func order() {
        let groups = FileGroups.groups([
            row("t2new", origin: .write, task: "t2", title: "Second", at: 90),
            row("s1", origin: .send, at: 85),
            row("t1new", origin: .write, task: "t1", title: "First", at: 80),
            row("t2old", origin: .write, task: "t2", title: "Second", at: 70),
            row("s2", origin: .send, at: 65),
            row("t1old", origin: .write, task: "t1", title: "First", at: 60),
        ])
        #expect(groups.map(\.id) == ["sent", "task:t2", "task:t1"])
        #expect(groups[0].files.map(\.id) == ["s1", "s2"])
        #expect(groups[1].files.map(\.id) == ["t2new", "t2old"])
        #expect(groups[2].files.map(\.id) == ["t1new", "t1old"])
    }

    @Test("an artifact's page opens the artifact; other rows open the preview")
    func artifactRows() {
        let page = row("page", origin: .send, path: "artifacts/art_1/index.html", artifact: "art_1", at: 0)
        #expect(FileGroups.artifactLink(page)?.absoluteString == "duet://artifacts/art_1")
        #expect(FileGroups.artifactLink(page).flatMap(DuetRoute.init) == .artifact(id: "art_1"))
        #expect(FileGroups.artifactLink(row("f", origin: .send, path: "artifacts/gone/index.html", at: 0)) == nil)
    }
}

@Suite("Files page: delete with \"Also delete from OpenDuet's computer\" (M26)")
struct UIM26FileDeleteTests {
    private func error(_ status: Int, _ code: String, field: String? = nil) -> APIError {
        var detail: [String: Any] = ["code": code, "message": "from the server"]
        if let field { detail["field"] = field }
        let body = (try? JSONSerialization.data(withJSONObject: ["error": detail])) ?? Data()
        return APIError(status: status, body: body)
    }

    @Test("the switch shows only for an original outside artifacts/ and .skills/")
    func switchRule() {
        func offers(_ path: String?) -> Bool {
            FileDeleteRules.offersWorkspaceDelete(row("f", origin: .write, path: path, at: 0))
        }
        #expect(offers("build/build.py"))
        #expect(offers("shuang11_calc.js"))
        #expect(offers("uploads/cmvs1a2b-receipt.pdf"))
        #expect(offers("tasks/t1/build.mjs"))
        #expect(offers("data/artifacts/x.csv"))  // only the first folder counts
        #expect(offers("artifacts.md"))          // a file named like the folder isn't in it
        #expect(!offers("artifacts/art_1/index.html"))
        #expect(!offers(".skills/pdf/SKILL.md"))
        #expect(!offers("artifacts"))
        #expect(!offers(nil))
        #expect(!offers(""))
    }

    @Test("the request asks for the original only with the switch on, as a query")
    func query() throws {
        #expect(FileDeleteRules.query(alsoWorkspace: false).isEmpty)
        #expect(FileDeleteRules.query(alsoWorkspace: true) == [URLQueryItem(name: "alsoWorkspace", value: "true")])
        let server = try ServerAddress.parse("https://duet.example.com").get()
        let on = server.url(path: "/api/files/f1", query: FileDeleteRules.query(alsoWorkspace: true))
        let off = server.url(path: "/api/files/f1", query: FileDeleteRules.query(alsoWorkspace: false))
        #expect(on?.absoluteString == "https://duet.example.com/api/files/f1?alsoWorkspace=true")
        #expect(off?.absoluteString == "https://duet.example.com/api/files/f1")
    }

    @Test("each refusal has its own line, and only a passing one offers Retry")
    func refusals() {
        let protected = FileDeleteRules.failure(error(409, "protected_path"))
        #expect(protected.reason == "This file belongs to an artifact or a skill on OpenDuet's computer. Delete it there.")
        #expect(!protected.retries && !protected.offersChatOnly)

        let unreachable = FileDeleteRules.failure(error(503, "computer_unreachable"))
        #expect(unreachable.reason == "Couldn't reach OpenDuet's computer. Nothing was deleted.")
        #expect(unreachable.retries)

        let busy = FileDeleteRules.failure(error(409, "computer_busy"))
        #expect(busy.reason == "You're using OpenDuet's browser. Hand it back and try again.")
        #expect(busy.retries)

        let notSetUp = FileDeleteRules.failure(error(503, "not_configured"))
        #expect(notSetUp.reason == "OpenDuet's computer isn't set up.")
        #expect(!notSetUp.retries)

        let gone = FileDeleteRules.failure(error(400, "validation_failed", field: "alsoWorkspace"))
        #expect(gone.reason == "This file isn't on OpenDuet's computer any more.")
        #expect(gone.offersChatOnly && !gone.retries)
    }

    @Test("the old \"part of the conversation\" line is gone; other failures read as usual")
    func otherFailures() {
        let other = FileDeleteRules.failure(error(400, "validation_failed", field: "file"))
        #expect(!other.reason.contains("part of the conversation"))
        #expect(other.reason == "Something went wrong.")
        #expect(!other.offersChatOnly && other.retries)
        let offline = FileDeleteRules.failure(APIError.unreachable)
        #expect(offline.reason == "Can't reach your server.")
        #expect(offline.retries)
    }

    @Test("a 200, a body that doesn't decode and a 404 count as deleted; a refusal doesn't")
    func outcomes() {
        let file = row("f", origin: .send, deleted: true, at: 0)
        let response = DeleteFileResponse(file: file, message: nil, workspace: .missing)
        #expect(FileDeleteRules.outcome(.success(response)) == .deleted(response))
        #expect(FileDeleteRules.outcome(.success(nil)) == .deleted(nil))
        #expect(FileDeleteRules.outcome(.failure(APIError.notFound)) == .deleted(nil))
        #expect(FileDeleteRules.outcome(.failure(error(404, "not_found"))) == .deleted(nil))
        #expect(FileDeleteRules.outcome(.failure(CancellationError())) == .cancelled)
        guard case .refused(let failure) = FileDeleteRules.outcome(.failure(error(409, "protected_path"))) else {
            Issue.record("a refusal deletes nothing")
            return
        }
        #expect(!failure.retries)
    }

    @Test("a deleted file leaves a loaded list instead of joining it")
    func removal() {
        let list = [row("b", origin: .send, at: 30), row("a", origin: .write, at: 10)]
        #expect(FileLists.upsert(row("b", origin: .send, deleted: true, at: 30), into: list).map(\.id) == ["a"])
        // Not in the list: it isn't added either.
        #expect(FileLists.upsert(row("z", origin: .send, deleted: true, at: 40), into: list).map(\.id) == ["b", "a"])
        // The live copy still joins as before.
        #expect(FileLists.upsert(row("c", origin: .send, at: 20), into: list).map(\.id) == ["b", "c", "a"])
    }

    @Test("a deleted card from the `message` event carries the file to drop")
    func deletedCard() {
        var json = Fx.messageJSON("m1", at: 0)
        json["kind"] = "file"
        json["payload"] = [
            "file": [
                "id": "f1", "channelId": Fx.main, "messageId": "m1", "name": "x.csv", "mime": "text/csv", "size": 10,
                "source": "assistant", "url": "/api/files/f1/content", "createdAt": Fx.iso(0), "origin": "send",
                "workspacePath": "x.csv", "taskId": NSNull(), "taskTitle": NSNull(), "artifactId": NSNull(),
                "deletedAt": Fx.iso(5),
            ],
            "caption": "",
        ]
        let files = FileLists.files(in: Fx.decode(Message.self, json))
        #expect(files.map(\.id) == ["f1"] && files.allSatisfy(\.isDeleted))
        let list = [row("f1", origin: .send, at: 0), row("f2", origin: .send, at: -10)]
        #expect(files.reduce(list) { FileLists.upsert($1, into: $0) }.map(\.id) == ["f2"])
    }

    @Test("the preview of a file that answers 404 says it was deleted")
    func previewLine() {
        #expect(FileDeleteRules.previewReason(APIError.notFound) == "This file was deleted.")
        #expect(FileDeleteRules.previewReason(APIError.unreachable) == "Can't reach your server.")
    }

    @Test("the already-gone note survives the reload as the preview closes, not a later refresh")
    func noteGrace() {
        let at = Fx.date(0)
        #expect(FileDeleteRules.keepsNote(setAt: at, now: Fx.date(1)))
        #expect(!FileDeleteRules.keepsNote(setAt: at, now: Fx.date(3)))
    }
}
