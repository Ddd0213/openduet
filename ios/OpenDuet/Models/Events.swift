// SSE events (backend/src/contract/events.ts). Both streams send the same stored events:
// `id:` is DuetEvent.id (increasing, used for Last-Event-ID and dedup), `event:` the type,
// `data:` this JSON envelope.
import Foundation

// Inside this type `ID` means Identifiable's DuetEvent.ID (Int64), not the String typealias,
// so string ids are spelled `String` here.
struct DuetEvent: Decodable, Hashable, Sendable, Identifiable {
    var id: Int64
    var channelId: String?
    var createdAt: Date
    var body: Body

    /// Run-scoped events (status, typing, done) carry the run and, inside a task, its id.
    struct RunRef: Decodable, Hashable, Sendable {
        var runId: String
        var taskId: String?
        /// M21: which kind of run; nil on events stored before M21 (or a kind this app doesn't know).
        var kind: RunKind? = nil

        private enum CodingKeys: String, CodingKey { case runId, taskId, kind }

        init(runId: String, taskId: String?, kind: RunKind? = nil) {
            self.runId = runId
            self.taskId = taskId
            self.kind = kind
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            runId = try c.decode(String.self, forKey: .runId)
            taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
            kind = (try? c.decodeIfPresent(RunKind.self, forKey: .kind)) ?? nil
        }
    }

    struct ArtifactUpdate: Decodable, Hashable, Sendable {
        var artifact: ArtifactSummary
        /// Build view status line: a key while starting, then the model's step text.
        var buildStatus: Phrase?
        /// M21: the assistant editing this page (working, or failed with a reason); nil when not editing.
        var editStatus: ArtifactWorkStatus? = nil
        /// M21: a refresh of this page; nil when not refreshing.
        var refreshStatus: ArtifactWorkStatus? = nil
    }

    /// M21 `resync`: the stream skipped more than it replays; reload what is shown.
    enum ResyncReason: String, Decodable, Sendable { case replayLimit = "replay_limit", pruned }

    /// Shown as a local notification when the app is inactive or the channel isn't on screen.
    struct Notification: Decodable, Hashable, Sendable {
        var title: Phrase
        var body: Phrase
        /// duet://channels/<id>, duet://tasks/<id>, duet://artifacts/<id>; M21: channel and task
        /// routes may end in ?message=<messageId> (the line to scroll to)
        var route: String
        /// M21: one id per thing (task-<id>, approval-<id>, message-<id>), the same as the remote
        /// push's: a newer notification for it replaces the older one, a decided approval's goes.
        /// nil on events stored before M21.
        var collapseId: String? = nil
        /// M29: inside the user's quiet hours: Notification Center only, no sound, the screen
        /// stays dark. false when missing (older servers) or not a Bool.
        var passive = false

        private enum CodingKeys: String, CodingKey { case title, body, route, collapseId, passive }

        init(title: Phrase, body: Phrase, route: String, collapseId: String? = nil, passive: Bool = false) {
            self.title = title
            self.body = body
            self.route = route
            self.collapseId = collapseId
            self.passive = passive
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            title = try c.decode(Phrase.self, forKey: .title)
            body = try c.decode(Phrase.self, forKey: .body)
            route = try c.decode(String.self, forKey: .route)
            collapseId = ((try? c.decodeIfPresent(String.self, forKey: .collapseId)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
            passive = (try? c.decodeIfPresent(Bool.self, forKey: .passive)) ?? false
        }
    }

    enum Outcome: String, Decodable, Sendable { case completed, failed, cancelled }

    enum Body: Hashable, Sendable {
        /// nil = idle.
        case status(RunRef, StatusKey?)
        case typing(RunRef, Bool)
        /// Upsert by id; the user's own message echoes its clientId.
        case message(Message)
        case messageDeleted(messageId: String)
        case task(TaskSummary)
        case approval(Approval)
        case channel(Channel)
        case artifact(ArtifactUpdate)
        case usage(UsageState)
        case computer(ComputerState)
        case notification(Notification)
        /// End of a run; on failure the chat also gets a grey system line.
        case done(RunRef, Outcome, error: Phrase?)
        /// M9: DELETE /api/tasks/:id
        case taskDeleted(taskId: String)
        /// M9: DELETE /api/channels/:id
        case channelDeleted(channelId: String)
        /// What the voice of an open call should say (reply / notice / progress).
        case call(CallCue)
        /// M21: reload channels, the open thread, tasks and approvals; `id` is the new Last-Event-ID.
        case resync(ResyncReason?)
        case unsupported(type: String)
    }

    private enum CodingKeys: String, CodingKey { case id, type, channelId, createdAt, payload }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int64.self, forKey: .id)
        channelId = try c.decodeIfPresent(String.self, forKey: .channelId)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        let type = try c.decode(String.self, forKey: .type)
        let p = try c.superDecoder(forKey: .payload)
        switch type {
        case "status": body = .status(try RunRef(from: p), try p.field(StatusKey?.self, "status"))
        case "typing": body = .typing(try RunRef(from: p), try p.field(Bool.self, "typing"))
        case "message": body = .message(try p.field(Message.self, "message"))
        case "message_deleted": body = .messageDeleted(messageId: try p.field(String.self, "messageId"))
        case "task": body = .task(try p.field(TaskSummary.self, "task"))
        case "approval": body = .approval(try p.field(Approval.self, "approval"))
        case "channel": body = .channel(try p.field(Channel.self, "channel"))
        case "artifact": body = .artifact(try ArtifactUpdate(from: p))
        case "usage": body = .usage(try p.field(UsageState.self, "usage"))
        case "computer": body = .computer(try p.field(ComputerState.self, "computer"))
        case "notification": body = .notification(try Notification(from: p))
        case "done":
            body = .done(
                try RunRef(from: p),
                try p.field(Outcome.self, "status"),
                error: try p.field(Phrase?.self, "error")
            )
        case "task_deleted": body = .taskDeleted(taskId: try p.field(String.self, "taskId"))
        case "channel_deleted": body = .channelDeleted(channelId: try p.field(String.self, "channelId"))
        case "call": body = .call(try CallCue(from: p))
        case "resync": body = .resync((try? p.field(ResyncReason.self, "reason")) ?? nil)
        default: body = .unsupported(type: type)
        }
    }
}
