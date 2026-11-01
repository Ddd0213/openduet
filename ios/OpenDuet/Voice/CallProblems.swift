// M15: what went wrong with the voice service during a call that kept going (a provider error
// event that wasn't fatal, e.g. StepFun answering an error mid-reply). Kept on this phone only,
// by call id (decided by the user: no server field): the chat's call line shows it in grey.
// The newest 50 calls; Foundation only (host-tested).
import Foundation
import Observation

@MainActor @Observable
final class CallProblems {
    static let shared = CallProblems()

    /// Longest message kept (a provider's error can be a whole JSON body).
    static let maxLength = 160
    /// Calls remembered.
    static let capacity = 50

    private struct Entry: Codable, Equatable {
        var callId: String
        var message: String
    }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let key: String
    private var entries: [Entry]

    init(defaults: UserDefaults = .standard, key: String = "duet.callProblems") {
        self.defaults = defaults
        self.key = key
        let data = defaults.data(forKey: key)
        entries = data.flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
    }

    /// The provider's last error in that call, if it had one.
    func message(for callId: String) -> String? {
        entries.last { $0.callId == callId }?.message
    }

    /// The call ended with a provider error that didn't end it: remembered (one per call).
    func record(callId: String, message: String) {
        let text = Self.shorten(message)
        guard !callId.isEmpty, !text.isEmpty else { return }
        entries.removeAll { $0.callId == callId }
        entries.append(Entry(callId: callId, message: text))
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
        save()
    }

    /// Sign-out: nothing of the last account stays.
    func removeAll() {
        entries = []
        defaults.removeObject(forKey: key)
    }

    /// One line, at most `maxLength` characters (an ellipsis when cut).
    static func shorten(_ message: String) -> String {
        let line = message.split(whereSeparator: \.isNewline).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard line.count > maxLength else { return line }
        return String(line.prefix(maxLength - 1)) + "…"
    }

    private func save() {
        if let data = try? JSONEncoder().encode(entries) { defaults.set(data, forKey: key) }
    }
}
