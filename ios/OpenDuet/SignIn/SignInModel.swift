// The sign-in form (prompt L131): the address is checked against /api/server-info about 0.6 s
// after typing stops (small grey line if it can't be reached or a public host uses http);
// "Sign in" posts the username and password and maps the server's codes to one inline line.
import Foundation
import Observation

@MainActor
@Observable
final class SignInModel {
    var server: String
    var username = ""
    var password = ""
    /// Under the address field: unreachable, http to a public host, malformed.
    private(set) var serverHint: String?
    /// Under the form: wrong password, too many attempts ...
    private(set) var error: String?
    private(set) var signingIn = false
    /// Bumped on every failed attempt (warning haptic).
    private(set) var failures = 0

    init(server: ServerAddress?) {
        self.server = server?.string ?? ""
    }

    var address: ServerAddress? { try? ServerAddress.parse(server).get() }

    /// The button is disabled only while the input can't be valid.
    var canSubmit: Bool {
        address != nil && !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    /// Debounced address check; the view restarts it on every edit (task(id:)).
    func checkServer() async {
        guard !server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            serverHint = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(600))
        guard !Task.isCancelled else { return }
        let address: ServerAddress
        switch ServerAddress.parse(server) {
        case .success(let parsed): address = parsed
        case .failure(.insecurePublicHost): return serverHint = String(localized: "Use https:// for a server outside your network.")
        case .failure: return serverHint = String(localized: "Enter an address like https://duet.example.com")
        }
        do {
            _ = try await APIClient(server: address, token: nil).serverInfo()
            if !Task.isCancelled { serverHint = nil }
        } catch {
            if !Task.isCancelled && !(error is CancellationError) {
                serverHint = String(localized: "Can't reach this server.")
            }
        }
    }

    func submit(with session: SessionStore) async {
        guard canSubmit, !signingIn, let address else { return }
        signingIn = true
        error = nil
        defer { signingIn = false }
        do {
            try await session.signIn(server: address, username: username.trimmingCharacters(in: .whitespaces), password: password)
            password = ""
        } catch is CancellationError {
            return
        } catch {
            failures += 1
            self.error = switch error as? APIError {
            case .invalidCredentials, .unauthorized: String(localized: "Wrong username or password.")
            case .rateLimited: String(localized: "Too many attempts. Try again in a moment.")
            case .unreachable: String(localized: "Can't reach this server.")
            default: String(localized: "Couldn't sign in. Try again.")
            }
        }
    }
}
