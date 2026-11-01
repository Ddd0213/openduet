// Approval cards in every state (prompt L106-L110, L182): email, payment, signature, delete
// and generic tool cards. Nothing happens until a tap. Approve / Send shows a spinner inside the
// button and disables both. M8: success plays a green check that draws its stroke with "Sent" /
// "Paid" / "Signed" / "Deleted" / "Done" and the success haptic, then about 1.2 s later the card
// folds to one grey summary line ("✓ Run commands · Done ›"); Not now folds at once; a tap on
// the line opens the card again (springy height + crossfade, Reduce Motion: crossfade only).
// Cards already done or declined when the thread loads start folded. Expired dims with
// "Expired" + an "Ask again" chip; a failure shows the reason with Retry and Edit. Edits by chat
// glow the changed text (fields from ThreadView). Phase and fold rules: ApprovalFold.swift.
import SwiftUI

struct ApprovalCard: View {
    var message: Message
    var approval: Approval
    var actions: CardActions
    var onOpenRoute: (URL) -> Void
    var onSent: () -> Void

    @Environment(\.cardContext) private var context
    @Environment(\.cardHooks) private var hooks
    @Environment(\.glowingFields) private var glowingFields
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Tap { case approve, decline, always }
    @State private var lastTap: Tap?
    @State private var fold: ApprovalFold
    @State private var approveTaps = 0
    @State private var successes = 0
    @State private var failures = 0
    @ScaledMetric(relativeTo: .body) private var outcomeSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var summarySize: CGFloat = 14
    @ScaledMetric(relativeTo: .footnote) private var alwaysSize: CGFloat = 13

    init(message: Message, approval: Approval, actions: CardActions, onOpenRoute: @escaping (URL) -> Void, onSent: @escaping () -> Void) {
        self.message = message
        self.approval = approval
        self.actions = actions
        self.onOpenRoute = onOpenRoute
        self.onSent = onSent
        // A card mounting already done / declined (thread load, scroll back) rests folded.
        _fold = State(initialValue: ApprovalFold.start(ApprovalPhase(approval: approval, request: nil, now: .now)))
    }

    var body: some View {
        let phase = phase(now: .now)
        return Group {
            if let expiresAt = approval.expiresAt, approval.status == .pending {
                // "Expires in 8 min" ticks at each whole minute before expiresAt.
                TimelineView(.periodic(from: Self.tickStart(expiresAt), by: 60)) { timeline in
                    content(now: timeline.date)
                }
            } else {
                content(now: .now)
            }
        }
        // Outside the branches: the switch from the ticking branch to the plain one happens in
        // the same update as pending → done, and must still be seen as a change.
        .onChange(of: phase) { old, new in phaseChanged(from: old, to: new) }
        .task(id: fold) { await foldAfterCelebration() }
        .sensoryFeedback(.impact(weight: .medium), trigger: approveTaps)
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.warning, trigger: failures)
    }
    /// A tick start in the past that lands a tick exactly on every whole minute before `expiresAt`.
    static func tickStart(_ expiresAt: Date, now: Date = .now) -> Date {
        let minutes = max(expiresAt.timeIntervalSince(now) / 60, 0).rounded(.up) + 1
        return expiresAt.addingTimeInterval(-minutes * 60)
    }

    // MARK: - State

    func phase(now: Date) -> ApprovalPhase {
        ApprovalPhase(approval: approval, request: context.requests[message.id], now: now)
    }

    private func reason(_ phase: ApprovalPhase) -> String {
        guard case .failed(let reason, let phrase) = phase else { return "" }
        if let reason, !reason.isEmpty { return reason }
        if let phrase {
            let text = PhraseText.string(phrase, locale: locale)
            if !text.isEmpty { return text }
        }
        return String(localized: "Something went wrong")
    }

    private var glowing: Set<String> { glowingFields[message.id] ?? [] }

    /// The one summary line instead of the card (only once settled; a pending card never folds).
    private func showsLine(_ phase: ApprovalPhase) -> Bool {
        fold.isFolded && phase.isSettled
    }

    /// Opening / folding: springy height + crossfade; Reduce Motion crossfades only.
    private var foldAnimation: Animation {
        reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.42, dampingFraction: 0.82)
    }

    private func phaseChanged(from old: ApprovalPhase, to new: ApprovalPhase) {
        let next = fold.next(after: new)
        if next != fold { withAnimation(foldAnimation) { fold = next } }
        guard lastTap != nil else { return }
        switch new {
        case .done: successes += 1; lastTap = nil
        case .failed: failures += 1
        case .declined: lastTap = nil
        default: break
        }
    }

    /// The success moment stays ~1.2 s, then the card folds to its line.
    private func foldAfterCelebration() async {
        guard fold == .celebrating else { return }
        try? await Task.sleep(for: .seconds(ApprovalFold.celebrationSeconds))
        guard !Task.isCancelled else { return }
        withAnimation(foldAnimation) { fold = fold.afterCelebration }
    }

    private func toggleFold() {
        withAnimation(foldAnimation) { fold = fold.toggled }
    }

    // MARK: - Layout

    private func content(now: Date) -> some View {
        let phase = phase(now: now)
        return VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            if showsLine(phase) {
                summaryLine(phase).transition(.opacity)
            } else {
                card(phase: phase, now: now).transition(.opacity)
            }
            chips(phase)
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86), value: phase)
    }
    private func card(phase: ApprovalPhase, now: Date) -> some View {
        let interactive = phase == .pending || phase.isFailed
        return VStack(alignment: .leading, spacing: 14) {
            ApprovalBody(
                approval: approval, glowing: glowing, now: now, interactive: interactive,
                onEdit: { hooks.focusComposer() },
                onOpenFile: { id in if let url = URL(string: "duet://files/\(id)") { onOpenRoute(url) } }
            )
            footer(phase)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .opacity(phase == .expired ? 0.5 : (phase == .declined ? 0.75 : 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(summary)
    }

    @ViewBuilder
    private func footer(_ phase: ApprovalPhase) -> some View {
        switch phase {
        case .pending, .busy:
            VStack(spacing: 4) {
                HStack(spacing: 10) {
                    CapsuleButton(title: Text("Not now"), style: .outline, busy: phase == .busy && lastTap == .decline) { decline() }
                        .accessibilityLabel(Text("Not now"))
                    CapsuleButton(title: approveTitle, style: .filled, busy: phase == .busy && lastTap != .decline && lastTap != .always) { approve() }
                        .accessibilityLabel(approveLabel)
                }
                // M20: what Always on this card covers, said exactly (one recipient, or one site and
                // kind of click); no row when the server offers none. M23: only for low-risk kinds
                // (never payments, signatures, deletes, purchases or account changes).
                if ApprovalWhyRules.showsAlways(approval), let always = ApprovalAlwaysRules.rowText(approval.always) {
                    alwaysRow(always, busy: phase == .busy && lastTap == .always)
                }
            }
            .disabled(phase == .busy)
        case .failed:
            InlineFailure(reason: reason(phase), onRetry: retry, onEdit: { hooks.focusComposer() })
        case .done:
            // The success moment; once it has folded and been opened again, a tap folds it back.
            Button(action: toggleFold) {
                outcome(color: Palette.success, title: doneTitle) {
                    SuccessCheck(size: outcomeSize + 4)
                }
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(fold == .celebrating)
            .accessibilityHint(Text("Collapses the card"))
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.9)))
        case .declined:
            Button(action: toggleFold) {
                outcome(color: Palette.secondaryText, title: Text("Not now")) {
                    DuetIcon(glyph: .failed, size: outcomeSize + 4, tint: Palette.secondaryText)
                }
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityHint(Text("Collapses the card"))
        case .expired:
            outcome(color: Palette.secondaryText, title: Text("Expired")) {
                DuetIcon(glyph: .clock, size: outcomeSize + 4, tint: Palette.secondaryText)
            }
        }
    }

    /// M20: Approve and remember Always for the card's scope, in the card's grey secondary text
    /// (the whole scope wraps, never truncated). M23: fainter than the two buttons (regular weight,
    /// a size down): it changes a rule, not just this answer.
    private func alwaysRow(_ text: String, busy: Bool) -> some View {
        Button(action: approveAlways) {
            Text(verbatim: text)
                .font(.system(size: alwaysSize))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .opacity(busy ? 0 : 1)
                .overlay { if busy { ProgressView().controlSize(.small) } }
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.97))
        .accessibilityValue(busy ? Text("In progress") : Text(verbatim: ""))
    }

    private func outcome<Icon: View>(color: Color, title: Text, @ViewBuilder icon: () -> Icon) -> some View {
        HStack(spacing: 6) {
            icon().accessibilityHidden(true)
            title.font(.system(size: outcomeSize, weight: .semibold))
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// Folded: one grey line, "✓ Run commands · Done ›" / "✕ Email to Sam · Not now ›"; a tap
    /// opens the card.
    private func summaryLine(_ phase: ApprovalPhase) -> some View {
        Button(action: toggleFold) {
            HStack(spacing: 8) {
                if phase == .done {
                    DuetIcon(glyph: .check, size: summarySize + 2, tint: Palette.success)
                } else {
                    DuetIcon(glyph: .close, size: summarySize + 1, tint: Palette.secondaryText)
                }
                summary.lineLimit(1)
                Text(verbatim: "·").accessibilityHidden(true)
                (phase == .done ? doneTitle : Text("Not now")).fixedSize()
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: summarySize - 2, weight: .semibold))
                    .accessibilityHidden(true)
            }
            .font(.system(size: summarySize))
            .foregroundStyle(Palette.secondaryText)
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface(corner: 14)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Shows the card"))
    }

    /// "↪ Shorten" under a pending email (L106), "Ask again" under an expired card (L182).
    @ViewBuilder
    private func chips(_ phase: ApprovalPhase) -> some View {
        if phase == .expired {
            SendChip(title: Text("Ask again")) { send(String(localized: "Ask again")) }
                .transition(.opacity)
        } else if case .email = approval.preview, phase == .pending || phase.isFailed {
            SendChip(title: Text("Shorten")) { send(String(localized: "Shorten")) }
                .transition(.opacity)
        }
    }
    // MARK: - Copy by kind

    private var amountText: String? {
        if case .payment(let p) = approval.preview { return CardFormat.money(minor: p.amount, currency: p.currency, locale: locale) }
        return nil
    }

    /// What the card is about: the recipient or the amount (VoiceOver and the folded line).
    private var summary: Text {
        switch approval.preview {
        case .email(let p): Text("Email to \(CardFormat.recipients(p.to))")
        case .payment(let p): Text("Payment of \(amountText ?? "") to \(p.merchant)")
        case .sign(let p): Text("Signature request: \(p.title)")
        case .delete(let p): Text("Delete: \(p.title)")
        // Built-in tools ("Run commands") through the catalog, Composio names as sent.
        case .action(let p): Text(builtInName: p.toolName)
        }
    }

    private var approveTitle: Text {
        if case .email = approval.preview { return Text("Send") }
        return Text("Approve")
    }

    private var approveLabel: Text {
        switch approval.preview {
        case .email(let p): Text("Send email to \(CardFormat.recipients(p.to))")
        case .payment(let p): Text("Approve payment of \(amountText ?? "") to \(p.merchant)")
        case .sign(let p): Text("Approve signature request: \(p.title)")
        case .delete(let p): Text("Approve delete: \(p.title)")
        case .action(let p): Text("Approve \(RunTexts.builtInName(p.toolName))")
        }
    }

    private var doneTitle: Text {
        switch approval.kind {
        case .email: Text("Sent")
        case .payment: Text("Paid")
        case .sign: Text("Signed")
        case .delete: Text("Deleted")
        case .action: Text("Done")
        }
    }

    // MARK: - Actions

    private func approve() {
        lastTap = .approve
        approveTaps += 1
        actions.approve(message.id, approval.id, approval.version)
    }

    private func decline() {
        lastTap = .decline
        actions.decline(message.id, approval.id, approval.version)
    }

    /// M20: Approve + Always for `approval.always`'s scope.
    private func approveAlways() {
        lastTap = .always
        approveTaps += 1
        actions.approveAlways(message.id, approval.id, approval.version)
    }

    private func retry() {
        switch lastTap {
        case .decline: decline()
        case .always: approveAlways()
        case .approve, nil: approve()
        }
    }

    private func send(_ text: String) {
        actions.sendText(text)
        onSent()
    }
}

/// The success moment's mark: a green circle whose white check draws its stroke (like the
/// onboarding check). Reduce Motion shows it drawn.
private struct SuccessCheck: View {
    var size: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var progress: CGFloat = 0

    var body: some View {
        Circle()
            .fill(Palette.success)
            .overlay(CheckStroke(progress: progress, lineWidth: size * 0.12, color: .white).padding(size * 0.27))
            .frame(width: size, height: size)
            .onAppear {
                if reduceMotion {
                    progress = 1
                } else {
                    withAnimation(.easeOut(duration: 0.45).delay(0.08)) { progress = 1 }
                }
            }
    }
}
