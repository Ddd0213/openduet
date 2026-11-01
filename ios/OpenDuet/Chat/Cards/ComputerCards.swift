// M6 (iOS 1, owned by the iOS-1 agent): the live browser card (L143, in the look of onboarding
// page 3's browser card) and the sign-in card (L141). MessageView dispatches the live_browser and
// sign_in kinds here; the views themselves live in Computer/.
import SwiftUI

struct LiveBrowserCard: View {
    var message: Message
    var payload: LiveBrowserPayload
    var actions: ShellActions
    var onSent: () -> Void

    var body: some View {
        LiveBrowserCardView(payload: payload, actions: actions.computer)
    }
}

struct SignInCard: View {
    var message: Message
    var payload: SignInPayload
    var actions: ShellActions
    var onSent: () -> Void

    var body: some View {
        SignInCardView(message: message, payload: payload, actions: actions.computer)
    }
}
