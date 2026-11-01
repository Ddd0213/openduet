// The assistant's computer routes (docs/API.md "/api/computer*"): its state, Take over / Hand back
// and the sign-in card. The live screen runs over ComputerStream. The phone uses its own
// session for all of it and never sees the computer's token.
import Foundation

extension APIClient {
    /// GET /api/computer
    nonisolated func computer() async throws -> ComputerState {
        try await get("/api/computer")
    }

    /// POST /api/computer/take ("Take over": pauses the assistant).
    nonisolated func takeComputer() async throws -> ComputerState {
        let data = try await send(try makeRequest("POST", "/api/computer/take"))
        return try decode(ComputerControlResponse.self, from: data).computer
    }

    /// POST /api/computer/release ("Hand back to OpenDuet": the assistant takes a fresh snapshot).
    nonisolated func releaseComputer() async throws -> ComputerState {
        let data = try await send(try makeRequest("POST", "/api/computer/release"))
        return try decode(ComputerControlResponse.self, from: data).computer
    }

    /// POST /api/computer/sign-in/:requestId. The password lives only in this request body:
    /// nothing here stores or logs it, and the caller drops it as soon as this returns.
    nonisolated func sendSignIn(requestId: String, email: String, password: String) async throws -> SignInCardResponse {
        let request = try makeRequest(
            "POST", "/api/computer/sign-in/\(requestId.pathSegment)",
            json: SignInCardRequest(email: email, password: password)
        )
        return try decode(SignInCardResponse.self, from: try await send(request))
    }

    /// M20: POST /api/computer/sign-in/:requestId/code, the verification code the site asked for
    /// after the password. Like the password, it lives only in this request body.
    nonisolated func sendSignInCode(requestId: String, code: String) async throws -> SignInCardResponse {
        let request = try makeRequest(
            "POST", "/api/computer/sign-in/\(requestId.pathSegment)/code",
            json: SignInCodeRequest(code: code)
        )
        return try decode(SignInCardResponse.self, from: try await send(request))
    }

    /// M20: POST /api/computer/sign-in/:requestId/take-over ("Take control instead"): the card
    /// closes and the answer carries the computer, now in the user's hands.
    nonisolated func takeOverSignIn(requestId: String) async throws -> SignInCardResponse {
        let data = try await send(try makeRequest("POST", "/api/computer/sign-in/\(requestId.pathSegment)/take-over"))
        return try decode(SignInCardResponse.self, from: data)
    }

    /// M20: POST /api/computer/sign-in/:requestId/dismiss ("Not now").
    nonisolated func dismissSignIn(requestId: String) async throws -> SignInCardResponse {
        let data = try await send(try makeRequest("POST", "/api/computer/sign-in/\(requestId.pathSegment)/dismiss"))
        return try decode(SignInCardResponse.self, from: data)
    }

    /// M20: POST /api/computer/sleep: close the browser now instead of after the idle time
    /// (409 computer_busy while the assistant is using it or the user is in control).
    nonisolated func sleepComputer() async throws -> ComputerState {
        let data = try await send(try makeRequest("POST", "/api/computer/sleep"))
        return try decode(ComputerControlResponse.self, from: data).computer
    }

    /// The WebSocket request for /api/computer/stream: ws(s) on the server's address, with the
    /// same bearer token, X-Timezone and X-Locale as every other request.
    nonisolated func computerStreamRequest() -> URLRequest? {
        guard let http = server.url(path: ComputerSocket.path), let url = ComputerSocket.url(from: http) else { return nil }
        var request = URLRequest(url: url)
        RequestContext.apply(to: &request, token: token)
        return request
    }
}
