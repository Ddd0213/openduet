// Decodes every sample in docs/api-samples/ into the app's models and re-encodes the request
// shapes (comparing the JSON), so the app stays in step with backend/src/contract/.
// No test-framework dependency: ContractSamplesTests runs it, and so can a plain swiftc build
// of the models on the Mac.
import Foundation
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

enum ContractSamples {
    struct Report {
        var errors: [String] = []
        var checkedSamples = 0
        var shapesSeen: Set<String> = []
        var messageKinds: Set<String> = []
        var eventTypes: Set<String> = []
    }

    /// MESSAGE_KINDS and EVENT_TYPES of backend/src/contract/; every one needs a sample.
    static let messageKinds: Set<String> = [
        "text", "file", "image", "task_spawn", "task_suggestions", "proactive_suggestion", "quick_replies",
        "approval", "spend_request", "confirmation", "alert", "plate", "system", "usage_limit", "artifact",
        "live_browser", "sign_in", "skill_proposal",
        // M9
        "form", "card",
        // M11
        "memory_note", "soul_proposal", "connection_request",
        // M12
        "model_error",
        // M13
        "call",
    ]
    static let eventTypes: Set<String> = [
        "status", "typing", "message", "message_deleted", "task", "approval", "channel", "artifact",
        "usage", "computer", "notification", "done",
        // M13
        "call",
    ]

    typealias Check = (Data, inout Report) throws -> Void

    private struct Mismatch: Error, CustomStringConvertible {
        let description: String
    }

    /// Checks every *.json file in `directory` (docs/api-samples/ or its bundled copy).
    static func check(directory: URL) throws -> Report {
        var report = Report()
        let checks = registry()
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        if files.isEmpty { report.errors.append("no sample files in \(directory.path)") }

        for file in files {
            let name = file.lastPathComponent
            guard let shapes = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] else {
                report.errors.append("\(name): the top level is not an object")
                continue
            }
            for (shape, value) in shapes.sorted(by: { $0.key < $1.key }) {
                guard let check = checks[shape] else {
                    report.errors.append("\(name): \(shape) has no Swift model in ContractSamples.registry")
                    continue
                }
                report.shapesSeen.insert(shape)
                let samples = (value as? [Any]) ?? [value]
                for (index, sample) in samples.enumerated() {
                    report.checkedSamples += 1
                    do {
                        try check(JSONSerialization.data(withJSONObject: sample), &report)
                    } catch {
                        report.errors.append("\(name) \(shape)[\(index)]: \(error)")
                    }
                }
            }
        }

        for shape in Set(checks.keys).subtracting(report.shapesSeen).sorted() {
            report.errors.append("\(shape) has no sample in docs/api-samples")
        }
        for kind in messageKinds.subtracting(report.messageKinds).sorted() {
            report.errors.append("no sample message of kind \(kind)")
        }
        for type in eventTypes.subtracting(report.eventTypes).sorted() {
            report.errors.append("no sample event of type \(type)")
        }
        return report
    }

    // MARK: - Checks

    /// A response shape: it must decode.
    static func response<T: Decodable>(_ type: T.Type, visit: ((T, inout Report) -> Void)? = nil) -> Check {
        { data, report in
            let value = try JSONCoding.decoder().decode(T.self, from: data)
            visit?(value, &report)
        }
    }

    /// A request shape: it must decode, and encoding it again must give the same JSON.
    static func request<T: Codable>(_ type: T.Type) -> Check {
        { data, _ in
            let value = try JSONCoding.decoder().decode(T.self, from: data)
            let encoded = try JSONCoding.encoder().encode(value)
            let original = try JSONSerialization.jsonObject(with: data) as AnyObject
            let again = try JSONSerialization.jsonObject(with: encoded) as AnyObject
            guard original.isEqual(again) else {
                throw Mismatch(description: "re-encoded as \(String(decoding: encoded, as: UTF8.self))")
            }
        }
    }

    static func record(_ messages: [Message], _ report: inout Report) {
        for message in messages {
            let kind = message.content.sampleKind
            report.messageKinds.insert(kind)
            if case .unsupported = message.content {
                report.errors.append("message \(message.id): kind \(kind) decoded as unsupported")
            }
        }
    }

    static func record(_ event: DuetEvent, _ report: inout Report) {
        let type = event.body.sampleType
        report.eventTypes.insert(type)
        switch event.body {
        case let .message(message): record([message], &report)
        case .unsupported: report.errors.append("event \(event.id): type \(type) decoded as unsupported")
        default: break
        }
    }
}
