// M27 browser (docs/API.md "## M27 browser"): the full-screen "OpenDuet's computer" view's own tab
// strip and address bar. GET reads the bar at any time and starts nothing; the actions work only
// after Take over and answer the new bar once the page has started loading (about 2 s, at most
// 25 s on the backend). Tab URLs and titles are never logged here (APIClient.decode logs a failed
// decode's error only as private).
import Foundation

extension APIClient {
    /// The bar actions wait for the page to start loading: more than the session's 30 s default.
    nonisolated static let browserBarTimeout: TimeInterval = 35

    /// GET /api/computer/tabs (a backend from before M27 answers 404).
    nonisolated func browserBar() async throws -> BrowserBar {
        try await get("/api/computer/tabs")
    }

    /// One action: POST /api/computer/tabs, …/tabs/:tabId/activate, …/close or /navigate.
    nonisolated func browserBar(_ action: BrowserBarAction) async throws -> BrowserBar {
        var request: URLRequest
        switch action.body {
        case .none: request = try makeRequest("POST", action.path)
        case .newTab(let body): request = try makeRequest("POST", action.path, json: body)
        case .navigate(let body): request = try makeRequest("POST", action.path, json: body)
        }
        request.timeoutInterval = Self.browserBarTimeout
        return try decode(BrowserBar.self, from: try await send(request))
    }
}
