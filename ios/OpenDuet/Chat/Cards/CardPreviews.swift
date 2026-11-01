// Previews of M3's chat cards in the real thread (prompt L3): every card and approval state,
// taps in flight / failed, dark + Chinese, and an edit by chat that scrolls to the email card
// and glows its changed text. DEBUG only.
#if DEBUG
import SwiftUI

/// Bumps the email card's version after a moment, the way an edit by chat arrives (L163).
private struct EditByChatPreview: View {
    @State private var state = CardFixtures.thread

    var body: some View {
        MainShellView(state: state, actions: ShellActions())
            .task {
                try? await Task.sleep(for: .seconds(2))
                guard let index = state.thread.messages.firstIndex(where: { $0.id == "a1" }) else { return }
                let body = CardFixtures.emailBody.replacingOccurrences(
                    of: "Best,", with: "I'm really excited to see it in print!\n\nBest,"
                )
                state.thread.messages[index].content = .approval(CardFixtures.approval(
                    "ap1", .email, CardFixtures.email(body: body), version: 2, message: "a1"
                ))
                state.thread.edits["a1"] = CardEdit(version: 2, fields: ["body"])
            }
    }
}

#Preview("Cards – every state") {
    MainShellView(state: CardFixtures.thread, actions: ShellActions())
}

#Preview("Cards – in flight / failed taps") {
    MainShellView(state: CardFixtures.busy, actions: ShellActions())
}

#Preview("Cards – dark, Chinese") {
    MainShellView(state: CardFixtures.thread, actions: ShellActions())
        .preferredColorScheme(.dark)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}

#Preview("Cards – edit by chat glows") {
    EditByChatPreview()
}

#Preview("Cards – M9 form, info card, suggestion icons") {
    MainShellView(state: CardFixtures.m9, actions: ShellActions())
}

#Preview("Cards – M9 sending / failed, dark, Chinese") {
    MainShellView(state: CardFixtures.m9Busy, actions: ShellActions())
        .preferredColorScheme(.dark)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}

#Preview("Cards – M20 browser approvals, Always rows, sign-in steps") {
    MainShellView(state: CardFixtures.m20, actions: ShellActions())
}

#Preview("Cards – M20 in flight / failed, dark, Chinese") {
    MainShellView(state: CardFixtures.m20Busy, actions: ShellActions())
        .preferredColorScheme(.dark)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}
#endif
