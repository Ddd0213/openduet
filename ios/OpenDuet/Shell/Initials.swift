// The user's monogram for the header's right circle (prompt L89): PersonNameComponentsFormatter
// with the abbreviated style, so "Chris Flores" reads "CF" and "林晓" reads "林".
// A tap opens the profile (M4); a long press replays the onboarding (L35).
import Foundation
import SwiftUI

@MainActor
enum Initials {
    // PersonNameComponentsFormatter isn't Sendable, so the shared instance lives on the main actor.
    private static let formatter: PersonNameComponentsFormatter = {
        let formatter = PersonNameComponentsFormatter()
        formatter.style = .abbreviated
        return formatter
    }()

    /// The monogram for a display name, or nil when there is no usable name.
    static func monogram(for name: String?) -> String? {
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return nil
        }
        if let components = formatter.personNameComponents(from: name) {
            let abbreviated = formatter.string(from: components)
            if !abbreviated.isEmpty { return abbreviated }
        }
        return name.first.map { String($0).localizedUppercase }
    }
}

/// The 44 pt initials circle (or a person glyph before sign-in).
struct InitialsCircle: View {
    var userName: String?
    var onTap: () -> Void = {}
    var onRestart: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPressing = false

    /// How long the press must last before the onboarding replays.
    static let holdDuration = 0.6

    var body: some View {
        ZStack {
            if let monogram = Initials.monogram(for: userName) {
                // Computed data, not UI copy: the only verbatim text in the chat screen.
                Text(verbatim: monogram)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .padding(.horizontal, 4)
                    .transition(.opacity)
            } else {
                DuetIcon(glyph: .profile, size: 22, tint: Palette.primaryText)
                    .transition(.opacity)
            }
        }
        .foregroundStyle(Palette.primaryText)
        .floatingCircle(Metrics.headerCircle)
        .scaleEffect(isPressing && !reduceMotion ? 0.92 : 1)
        .opacity(isPressing ? 0.88 : 1)
        .animation(.spring(response: 0.25, dampingFraction: 0.7), value: isPressing)
        .animation(.easeInOut(duration: 0.25), value: userName)
        // A quick tap fails the long press and lands here; a full hold replays the intro.
        .onTapGesture(perform: onTap)
        .onLongPressGesture(minimumDuration: Self.holdDuration, perform: onRestart) { pressing in
            isPressing = pressing
        }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(Text("Profile"))
        .accessibilityHint(Text("Touch and hold to replay the introduction"))
        .accessibilityAction { onTap() }
        .accessibilityAction(named: Text("Replay the introduction"), onRestart)
    }
}
