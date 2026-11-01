// Chat messages (backend/src/contract/messages.ts). `kind` selects the bubble or card and
// `payload` carries its data; the payload types live in MessagePayloads.swift.
import Foundation

struct Reaction: Decodable, Hashable, Sendable {
    enum By: String, AssistantValue, Sendable { case user, assistant }
    var emoji: String
    var by: By
}

struct Message: Hashable, Sendable, Identifiable {
    enum Role: String, AssistantValue, Sendable { case user, assistant, system }
    /// User messages: "Delivered" (sent) / "Seen".
    enum Status: String, Decodable, Sendable { case sent, seen }

    var id: ID
    var channelId: ID
    /// Set when the message belongs to a task's own session.
    var taskId: ID?
    var role: Role
    /// Markdown for the assistant; task and artifact links use duet://tasks/<id>, duet://artifacts/<id>.
    var text: String
    var status: Status
    /// The app's local id, echoed back so an optimistic bubble can be reconciled.
    var clientId: String?
    var reactions: [Reaction]
    var createdAt: Date
    var updatedAt: Date
    var content: MessageContent
    /// M10: the user stopped this reply mid-stream; the text is what had arrived ("Stopped" line).
    var stopped: Bool = false
    /// A voice call handed this to the assistant, or it's the assistant's reply in such a turn: left out of the
    /// chat (the list route already omits it; SSE events still carry it).
    var callId: ID? = nil
}

extension Message: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, taskId, role, text, status, clientId, reactions, createdAt, updatedAt, kind, payload, stopped
        case callId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        channelId = try c.decode(ID.self, forKey: .channelId)
        taskId = try c.decodeIfPresent(ID.self, forKey: .taskId)
        role = try c.decode(Role.self, forKey: .role)
        text = try c.decode(String.self, forKey: .text)
        status = try c.decode(Status.self, forKey: .status)
        clientId = try c.decodeIfPresent(String.self, forKey: .clientId)
        reactions = try c.decode([Reaction].self, forKey: .reactions)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        let kind = try c.decode(String.self, forKey: .kind)
        content = try MessageContent(kind: kind, payload: c.superDecoder(forKey: .payload))
        stopped = try c.decodeIfPresent(Bool.self, forKey: .stopped) ?? false
        callId = try c.decodeIfPresent(ID.self, forKey: .callId)
    }
}

/// M10: POST /api/channels/:id/stop and POST /api/tasks/:id/stop (409 conflict when nothing is running).
struct StopResponse: Decodable, Sendable {
    var stopped: Int
}

/// GET /api/channels/:id/messages?before=<messageId>&limit=50 (oldest first within the page).
struct MessagePage: Decodable, Sendable {
    var messages: [Message]
    var hasMore: Bool
    /// M21: the turn running in this thread now; nil when none.
    var activeRun: ActiveRun? = nil

    private enum CodingKeys: String, CodingKey { case messages, hasMore, activeRun }

    init(messages: [Message], hasMore: Bool, activeRun: ActiveRun? = nil) {
        self.messages = messages
        self.hasMore = hasMore
        self.activeRun = activeRun
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = try c.decode([Message].self, forKey: .messages)
        hasMore = try c.decode(Bool.self, forKey: .hasMore)
        activeRun = (try? c.decodeIfPresent(ActiveRun.self, forKey: .activeRun)) ?? nil
    }
}

/// POST /api/channels/:id/messages and POST /api/tasks/:id/messages (answered over SSE).
struct SendMessageRequest: Codable, Hashable, Sendable {
    struct QuickReply: Codable, Hashable, Sendable {
        var messageId: ID
        var option: String
    }
    var text: String
    var clientId: String
    /// Ids from POST /api/channels/:id/files, uploaded before sending.
    var fileIds: [ID]?
    var skill: String?
    var quickReply: QuickReply?
    /// M8: the assistant message this one quotes (swipe right on its bubble); same thread only.
    var replyTo: ID? = nil
    /// M9: submitting a form card; `text` is the readable "label: answer" summary
    var form: FormSubmission? = nil

    struct FormSubmission: Codable, Hashable, Sendable {
        var messageId: ID
        var answers: [FormAnswer]
    }
}

/// POST /api/messages/:id/action (Start / Hide a suggestion, Save skill / Not now ...).
struct MessageActionRequest: Codable, Hashable, Sendable {
    enum Action: String, Codable, Sendable {
        case start, hide, dismiss, done
        case saveSkill = "save_skill"
        /// M11: soul_proposal Apply; memory_note Undo.
        case apply, undo
        /// M12: a model_error card's Retry (and Switch model, with modelId)
        case retry
        /// M24: tick / untick a card's checklist item (itemId = CardBlock.CheckItem.id); sets done, so a repeat is harmless
        case check, uncheck
    }
    var action: Action
    /// Item id inside task_suggestions / plate cards.
    var itemId: ID?
    /// M12: retry on this model instead ("Switch model"); ModelEntry.id. Left out when nil.
    var modelId: ID? = nil
}

struct MessageActionResponse: Decodable, Sendable {
    var message: Message
}

/// PUT / DELETE /api/messages/:id/reactions/:emoji -> the updated message
struct ReactionResponse: Decodable, Sendable {
    var message: Message
}

/// POST /api/feedback (Good / Bad response, or "Send feedback" in the profile sheet).
struct FeedbackRequest: Codable, Hashable, Sendable {
    enum Rating: String, Codable, Sendable { case good, bad }
    var messageId: ID?
    var rating: Rating?
    var text: String?
}
