// Server-sent event streams (docs/API.md "SSE"): GET /api/events and the answers of
// POST /api/channels/:id/messages and POST /api/tasks/:id/messages, read with
// URLSession.bytes(for:) through SSEParser.
import Foundation

extension APIClient {
    enum StreamItem: Sendable {
        /// The server answered 2xx; events follow.
        case opened
        /// A line arrived (a comment such as ": ping", or part of an event): the link is alive.
        case activity
        case event(DuetEvent)
    }

    /// GET /api/events, resuming after `lastEventId` (L184).
    nonisolated func events(after lastEventId: Int64?) -> AsyncThrowingStream<StreamItem, any Error> {
        do {
            var request = try makeRequest("GET", "/api/events")
            if let lastEventId { request.setValue(String(lastEventId), forHTTPHeaderField: "Last-Event-ID") }
            return stream(request)
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
    }

    /// POST /api/channels/:id/messages: the user's echoed message, then the run's events until `done`.
    nonisolated func sendMessage(channelId: String, _ body: SendMessageRequest) -> AsyncThrowingStream<StreamItem, any Error> {
        do {
            return stream(try makeRequest("POST", "/api/channels/\(channelId.pathSegment)/messages", json: body))
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
    }

    /// POST /api/tasks/:id/messages ("Reply to OpenDuet" in task detail): same answer as a channel
    /// send, into the task's own session.
    nonisolated func sendTaskMessage(taskId: String, _ body: SendMessageRequest) -> AsyncThrowingStream<StreamItem, any Error> {
        do {
            return stream(try makeRequest("POST", "/api/tasks/\(taskId.pathSegment)/messages", json: body))
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
    }

    private nonisolated func stream(_ base: URLRequest) -> AsyncThrowingStream<StreamItem, any Error> {
        var request = base
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // Idle timeout only; the heartbeat watchdog (EventStream) reacts earlier.
        request.timeoutInterval = StreamTiming.heartbeatTimeout + 15
        return AsyncThrowingStream { continuation in
            let task = Task.detached { [self, request] in
                do {
                    try await self.pump(request, into: continuation)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: APIError.transport(error))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private nonisolated func pump(_ request: URLRequest, into continuation: AsyncThrowingStream<StreamItem, any Error>.Continuation) async throws {
        let (bytes, response) = try await HTTPSessions.api.bytes(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count > 64 << 10 { break }
            }
            try check(response, body: body)
        }
        continuation.yield(.opened)

        var parser = SSEParser()
        let decoder = JSONCoding.decoder()
        for try await byte in bytes {
            let output = parser.push(byte)
            if case .event(let sse)? = output {
                do {
                    continuation.yield(.event(try decoder.decode(DuetEvent.self, from: Data(sse.data.utf8))))
                } catch {
                    // One bad event never ends the stream; the content stays out of the log.
                    Self.log.error("Skipped an undecodable \(sse.event, privacy: .public) event \(sse.id ?? "-", privacy: .public)")
                }
            } else if byte == 0x0A || byte == 0x0D {
                continuation.yield(.activity)
            }
        }
        parser.finish()
    }
}
