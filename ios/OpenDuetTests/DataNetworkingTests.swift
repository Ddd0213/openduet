// Reconnect backoff (L184) and the ApiError code mapping (docs/API.md "Errors").
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Backoff and API errors")
struct DataNetworkingTests {
    @Test("Backoff doubles from 1 s up to 30 s and restarts after a reset")
    func backoff() {
        var backoff = Backoff()
        #expect((0..<8).map { _ in backoff.nextDelay() } == [1, 2, 4, 8, 16, 30, 30, 30])
        backoff.reset()
        #expect(backoff.nextDelay() == 1)
        for _ in 0..<500 { _ = backoff.nextDelay() }
        #expect(backoff.nextDelay() == 30)
    }

    private func body(_ code: String, field: String? = nil) -> Data {
        var error: [String: Any] = ["code": code, "message": "m"]
        if let field { error["field"] = field }
        return try! JSONSerialization.data(withJSONObject: ["error": error])
    }

    @Test("Server codes map to their cases")
    func codes() {
        #expect(APIError(status: 401, body: body("invalid_credentials")) == .invalidCredentials)
        #expect(APIError(status: 401, body: body("unauthorized")) == .unauthorized)
        #expect(APIError(status: 429, body: body("rate_limited")) == .rateLimited)
        #expect(APIError(status: 429, body: body("usage_limited")) == .usageLimited)
        #expect(APIError(status: 413, body: body("too_large")) == .tooLarge)
        #expect(APIError(status: 415, body: body("unsupported_type")) == .unsupportedType)
        #expect(APIError(status: 400, body: body("validation_failed", field: "text")) == .validationFailed(field: "text", message: "m"))
        #expect(APIError(status: 500, body: body("brand_new")) == .server(status: 500, code: "brand_new"))
    }

    @Test("Without an ApiError body the status decides; gateways count as unreachable")
    func statuses() {
        #expect(APIError(status: 401, body: Data()) == .unauthorized)
        #expect(APIError(status: 502, body: Data("<html>".utf8)) == .unreachable)
        #expect(APIError(status: 504, body: Data()) == .unreachable)
        #expect(APIError(status: 500, body: Data()) == .server(status: 500, code: "internal"))
    }

    @Test("Transport errors: offline is unreachable, cancellation stays cancellation")
    func transport() {
        #expect(APIError.transport(URLError(.notConnectedToInternet)) as? APIError == .unreachable)
        #expect(APIError.transport(URLError(.timedOut)) as? APIError == .unreachable)
        #expect(APIError.transport(URLError(.cancelled)) is CancellationError)
        #expect(APIError.transport(APIError.usageLimited) as? APIError == .usageLimited)
    }
}
