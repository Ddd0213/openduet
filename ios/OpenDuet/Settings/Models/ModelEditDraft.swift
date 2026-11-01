// M12 model detail editor, without SwiftUI for the host tests: label, context window, max output,
// the thinking levels (chips in ladder order), the format, the default level and the capability
// switches; the PATCH carries only what changed (the server adds those names to `edited`).
import Foundation

struct ModelEditDraft: Hashable, Sendable {
    enum Problem: Hashable, Sendable { case label, contextWindow, maxOutput }

    static let labelLimit = 80
    /// the largest number the fields take (a typo shouldn't overflow)
    static let tokenLimit = 100_000_000

    var label: String
    /// typed digits
    var contextWindow: String
    var maxOutputTokens: String
    private(set) var thinkingLevels: Set<ThinkingLevel>
    private(set) var thinkingFormat: ThinkingFormat
    /// nil = automatic (the highest supported)
    private(set) var defaultThinking: ThinkingLevel?
    var tools: Bool
    var vision: Bool
    var serverWebTools: Bool
    var promptCaching: Bool

    let original: ModelEntry

    init(_ model: ModelEntry) {
        original = model
        label = model.label
        contextWindow = String(model.contextWindow)
        maxOutputTokens = String(model.maxOutputTokens)
        thinkingLevels = Set(model.thinkingLevels)
        thinkingFormat = model.thinkingFormat
        defaultThinking = model.defaultThinking
        tools = model.tools
        vision = model.vision
        serverWebTools = model.serverWebTools
        promptCaching = model.promptCaching
    }

    /// The levels picked, in ladder order.
    var levels: [ThinkingLevel] { ThinkingLevel.ladder(thinkingLevels) }

    func isOn(_ level: ThinkingLevel) -> Bool { thinkingLevels.contains(level) }

    /// A chip: on / off. The last level going off makes the format None; the first coming on
    /// while it's None makes it Effort. A default that's no longer offered goes back to automatic.
    mutating func toggle(_ level: ThinkingLevel) {
        if thinkingLevels.contains(level) { thinkingLevels.remove(level) } else { thinkingLevels.insert(level) }
        if thinkingLevels.isEmpty {
            thinkingFormat = .noThinking
        } else if thinkingFormat == .noThinking {
            thinkingFormat = .effort
        }
        if let level = defaultThinking, !thinkingLevels.contains(level) { defaultThinking = nil }
    }

    /// None clears the levels; Effort / Budget on a model with none starts it at off + medium.
    mutating func setFormat(_ format: ThinkingFormat) {
        thinkingFormat = format
        if format == .noThinking {
            thinkingLevels = []
            defaultThinking = nil
        } else if thinkingLevels.isEmpty {
            thinkingLevels = [.off, .medium]
        }
    }

    /// The default level: one of the picked levels, or nil (automatic).
    mutating func setDefault(_ level: ThinkingLevel?) {
        guard level.map({ thinkingLevels.contains($0) }) ?? true else { return }
        defaultThinking = level
    }

    static func number(_ text: String) -> Int? {
        let digits = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: "")
        guard let value = Int(digits), value > 0, value <= tokenLimit else { return nil }
        return value
    }

    var problems: Set<Problem> {
        var problems = Set<Problem>()
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if label.isEmpty || label.count > Self.labelLimit { problems.insert(.label) }
        if Self.number(contextWindow) == nil { problems.insert(.contextWindow) }
        if Self.number(maxOutputTokens) == nil { problems.insert(.maxOutput) }
        return problems
    }

    /// The field names this draft changes (as the server writes them into `edited`).
    var changedFields: Set<String> {
        guard let body = request else { return [] }
        var fields = Set<String>()
        if body.label != nil { fields.insert("label") }
        if body.contextWindow != nil { fields.insert("contextWindow") }
        if body.maxOutputTokens != nil { fields.insert("maxOutputTokens") }
        if body.thinkingLevels != nil { fields.insert("thinkingLevels") }
        if body.thinkingFormat != nil { fields.insert("thinkingFormat") }
        if body.defaultThinking != nil { fields.insert("defaultThinking") }
        if body.tools != nil { fields.insert("tools") }
        if body.vision != nil { fields.insert("vision") }
        if body.serverWebTools != nil { fields.insert("serverWebTools") }
        if body.promptCaching != nil { fields.insert("promptCaching") }
        return fields
    }

    /// PATCH /api/models/:id with only the changed fields; nil when nothing changed or a field is wrong.
    var request: UpdateModelEntryRequest? {
        guard problems.isEmpty else { return nil }
        var body = UpdateModelEntryRequest()
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if label != original.label { body.label = label }
        if let value = Self.number(contextWindow), value != original.contextWindow { body.contextWindow = value }
        if let value = Self.number(maxOutputTokens), value != original.maxOutputTokens { body.maxOutputTokens = value }
        if levels != ThinkingLevel.ladder(original.thinkingLevels) { body.thinkingLevels = levels }
        if thinkingFormat != original.thinkingFormat { body.thinkingFormat = thinkingFormat }
        if defaultThinking != original.defaultThinking { body.defaultThinking = Patch(defaultThinking) }
        if tools != original.tools { body.tools = tools }
        if vision != original.vision { body.vision = vision }
        if serverWebTools != original.serverWebTools { body.serverWebTools = serverWebTools }
        if promptCaching != original.promptCaching { body.promptCaching = promptCaching }
        return body == UpdateModelEntryRequest() ? nil : body
    }

    /// The field was changed by hand before (the server's `edited`): an "Edited" marker.
    func wasEdited(_ field: String) -> Bool { original.edited.contains(field) }
}
