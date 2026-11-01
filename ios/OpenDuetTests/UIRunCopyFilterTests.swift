// M8 UI rules: run record title keys and built-in names resolve to their catalog text (every key
// of the contract's table), and the task detail's default conversation (TaskThreadFilter: the
// user's replies, OpenDuet's first and last words per turn, cards still waiting, the last failure
// line; the rest lives in the run records, OpenDuet's files as one "N files" row).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Run copy and task thread filter")
struct UIRunCopyFilterTests {
    private func localizedKey(_ phrase: Phrase) -> String? {
        if case .localized(let resource) = RunCopy.resolve(phrase) { return resource.key }
        return nil
    }

    @Test("Every contract title key has its English (catalog) text; unknown keys read \"Used a tool\"")
    func titles() {
        #expect(RunCopy.contractKeys.count == 30)
        for key in RunCopy.contractKeys {
            #expect(RunCopy.title(key: key) != nil, "\(key)")
        }
        #expect(RunCopy.title(key: "run.step.exec")?.key == "Ran a command")
        #expect(RunCopy.title(key: "run.title.scan")?.key == "First-day scan")
        #expect(localizedKey(Phrase(key: "run.step.web_search")) == "Searched the web")
        // M25: the built-in connectors' steps
        #expect(RunCopy.title(key: "run.step.weather")?.key == "Checked the weather")
        #expect(RunCopy.title(key: "run.step.exchange_rate")?.key == "Checked exchange rates")
        #expect(RunCopy.title(key: "run.step.read_feed")?.key == "Read a feed")
        #expect(localizedKey(Phrase(key: "run.step.someday")) == "Used a tool", "a newer server's key")
        if case .text(let text) = RunCopy.resolve(Phrase(text: "Send email")) {
            #expect(text == "Send email", "Composio display names stay as sent")
        } else {
            Issue.record("text phrase should stay text")
        }
    }

    @Test("Built-in names localize; Composio names stay; Command rows are monospaced")
    func builtInNames() {
        #expect(RunCopy.builtInName("OpenDuet's computer")?.key == "OpenDuet's computer")
        #expect(RunCopy.builtInName("Claude's computer")?.key == "OpenDuet's computer")
        #expect(RunCopy.builtInName("Claude")?.key == "OpenDuet")
        #expect(RunCopy.builtInName("Open Duet's computer")?.key == "OpenDuet's computer")
        #expect(RunCopy.builtInName("Open Duet")?.key == "OpenDuet")
        #expect(RunCopy.builtInName("Run commands")?.key == "Run commands")
        #expect(RunCopy.builtInName("Command")?.key == "Command")
        #expect(RunCopy.builtInName("Read file")?.key == "Read file")
        #expect(RunCopy.builtInName("Gmail") == nil)
        #expect(RunCopy.builtInName("Create calendar event") == nil)
        #expect(RunCopy.isCommandLabel("Command"))
        #expect(!RunCopy.isCommandLabel("Folder"))
        #expect(RunCopy.kind(.brief).key == "Morning brief")
    }

    private func file(_ id: String, at t: Int, role: String = "assistant", deleted: Bool = false) -> Message {
        var record: [String: Any] = [
            "id": "f_\(id)", "channelId": Fx.main, "messageId": id, "name": "\(id).pdf", "mime": "application/pdf",
            "size": 1200, "source": role, "url": "/files/f_\(id)", "createdAt": Fx.iso(t),
        ]
        if deleted { record["deletedAt"] = Fx.iso(t + 1) }
        var json = Fx.cardJSON(id, at: t, kind: "file", payload: [
            "file": record,
            "caption": "",
        ], taskId: "task_1")
        json["role"] = role
        return Fx.decode(Message.self, json)
    }

    private func system(_ id: String, at t: Int) -> Message {
        Fx.decode(Message.self, Fx.cardJSON(id, at: t, kind: "system", payload: ["phrase": ["text": "Couldn't reach Gmail"]], taskId: "task_1"))
    }

    private func thread(_ messages: [Message]) -> ThreadState {
        var state = ThreadState(context: .task)
        state.phase = .loaded
        state.messages = messages
        return state
    }

    @Test("Task detail shows the user, OpenDuet's first and last word per turn, waiting cards, the last failure")
    func filter() {
        let messages = [
            Fx.message("u1", at: 1, text: "Find the renewal email", role: "user", taskId: "task_1"),
            Fx.message("c1", at: 2, text: "I'll take a look", taskId: "task_1"),
            Fx.message("c2", at: 3, text: "Reading your inbox now", taskId: "task_1"),
            file("f1", at: 4),
            Fx.approvalCard("a1", at: 5, approval: Fx.approvalJSON("apr_1", message: "a1"), taskId: "task_1"),
            Fx.approvalCard("a2", at: 6, approval: Fx.approvalJSON("apr_2", message: "a2", status: "approved"), taskId: "task_1"),
            system("s0", at: 7),
            Fx.message("c3", at: 8, text: "Drafted the reply", taskId: "task_1"),
            Fx.message("u2", at: 9, text: "Send it", role: "user", taskId: "task_1"),
            file("f2", at: 10, role: "user"),
            system("s1", at: 11),
        ]
        let result = TaskThreadFilter.apply(thread(messages))
        #expect(result.thread.messages.map(\.id) == ["u1", "c1", "a1", "c3", "u2", "f2", "s1"])
        #expect(result.files.map(\.id) == ["f_f1"], "only OpenDuet's files make the N files row")
        // M26: a file OpenDuet sent and the user deleted since isn't in the N files row.
        let withDeleted = TaskThreadFilter.apply(thread(messages + [file("f3", at: 12, deleted: true)]))
        #expect(withDeleted.files.map(\.id) == ["f_f1"])
        #expect(result.thread.phase == .loaded && result.thread.context == .task)

        // A card decided during the visit stays where it was (its check and fold play there).
        let kept = TaskThreadFilter.apply(thread(messages), keeping: ["a2", "gone"])
        #expect(kept.thread.messages.map(\.id).contains("a2"))
        #expect(TaskThreadFilter.awaitingUser(messages) == ["a1"])

        // The failure line shows only while it is the last thing in the thread.
        let older = TaskThreadFilter.apply(thread(Array(messages.dropLast())))
        #expect(!older.thread.messages.map(\.id).contains("s0"))
        #expect(TaskThreadFilter.isReply(messages[1]) && !TaskThreadFilter.isReply(messages[0]))
    }
}
