// M9 data layer (contract §2-§5): every new M9 sample in docs/api-samples decodes into the app's
// models; requests carry the keys the server needs; a form card's optimistic Submit / Skip and its
// rollback; pinned tasks first; task_deleted / channel_deleted; the Usage panel's per-range cache.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

/// docs/api-samples: the test bundle's copy (Xcode), else the repo next to this file (host tests).
enum M9Samples {
    static func json(_ name: String) throws -> [String: Any] {
        let url = try directory().appending(path: "\(name).json")
        return try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    /// One shape of a sample file (an object or a list of them), decoded with the app's coder.
    static func decode<T: Decodable>(_ type: T.Type, _ file: String, _ shape: String) throws -> [T] {
        let value = try #require(try json(file)[shape], "no \(shape) in \(file).json")
        let items = (value as? [Any]) ?? [value]
        return try items.map { try JSONCoding.decoder().decode(T.self, from: JSONSerialization.data(withJSONObject: $0)) }
    }

    private final class Token {}

    private static func directory() throws -> URL {
        if let bundled = Bundle(for: Token.self).url(forResource: "api-samples", withExtension: nil) { return bundled }
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let dir = repo.appending(path: "docs/api-samples", directoryHint: .isDirectory)
        try #require(FileManager.default.fileExists(atPath: dir.path), "docs/api-samples not found at \(dir.path)")
        return dir
    }
}

@Suite("M9 samples")
struct DataM9SampleTests {
    @Test("form, card and icon'd task suggestions decode (not as unsupported)")
    func messageKinds() throws {
        let page = try #require(try M9Samples.decode(MessagePage.self, "messages", "MessagePage").first)
        let byId = Dictionary(uniqueKeysWithValues: page.messages.map { ($0.id, $0) })

        guard case .form(let open)? = byId["msg_form"]?.content else { Issue.record("msg_form isn't a form"); return }
        #expect(open.state == .open)
        #expect(open.answers == nil)
        #expect(open.fields.count >= 2)
        if case .single(let options, let allowOther) = open.fields[0].kind {
            #expect(!options.isEmpty)
            #expect(allowOther)
        } else {
            Issue.record("the first field is a single choice")
        }

        guard case .form(let done)? = byId["msg_form_done"]?.content else { Issue.record("msg_form_done isn't a form"); return }
        #expect(done.state == .submitted)
        #expect(done.answers == [FormAnswer(fieldId: "f_len", optionIds: ["o_short"], text: nil)])

        guard case .card(let card)? = byId["msg_card"]?.content else { Issue.record("msg_card isn't a card"); return }
        #expect(card.icon == .dashboard)
        #expect(card.tint == .blue)
        #expect(!card.blocks.isEmpty)
        #expect(!card.blocks.contains { if case .unsupported = $0 { true } else { false } })

        guard case .taskSuggestions(let suggestions)? = byId["msg_sugg_icon"]?.content else { Issue.record("msg_sugg_icon"); return }
        #expect(suggestions.items.first?.icon == .doc)
        guard case .taskSuggestions(let plain)? = byId["msg_sugg"]?.content else { Issue.record("msg_sugg"); return }
        #expect(plain.items.allSatisfy { $0.icon == nil })
    }

    @Test("a form submit re-encodes with \"text\": null on every answer (the server needs the key)")
    func formSubmitEncodesNullText() throws {
        let requests = try M9Samples.decode(SendMessageRequest.self, "messages", "SendMessageRequest")
        let submit = try #require(requests.first { $0.form != nil })
        #expect(submit.form?.messageId == "msg_form")
        let encoded = try JSONCoding.encoder().encode(submit)
        let object = try #require(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let answers = try #require((object["form"] as? [String: Any])?["answers"] as? [[String: Any]])
        #expect(answers.count == 2)
        for answer in answers {
            #expect(answer.keys.contains("text"))
            #expect(answer["text"] is NSNull)
        }
        // A typed answer keeps its text.
        let typed = try JSONCoding.encoder().encode(FormAnswer(fieldId: "f", optionIds: [], text: "Mornings"))
        #expect(String(decoding: typed, as: UTF8.self).contains(#""text":"Mornings""#))
    }

    @Test("PATCH /api/tasks/:id sends only the keys that change (no nulls for .partial() fields)")
    func taskPatchOmitsUnsetKeys() throws {
        func keys(_ request: UpdateTaskRequest) throws -> Set<String> {
            let object = try JSONSerialization.jsonObject(with: JSONCoding.encoder().encode(request)) as? [String: Any]
            return Set(object?.keys.map { $0 } ?? [])
        }
        #expect(try keys(UpdateTaskRequest(status: nil, archived: nil, pinned: true)) == ["pinned"])
        #expect(try keys(UpdateTaskRequest(status: nil, archived: nil, paused: false)) == ["paused"])
        let schedule = Schedule(cadence: .weekdays, hour: 8, minute: 30, weekday: nil, at: nil)
        #expect(try keys(UpdateTaskRequest(status: nil, archived: nil, schedule: schedule, title: "Brief")) == ["schedule", "title"])
        let encoded = try JSONCoding.encoder().encode(schedule)
        let object = try #require(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(Set(object.keys) == ["cadence", "hour", "minute"])
    }

    @Test("routines, pins and their runs decode; older task rows default to unpinned, no routine")
    func tasks() throws {
        let list = try #require(try M9Samples.decode(TaskList.self, "tasks", "TaskList").first)
        let byId = Dictionary(uniqueKeysWithValues: list.tasks.map { ($0.id, $0) })
        #expect(byId["task_1"]?.pinned == false)
        #expect(byId["task_1"]?.routine == nil)
        #expect(byId["task_6"]?.pinned == true)
        let routine = try #require(byId["task_5"]?.routine)
        #expect(byId["task_5"]?.status == .scheduled)
        #expect(byId["task_5"]?.schedule?.cadence == .daily)
        #expect(!routine.paused)
        #expect(routine.nextRunAt != nil)
        #expect(routine.lastRunStatus == .completed)

        let runs = try #require(try M9Samples.decode(RoutineRuns.self, "tasks", "RoutineRuns").first).runs
        #expect(runs.map(\.kind) == [.routine, .routine])
        #expect(runs.map(\.status) == [.completed, .skipped])

        let info = try #require(try M9Samples.decode(ScheduleInfo.self, "tasks", "ScheduleInfo").first)
        #expect(info.builtins == false)
    }

    @Test("usage stats decode for a busy and an empty range")
    func usageStats() throws {
        let stats = try M9Samples.decode(UsageStats.self, "account", "UsageStats")
        #expect(stats.map(\.range) == [.sevenDays, .all])
        let week = stats[0]
        #expect(week.bucket == .day)
        #expect(week.estimated)
        #expect(week.byKind.map(\.kind) == [.chat, .task, .build, .proactive])
        #expect(week.totals.total == week.totals.inputTokens + week.totals.outputTokens)
        #expect(stats[1].series.isEmpty)
        #expect(stats[1].totals.runs == 0)
    }

    @Test("task_deleted and channel_deleted events decode")
    func deleteEvents() throws {
        let events = try M9Samples.decode(DuetEvent.self, "events", "DuetEvent")
        #expect(events.contains { if case .taskDeleted(taskId: "task_6") = $0.body { true } else { false } })
        #expect(events.contains { if case .channelDeleted(channelId: "ch_q4") = $0.body { $0.channelId == "ch_q4" } else { false } })
    }
}

@Suite("M9 form submit")
struct DataM9FormTests {
    private static func formJSON(_ id: String = "msg_f", state: String = "open", updated: Int = 10) -> [String: Any] {
        Fx.cardJSON(id, at: 10, kind: "form", payload: [
            "title": "Reply length", "description": NSNull(), "icon": "chat", "submitLabel": NSNull(),
            "state": state, "answers": NSNull(),
            "fields": [[
                "id": "f_len", "type": "single", "label": "How long?", "required": true, "allowOther": false,
                "options": [["id": "o_short", "label": "Short", "detail": NSNull()], ["id": "o_long", "label": "Long", "detail": NSNull()]],
            ]],
        ], updated: updated)
    }

    private func form(_ reducer: ThreadReducer, _ id: String = "msg_f") -> FormPayload? {
        if case .form(let payload)? = reducer.thread.messages.first(where: { $0.id == id })?.content { payload } else { nil }
    }

    private let answers = [FormAnswer(fieldId: "f_len", optionIds: ["o_short"], text: nil)]

    @Test("Submit shows at once; a copy from before it doesn't reopen the card; the rollback does")
    func optimisticThenRollBack() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.messageEvent(1, Self.formJSON()))
        let before = reducer.setFormState("msg_f", .submitted, answers: answers)
        #expect(before != nil)
        #expect(form(reducer)?.state == .submitted)
        #expect(form(reducer)?.answers == answers)
        // Only an open card can be submitted (a second tap does nothing).
        let r1 = reducer.setFormState("msg_f", .dismissed, answers: nil)
        #expect(r1 == nil)

        // A reload / replay of the card as it was (same updatedAt) keeps the optimistic state.
        reducer.apply(Fx.messageEvent(2, Self.formJSON()))
        #expect(form(reducer)?.state == .submitted)

        // 400: the card opens again as it was.
        let r2 = reducer.restoreForm("msg_f", before!)
        #expect(r2)
        #expect(form(reducer)?.state == .open)
        #expect(form(reducer)?.answers == nil)
    }

    @Test("a newer server copy wins over the rollback")
    func serverCopyWins() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.messageEvent(1, Self.formJSON()))
        let before = reducer.setFormState("msg_f", .submitted, answers: answers)!
        reducer.apply(Fx.messageEvent(2, Self.formJSON(state: "submitted", updated: 20)))
        let r3 = reducer.restoreForm("msg_f", before)
        #expect(!r3)
        #expect(form(reducer)?.state == .submitted)
    }

    @Test("Skip shows dismissed at once; an unknown or non-form message does nothing")
    func skip() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.messageEvent(1, Self.formJSON()))
        reducer.apply(Fx.messageEvent(2, Fx.messageJSON("m_text", at: 20)))
        let r4 = reducer.setFormState("msg_f", .dismissed, answers: nil)
        #expect(r4 != nil)
        #expect(form(reducer)?.state == .dismissed)
        let r5 = reducer.setFormState("m_text", .submitted, answers: answers)
        #expect(r5 == nil)
        let r6 = reducer.setFormState("missing", .submitted, answers: answers)
        #expect(r6 == nil)
    }

    @Test("a refused submit's pending bubble goes")
    func refusedBubbleGoes() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.enqueue(Fx.pending("c-1", "How long?: Short"))
        reducer.enqueue(Fx.pending("c-2"))
        reducer.removePending("c-1")
        #expect(reducer.thread.pending.map(\.clientId) == ["c-2"])
    }

    @Test("failures: 400 rolls back with a reason, 409 reloads, offline waits")
    func outcomes() {
        #expect(FormSubmits.outcome(for: APIError.validationFailed(field: "form", message: "bad")) == .rollBack(reason: String(localized: "Check your answers and try again.")))
        #expect(FormSubmits.outcome(for: APIError.staleVersion) == .reload)
        #expect(FormSubmits.outcome(for: APIError.server(status: 409, code: "conflict")) == .reload)
        #expect(FormSubmits.outcome(for: APIError.unreachable) == .wait)
        #expect(FormSubmits.outcome(for: CancellationError()) == .wait)
        if case .rollBack = FormSubmits.outcome(for: APIError.server(status: 500, code: "internal")) {} else {
            Issue.record("a server error rolls back")
        }
    }

    @Test("a submission rides on its pending message's request until the echo")
    func submissionBookkeeping() {
        var submits = FormSubmits()
        let snapshot = FormSnapshot(payload: FormPayload(title: "T", description: nil, icon: .chat, fields: [], submitLabel: nil, state: .open, answers: nil), updatedAt: Fx.date(10))
        submits.add(clientId: "c-1", .init(messageId: "msg_f", answers: answers, before: snapshot, thread: .channel(Fx.main)))
        #expect(submits.clientId(for: "msg_f") == "c-1")
        #expect(submits.submission("c-1") == SendMessageRequest.FormSubmission(messageId: "msg_f", answers: answers))
        #expect(submits.submission("other") == nil)
        #expect(submits.finish("c-1")?.messageId == "msg_f")
        #expect(submits.clientId(for: "msg_f") == nil)
    }

    @Test("the card's request: in flight once, then cleared or the reason")
    func cardRequest() {
        var board = TaskBoard()
        let r7 = board.beginForm("msg_f")
        #expect(r7)
        let r8 = board.beginForm("msg_f")
        #expect(!r8)
        #expect(board.cardRequests["msg_f"] == .inFlight)
        board.endForm("msg_f", failure: "Check your answers and try again.")
        #expect(board.cardRequests["msg_f"] == .failed(reason: "Check your answers and try again."))
        let r9 = board.beginForm("msg_f")
        #expect(r9)
        board.endForm("msg_f", failure: nil)
        #expect(board.cardRequests["msg_f"] == nil)
    }
}
