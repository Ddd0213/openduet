// The connection to one OpenDuet server (docs/API.md). Every request carries the bearer
// token (when signed in) plus X-Timezone and X-Locale; JSON uses the app's JSONCoding; a non-2xx
// answer becomes APIError, and a 401 on a signed-in request calls `onUnauthorized` so the app
// returns to sign-in with the address prefilled (L184). Routes live in APIClient+*.swift.
import Foundation
import OSLog

actor APIClient {
    nonisolated let server: ServerAddress
    /// nil for the sign-in screen's calls (server-info, POST /api/session).
    nonisolated let token: String?
    nonisolated let onUnauthorized: @Sendable () -> Void

    /// File and image bytes already loaded in this session (L186).
    let memoryCache = NSCache<NSString, NSData>()
    var inFlight: [String: Task<Data, any Error>] = [:]

    static let log = Logger(subsystem: "dev.openduet.OpenDuet", category: "api")

    init(server: ServerAddress, token: String?, onUnauthorized: @escaping @Sendable () -> Void = {}) {
        self.server = server
        self.token = token
        self.onUnauthorized = onUnauthorized
        memoryCache.totalCostLimit = 64 << 20
    }

    // MARK: - Requests

    nonisolated func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], timeout: TimeInterval? = nil) throws -> URLRequest {
        guard let url = server.url(path: path, query: query) else { throw APIError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let timeout { request.timeoutInterval = timeout }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        RequestContext.apply(to: &request, token: token)
        return request
    }

    nonisolated func makeRequest(_ method: String, _ path: String, json body: some Encodable) throws -> URLRequest {
        var request = try makeRequest(method, path)
        request.httpBody = try JSONCoding.encoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    /// Sends a request and returns the body of its 2xx response.
    nonisolated func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await HTTPSessions.api.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        try check(response, body: data)
        return data
    }

    /// Throws the APIError of a non-2xx response (and reports an expired session).
    nonisolated func check(_ response: URLResponse, body: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard !(200..<300).contains(http.statusCode) else { return }
        let error = APIError(status: http.statusCode, body: body)
        if http.statusCode == 401, token != nil { onUnauthorized() }
        throw error
    }

    nonisolated func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONCoding.decoder().decode(T.self, from: data)
        } catch {
            Self.log.error("Couldn't decode \(String(describing: T.self), privacy: .public): \(String(describing: error), privacy: .private)")
            throw APIError.invalidResponse
        }
    }

    nonisolated func get<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval? = nil) async throws -> T {
        try decode(T.self, from: try await send(try makeRequest("GET", path, query: query, timeout: timeout)))
    }
}
