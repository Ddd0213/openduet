// M22 routes (docs/API.md "M22"): Everything → Setup (GET /api/setup, POST /api/setup/check:
// 429 rate_limited within 30 s of the last check) and Who OpenDuet is → "Set up in chat"
// (POST /api/soul/intro -> 202, the setup starts or queues in the main thread).
import Foundation

extension APIClient {
    nonisolated func setup() async throws -> SetupInfo { try await get("/api/setup") }

    /// Tries each set-up row, then answers the same shape as GET.
    nonisolated func checkSetup() async throws -> SetupInfo {
        try decode(SetupInfo.self, from: try await send(try makeRequest("POST", "/api/setup/check")))
    }

    nonisolated func startSoulIntro() async throws -> SoulIntroResponse {
        try decode(SoulIntroResponse.self, from: try await send(try makeRequest("POST", "/api/soul/intro")))
    }
}
