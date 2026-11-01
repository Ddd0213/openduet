// What RootView shows while it restores the session (L185): the app background with the
// centred, still mascot (the neutral face), crossfading to sign-in, onboarding or the shell.
// M29: the system launch screen is the same face on the same 80 x 80 pt canvas
// (Tools/LaunchMascot), so the hand-over doesn't jump.
import SwiftUI

struct LaunchView: View {
    var body: some View {
        // Centred on the whole screen, like the system launch screen's image.
        ZStack {
            Palette.background
            MascotSwoop(size: 64, animated: false)
        }
        .ignoresSafeArea()
        .accessibilityElement()
        .accessibilityLabel(Text("OpenDuet"))
    }
}

#Preview {
    LaunchView()
}
