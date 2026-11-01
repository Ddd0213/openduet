// M28 Signed-in devices page's data through `\.apiClient` (docs/API.md "M28 sessions"): GET
// /api/sessions when the page appears and on pull to refresh, DELETE /api/sessions/:id for one
// device's Sign out, POST /api/sessions/revoke-others for "Sign out other devices". What a failure
// means comes from DevicesRules (404 on the list: a server before M28; 404 on a sign-out: already
// gone). A 401 anywhere signs the app out through the client's `onUnauthorized`, as everywhere.
import Foundation
import Observation

@MainActor @Observable
final class DevicesModel {
    private(set) var api: APIClient?
    private(set) var list = Loadable<SessionList>()
    /// GET /api/sessions was 404: the server is from before M28
    private(set) var olderServer = false
    /// the rows whose Sign out is in flight, and each failed one's reason
    private(set) var signingOut: Set<String> = []
    private(set) var rowFailures: [String: String] = [:]
    /// "Sign out other devices": in flight, its refusal, and the "Signed out N devices" line
    private(set) var revoking = false
    private(set) var revokeFailure: String?
    private(set) var revokedLine: String?

    init() {}

    func attach(_ api: APIClient?) {
        guard self.api == nil, let api else { return }
        self.api = api
    }

    var screen: DevicesRules.Screen {
        DevicesRules.screen(list: list.value, failure: list.failure, loading: list.loading, olderServer: olderServer)
    }

    /// GET /api/sessions; the rows on screen stay up while it runs.
    func load() async {
        guard let api else {
            if list.value == nil { list.fail(String(localized: "Can't reach your server.")) }
            return
        }
        list.begin()
        do {
            let value = try await api.sessions()
            olderServer = false
            list.finish(value)
        } catch {
            switch DevicesRules.loadFailure(error) {
            case .ignore: list.loading = false
            case .olderServer:
                olderServer = true
                list = Loadable()
            case .reason(let reason): list.fail(reason)
            }
        }
    }

    /// Pull to refresh: the last result line goes, then the list loads again.
    func refresh() async {
        revokedLine = nil
        revokeFailure = nil
        await load()
    }

    /// One other device's Sign out (DELETE /api/sessions/:id): on 204 or 404 its row leaves; a 400 on
    /// `id` loads the list again; any other failure keeps the row with the reason.
    @discardableResult
    func signOut(_ id: String) async -> DevicesRules.DeleteOutcome {
        guard let api, !signingOut.contains(id) else { return .ignore }
        signingOut.insert(id)
        rowFailures[id] = nil
        revokedLine = nil
        var failure: (any Error)?
        do {
            try await api.deleteSession(id: id)
        } catch {
            failure = error
        }
        signingOut.remove(id)
        let outcome = DevicesRules.deleteOutcome(failure)
        switch outcome {
        case .gone: drop { $0.id == id }
        case .reload: await load()
        case .ignore: break
        case .failed(let reason): rowFailures[id] = reason
        }
        return outcome
    }

    /// "Sign out other devices" (POST /api/sessions/revoke-others): on success the other rows go at
    /// once, "Signed out N devices" shows and the list loads again; a failure keeps the list and
    /// shows the reason. True on success.
    @discardableResult
    func signOutOthers() async -> Bool {
        guard let api, !revoking else { return false }
        revoking = true
        revokeFailure = nil
        revokedLine = nil
        defer { revoking = false }
        do {
            let response = try await api.revokeOtherSessions()
            drop { !$0.current }
            rowFailures = [:]
            revokedLine = DevicesRules.revokedLine(response.revoked)
        } catch {
            revokeFailure = DevicesRules.revokeFailure(error)
            return false
        }
        await load()
        return true
    }

    /// Cancel on a row's question: its old reason goes with it.
    func clearRowFailure(_ id: String) {
        rowFailures[id] = nil
    }

    /// Cancel on "Sign out other devices".
    func clearRevokeFailure() {
        revokeFailure = nil
    }

    /// Takes rows off the list on screen (the server already let them go).
    private func drop(where gone: (SessionInfo) -> Bool) {
        guard var value = list.value else { return }
        value.sessions.removeAll(where: gone)
        list.value = value
    }
}
