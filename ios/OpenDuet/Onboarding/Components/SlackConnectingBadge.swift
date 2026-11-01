// Page 5's Slack row while its real Composio connection is starting or its OAuth page is up
// (prompt L77): a small spinner sits on the row's "+" in the same pill circle, and the "+" can't
// be tapped twice. It lays over SlackConnectRow's trailing button, so the row itself (PART A's
// copy, colours and the springy swap to the green check) stays exactly as it is.
import SwiftUI

struct SlackConnectingBadge: View {
    var body: some View {
        ProgressView()
            .controlSize(.small)
            .tint(OnboardingTheme.ink)
            .frame(width: 30, height: 30)
            .background(Circle().fill(OnboardingTheme.pillFill))
            // The row's 44 pt trailing button, so taps land here instead of on the "+".
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .accessibilityHidden(true)
    }
}
