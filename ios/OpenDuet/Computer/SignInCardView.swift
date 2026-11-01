// The sign-in card (prompt L141): the site's letter badge (no favicon is fetched from the public
// internet) and domain, "Sign in to <site>", email and password fields and "Send to OpenDuet's
// browser". M20: two quiet ways out under the main button, "Take control instead" (the user signs
// in on the full-screen computer) and "Not now"; when the site then asks for a one-time code the
// same card goes on with "Enter the code <site> sent you", one field and "Send code". While a tap
// runs: a spinner in the tapped button and nothing can be tapped. Then, in the approval cards'
// style: a green check with "Sent"; the server's reason with Retry ("Take control" instead when
// the sign-in moved to another site or page); dimmed "You took control", "Not now" or "Expired".
// The password and the code live only in their field until Send, go straight into the request
// and the field clears at once; they are never kept in state, logged or shown again.
// Phases: SignInCardPhase (ComputerContract.swift, host-tested).
import SwiftUI

struct SignInCardView: View {
    var message: Message
    var payload: SignInPayload
    var actions: ComputerActions

    @Environment(\.cardContext) private var context
    @Environment(\.computerScene) private var scene
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The last button tapped: its spinner, and what Retry repeats.
    private enum Tap { case send, code, takeOver, dismiss }

    /// What the body shows: the phase, with a tap in flight kept on the surface it was made on.
    private enum Shown {
        case credentials(busy: Bool)
        case code(reason: String?, busy: Bool)
        case takeControl(reason: String?, busy: Bool)
        case failed(reason: String?)
        case sent, expired, takenOver, dismissed
    }

    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    /// Retry after a failure shows the form again (the email comes back, the password doesn't).
    @State private var retrying = false
    @State private var lastEmail = ""
    @State private var lastTap: Tap?
    @State private var sends = 0

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var domainSize: CGFloat = 13
    @ScaledMetric(relativeTo: .body) private var outcomeSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var promptSize: CGFloat = 15
    @ScaledMetric(relativeTo: .subheadline) private var quietSize: CGFloat = 15

    // MARK: - State

    private var answer: SignInCardResponse? {
        SignInCardPhase.answer(state: scene.view.signIns[payload.requestId], full: scene.view.signInAnswers[payload.requestId])
    }

    private var request: CardRequest? { context.requests[ShellState.RequestKey.signIn(payload.requestId)] }

    private func resolve(request: CardRequest?) -> SignInCardPhase {
        SignInCardPhase.resolve(payload: payload, answer: answer, request: request, afterCode: lastTap == .code) { phrase in
            PhraseText.string(phrase, locale: locale)
        }
    }

    private var retryStep: SignInStep { SignInCardPhase.retryStep(payload: payload, answer: answer) }

    private var phase: SignInCardPhase {
        let resolved = resolve(request: request)
        // Retry shows the form the failure came from again (not after a "Take control" failure:
        // that one's action is the take-over itself).
        if retrying, case .failed(_, let takeControl) = resolved, !takeControl {
            return retryStep == .code ? .code(reason: nil) : .form
        }
        return resolved
    }

    private var shown: Shown {
        switch phase {
        case .form: return .credentials(busy: false)
        case .code(let reason): return .code(reason: reason, busy: false)
        case .failed(let reason, true): return .takeControl(reason: reason, busy: false)
        case .failed(let reason, false): return .failed(reason: reason)
        case .sent: return .sent
        case .expired: return .expired
        case .takenOver: return .takenOver
        case .dismissed: return .dismissed
        case .sending:
            // The tap stays on the surface it was made on.
            switch lastTap {
            case .send: return .credentials(busy: true)
            case .code: return .code(reason: nil, busy: true)
            case .takeOver, .dismiss, nil:
                if case .failed(let reason, true) = resolve(request: nil) { return .takeControl(reason: reason, busy: true) }
                return retryStep == .code ? .code(reason: nil, busy: true) : .credentials(busy: true)
            }
        }
    }

    // MARK: - Layout

    var body: some View {
        let phase = phase
        VStack(alignment: .leading, spacing: 14) {
            header
            content
        }
        .padding(16)
        .frame(maxWidth: 360, alignment: .leading)
        .cardSurface()
        .opacity(phase.isClosed ? 0.55 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeInOut(duration: 0.25), value: phase)
        .sensoryFeedback(.impact(weight: .medium), trigger: sends)
        .sensoryFeedback(trigger: phase) { old, new in
            switch (old, new) {
            case (_, .sent) where old != .sent: .success
            case (.sending, .failed), (.sending, .code(reason: .some(_))): .warning
            default: nil
            }
        }
        .onChange(of: phase) { _, new in
            if new == .sending || new == .sent { retrying = false }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Sign in to \(payload.domain)"))
    }

    @ViewBuilder
    private var content: some View {
        switch shown {
        case .credentials(let busy):
            credentials(busy: busy).transition(.opacity)
        case .code(let reason, let busy):
            codeStep(reason: reason, busy: busy).transition(.opacity)
        case .takeControl(let reason, let busy):
            takeControlFailure(reason: reason, busy: busy).transition(.opacity)
        case .failed(let reason):
            InlineFailure(reason: reason ?? String(localized: "OpenDuet's browser couldn't use that sign-in."), onRetry: retry)
        case .sent:
            outcome(icon: "checkmark.circle.fill", color: Palette.success, title: Text("Sent"))
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.9)))
        case .expired:
            outcome(icon: "clock", color: Palette.secondaryText, title: Text("Expired"))
        case .takenOver:
            closedOutcome(glyph: .computer, title: Text("You took control"))
        case .dismissed:
            closedOutcome(glyph: .failed, title: Text("Not now"))
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            SiteBadge(domain: payload.domain)
            VStack(alignment: .leading, spacing: 2) {
                Text("Sign in to \(payload.domain)")
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: payload.domain)
                    .font(.system(size: domainSize))
                    .foregroundStyle(Palette.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    // MARK: - Forms

    private func credentials(busy: Bool) -> some View {
        VStack(spacing: 10) {
            TextField(text: $email, prompt: Text("Email address")) { Text("Email address") }
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .signInField()
            SecureField(text: $password, prompt: Text("Password")) { Text("Password") }
                .textContentType(.password)
                .submitLabel(.send)
                .onSubmit(send)
                .privacySensitive()
                .signInField()
            CapsuleButton(title: Text("Send to OpenDuet's browser"), busy: busy && isMainTap, action: send)
                .disabled(!busy && !canSend)
            waysOut(busy: busy)
        }
        .disabled(busy)
    }

    /// M20: the site asked for a one-time code (some codes have letters: default keyboard).
    private func codeStep(reason: String?, busy: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Enter the code \(payload.domain) sent you")
                .font(.system(size: promptSize))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let reason {
                ReasonLine(reason: reason)
            }
            TextField(text: $code, prompt: Text("Verification code")) { Text("Verification code") }
                .textContentType(.oneTimeCode)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.send)
                .onSubmit(sendCode)
                .privacySensitive()
                .signInField()
            CapsuleButton(title: Text("Send code"), busy: busy && isMainTap, action: sendCode)
                .disabled(!busy && !canSendCode)
            waysOut(busy: busy)
        }
        .disabled(busy)
    }

    /// The main button's spinner: anything but the two quiet buttons.
    private var isMainTap: Bool { lastTap != .takeOver && lastTap != .dismiss }

    /// "Take control instead" and "Not now", quiet under the main button.
    private func waysOut(busy: Bool) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 20) { quietButtons(busy: busy) }
            VStack(spacing: 0) { quietButtons(busy: busy) }
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func quietButtons(busy: Bool) -> some View {
        quietButton(Text("Take control instead"), busy: busy && lastTap == .takeOver, action: takeOver)
            .accessibilityHint(Text("Opens OpenDuet's computer so you can sign in yourself"))
        quietButton(Text("Not now"), busy: busy && lastTap == .dismiss, action: dismiss)
    }

    /// The form card's quiet "Skip" look: grey medium text, a spinner in place while it runs.
    private func quietButton(_ title: Text, busy: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            title
                .font(.system(size: quietSize, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
                .opacity(busy ? 0 : 1)
                .overlay { if busy { ProgressView().controlSize(.small) } }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.94))
    }

    // MARK: - Failures and outcomes

    /// The sign-in moved to another site or page: Retry can't fix it, the user signs in themselves.
    private func takeControlFailure(reason: String?, busy: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ReasonLine(reason: reason ?? String(localized: "OpenDuet's browser couldn't use that sign-in."))
            HStack(spacing: 8) {
                CapsuleButton(title: Text("Take control"), style: .outline, busy: busy && lastTap != .dismiss, fullWidth: false, action: takeOver)
                    .accessibilityHint(Text("Opens OpenDuet's computer so you can sign in yourself"))
                CapsuleButton(title: Text("Not now"), style: .outline, busy: busy && lastTap == .dismiss, fullWidth: false, action: dismiss)
            }
            .disabled(busy)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func outcome(icon: String, color: Color, title: Text) -> some View {
        HStack(spacing: 6) {
            // M9: the hand-drawn mark in the outcome's colour.
            DuetArtGlyph(art: DuetArt(symbol: icon), symbol: icon, size: outcomeSize + 4, tint: color)
                .accessibilityHidden(true)
            title.font(.system(size: outcomeSize, weight: .semibold))
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityElement(children: .combine)
    }

    /// M20: "You took control" / "Not now", grey like Expired (the card dims too).
    private func closedOutcome(glyph: DuetGlyph, title: Text) -> some View {
        HStack(spacing: 6) {
            DuetIcon(glyph: glyph, size: outcomeSize + 4, tint: Palette.secondaryText)
                .accessibilityHidden(true)
            title.font(.system(size: outcomeSize, weight: .semibold))
        }
        .foregroundStyle(Palette.secondaryText)
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Actions

    private var canSend: Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
    }

    private var canSendCode: Bool { !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func send() {
        guard canSend else { return }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = password
        // Cleared before the request even starts: nothing keeps the password.
        password = ""
        email = ""
        lastEmail = address
        lastTap = .send
        sends += 1
        actions.sendSignIn(message.id, payload.requestId, address, secret)
    }

    private func sendCode() {
        guard canSendCode else { return }
        let secret = code.trimmingCharacters(in: .whitespacesAndNewlines)
        // Like the password: the field clears before the request starts.
        code = ""
        lastTap = .code
        sends += 1
        actions.sendSignInCode(message.id, payload.requestId, secret)
    }

    private func takeOver() {
        password = ""
        code = ""
        lastTap = .takeOver
        actions.takeOverSignIn(message.id, payload.requestId)
    }

    private func dismiss() {
        password = ""
        code = ""
        lastTap = .dismiss
        actions.dismissSignIn(message.id, payload.requestId)
    }

    /// A failed "Take control instead" / "Not now" tap runs again; after a failed send the form
    /// (or the code field) shows again.
    private func retry() {
        switch lastTap {
        case .takeOver: takeOver()
        case .dismiss: dismiss()
        case .send, .code, nil:
            email = lastEmail
            retrying = true
        }
    }
}

/// The round letter badge standing in for the site's favicon.
struct SiteBadge: View {
    var domain: String

    var body: some View {
        Text(verbatim: SiteMonogram.letter(for: domain))
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(Palette.primaryText)
            .frame(width: 36, height: 36)
            .background(Circle().fill(Palette.tile))
            .overlay(Circle().strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline))
            .accessibilityHidden(true)
    }
}

/// InlineFailure's warning line without its buttons (a refused code over the code field, a
/// failure whose action isn't Retry).
private struct ReasonLine: View {
    var reason: String

    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 14

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            DuetIcon(glyph: .warning, size: fontSize + 2, tint: Palette.failure)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(verbatim: reason)
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private extension View {
    func signInField() -> some View {
        font(.system(size: 16))
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.tile))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline))
    }
}
