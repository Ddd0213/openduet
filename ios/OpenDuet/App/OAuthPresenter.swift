// Shows a PendingOAuth (Composio's hosted OAuth page, L127) in ASWebAuthenticationSession once
// per request id and reports the callback URL, or nil when the user cancelled or it failed.
// Shared by the shell (OpenDuet sheet, connector detail) and onboarding page 5 (Slack).
import AuthenticationServices
import SwiftUI

struct OAuthPresenter: ViewModifier {
    let request: PendingOAuth?
    let onFinished: (UUID, URL?) -> Void

    @Environment(\.webAuthenticationSession) private var session

    func body(content: Content) -> some View {
        content.task(id: request?.id) {
            guard let request else { return }
            let callback = try? await session.authenticate(
                using: request.url,
                callbackURLScheme: request.callbackScheme
            )
            onFinished(request.id, callback)
        }
    }
}

extension View {
    /// Attach once near the root of the screen that owns `request` (MainShellView, onboarding).
    func oauthPresenter(_ request: PendingOAuth?, onFinished: @escaping (UUID, URL?) -> Void) -> some View {
        modifier(OAuthPresenter(request: request, onFinished: onFinished))
    }
}
