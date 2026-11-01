// What CallDetailSheet loads through `\.apiClient`: GET /api/calls/:id (the call, its transcript
// and what it handed to the assistant).
import Foundation
import Observation

@MainActor @Observable
final class CallDetailModel {
    private(set) var detail = Loadable<CallDetail>()

    func load(_ api: APIClient?, callId: String) async {
        guard let api else {
            detail.fail(String(localized: "Can't reach your server."))
            return
        }
        detail.begin()
        do {
            detail.finish(try await api.callDetail(id: callId))
        } catch {
            if let reason = SettingsReason.line(for: error) { detail.fail(reason) } else { detail.loading = false }
        }
    }
}
