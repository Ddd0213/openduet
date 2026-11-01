// M6 (iOS 2): the artifact card (L153), the "Save this as a skill?" card (L156) and the
// Link-style spend request card (L158). MessageView dispatches the artifact, skill_proposal and
// spend_request kinds here. Taps go through the existing seams: make.open / make.setPinned,
// CardActions.action(.saveSkill / .dismiss) and CardActions.approve / decline (a SpendRequest has
// no version, so 1 is sent). In-flight and failed taps live in cardContext.requests[messageId].
import SwiftUI

// MARK: - Artifact

struct ArtifactCard: View {
    var message: Message
    var payload: ArtifactPayload
    var actions: ShellActions
    var onSent: () -> Void

    @Environment(\.makeState) private var make
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The gallery's copy when it is at least as new (live status, pin, title); else the message's.
    private var artifact: ArtifactSummary {
        if let live = make.artifact(payload.artifact.id), live.updatedAt >= payload.artifact.updatedAt { return live }
        return payload.artifact
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                card(now: context.date)
            }
        }
    }

    private func card(now: Date) -> some View {
        let artifact = artifact
        return VStack(alignment: .leading, spacing: 0) {
            Button { actions.make.open(artifact.id) } label: {
                preview(artifact)
                    .padding(12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.99))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(previewLabel(artifact, now: now))
            .accessibilityHint(Text("Opens it"))
            Divider().overlay(Palette.cardBorder)
            ArtifactCardFooter(
                artifact: artifact, now: now,
                pinBusy: make.requests[MakeState.RequestKey.pin(artifact.id)] == .inFlight,
                onOpen: { actions.make.open(artifact.id) },
                onPin: { actions.make.setPinned(artifact.id, $0) }
            )
            .padding(.leading, 12)
            .padding(.trailing, 6)
            .padding(.vertical, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86), value: artifact.status)
    }

    @ViewBuilder
    private func preview(_ artifact: ArtifactSummary) -> some View {
        if artifact.status != .building, !payload.metrics.isEmpty {
            MetricGrid(metrics: payload.metrics)
        } else {
            ArtifactPreview(artifact: artifact, corner: 12)
                .aspectRatio(1.6, contentMode: .fit)
                .frame(maxWidth: .infinity)
        }
    }

    /// "Dashboard, Launch Week, 2 hr ago. Signups, 1,204; …"
    private func previewLabel(_ artifact: ArtifactSummary, now: Date) -> Text {
        let base = ArtifactAccessibility.label(artifact, justMade: false, now: now)
        guard artifact.status != .building, !payload.metrics.isEmpty else { return base }
        let values = payload.metrics.prefix(4).map { "\($0.label), \(MakeCopy().metric($0.value, unit: $0.unit))" }.joined(separator: "; ")
        return Text("\(base). \(values)")
    }
}

// MARK: - Skill proposal

struct SkillProposalCard: View {
    var message: Message
    var payload: SkillProposalPayload
    var actions: ShellActions
    var onSent: () -> Void

    @Environment(\.cardContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private enum Tap { case save, dismiss }
    @State private var lastTap: Tap?
    @State private var expanded = false
    @State private var showSkill = false
    @State private var successes = 0
    @State private var failures = 0
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var linkSize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var hintSize: CGFloat = 13

    private var phase: SkillProposalPhase { SkillProposalPhase(payload.state, request: context.requests[message.id]) }

    var body: some View {
        let phase = phase
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            if phase == .dismissed && !expanded {
                SkillDismissedLine(name: payload.name) { expanded = true }.transition(.opacity)
            } else {
                card(phase).transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86), value: phase)
        .animation(.easeInOut(duration: 0.25), value: expanded)
        .onChange(of: phase) { _, new in
            guard lastTap != nil else { return }
            switch new {
            case .saved: successes += 1; lastTap = nil
            case .failed: failures += 1
            case .dismissed: lastTap = nil
            default: break
            }
        }
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.warning, trigger: failures)
        .sheet(isPresented: $showSkill) {
            SkillDetailSheet(name: payload.name, description: payload.description, instructions: payload.instructions) { showSkill = false }
                .duetSheetChrome()
                .presentationDetents([.medium, .large])
        }
    }

    private func card(_ phase: SkillProposalPhase) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                DuetIcon(glyph: .skill, size: 18, tint: Palette.makePurple)
                Text("Save this as a skill?")
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .accessibilityAddTraits(.isHeader)
            }
            SkillNamePill(name: payload.name)
            if !payload.description.isEmpty {
                Text(verbatim: payload.description)
                    .font(.system(size: bodySize))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button { showSkill = true } label: {
                HStack(spacing: 3) {
                    Text("View skill")
                    Image(systemName: "chevron.right").font(.system(size: linkSize - 3, weight: .semibold)).accessibilityHidden(true)
                }
                .font(.system(size: linkSize, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.96))
            footer(phase)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .opacity(phase == .dismissed ? 0.75 : 1)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func footer(_ phase: SkillProposalPhase) -> some View {
        switch phase {
        case .open, .busy:
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Not now"), style: .outline, busy: phase == .busy && lastTap == .dismiss) { dismiss() }
                CapsuleButton(title: Text("Save skill"), style: .filled, busy: phase == .busy && lastTap != .dismiss) { save() }
                    .accessibilityLabel(Text("Save skill /\(payload.name)"))
            }
            .disabled(phase == .busy)
        case .failed(let reason):
            InlineFailure(reason: reason, onRetry: { lastTap == .dismiss ? dismiss() : save() }, onEdit: nil)
        case .saved:
            VStack(spacing: 2) {
                MakeOutcomeLine(icon: .done, color: Palette.success, title: Text("Saved"))
                Text("Type /\(payload.name) to use it")
                    .font(.system(size: hintSize))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(maxWidth: .infinity)
            }
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.9)))
        case .dismissed:
            Button { expanded = false } label: {
                MakeOutcomeLine(icon: .failed, color: Palette.secondaryText, title: Text("Not now"))
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityHint(Text("Collapses the card"))
        }
    }

    private func save() {
        lastTap = .save
        actions.cards.action(message.id, .saveSkill, nil)
    }

    private func dismiss() {
        lastTap = .dismiss
        actions.cards.action(message.id, .dismiss, nil)
    }
}

// MARK: - Spend request

struct SpendRequestCard: View {
    var message: Message
    var spend: SpendRequest
    var actions: ShellActions
    var onSent: () -> Void

    enum Tap { case approve, decline }

    @Environment(\.cardContext) private var context
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lastTap: Tap?
    @State private var showSheet = false
    @State private var expanded = false
    @State private var approveTaps = 0
    @State private var successes = 0
    @State private var failures = 0
    @ScaledMetric(relativeTo: .largeTitle) private var amountSize: CGFloat = 30
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var itemSize: CGFloat = 15
    @ScaledMetric(relativeTo: .subheadline) private var smallSize: CGFloat = 14
    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 13

    /// SpendRequest has no version of its own; approvals of spend requests are sent as version 1.
    private static let version = 1

    private var amount: String { CardFormat.money(minor: spend.amount, currency: spend.currency, locale: locale) }

    var body: some View {
        // "Expires in 14 min" ticks at each whole minute before expiresAt.
        TimelineView(.periodic(from: ApprovalCard.tickStart(spend.expiresAt), by: 60)) { timeline in
            content(now: timeline.date)
        }
        .sheet(isPresented: $showSheet) {
            SpendRequestSheet(
                spend: spend, request: context.requests[message.id], lastTap: lastTap,
                onApprove: approve, onDecline: decline, onClose: { showSheet = false }
            )
            .duetSheetChrome()
            .presentationDetents([.large])
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: approveTaps)
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.warning, trigger: failures)
    }

    private func content(now: Date) -> some View {
        let phase = SpendPhase(spend, request: context.requests[message.id], now: now)
        return VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            if phase == .declined && !expanded {
                declinedSummary.transition(.opacity)
            } else {
                card(phase: phase, now: now).transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86), value: phase)
        .animation(.easeInOut(duration: 0.25), value: expanded)
        .onChange(of: phase) { _, new in
            guard lastTap != nil else { return }
            switch new {
            case .approved, .declined:
                if new == .approved { successes += 1 }
                lastTap = nil
                // The sheet shows the outcome for a moment, then goes.
                Task { try? await Task.sleep(for: .seconds(0.9)); showSheet = false }
            case .failed: failures += 1
            default: break
            }
        }
    }

    private func card(phase: SpendPhase, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                LinkMark()
                Text(verbatim: "Link").font(.system(size: itemSize, weight: .semibold)).foregroundStyle(Palette.primaryText)
                if spend.testMode { TestModeBadge() }
                Spacer(minLength: 4)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: amount)
                        .font(.system(size: amountSize, weight: .bold).monospacedDigit())
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Spacer(minLength: 8)
                    expiry(phase: phase, now: now)
                }
                Text(verbatim: spend.merchant)
                    .font(.system(size: bodySize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
            }
            Button { showSheet = true } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Order summary").font(.system(size: labelSize)).foregroundStyle(Palette.secondaryText)
                        Text(verbatim: spend.item).font(.system(size: itemSize, weight: .medium)).foregroundStyle(Palette.primaryText).lineLimit(2)
                    }
                    Spacer(minLength: 4)
                    RowChevron()
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.primaryText.opacity(0.04)))
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(PressableButtonStyle(scale: 0.98))
            .accessibilityElement(children: .combine)
            .accessibilityHint(Text("Shows the request"))
            footer(phase)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .opacity(phase == .expired ? 0.5 : (phase == .declined ? 0.75 : 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Spend request: \(amount) at \(spend.merchant)"))
    }

    @ViewBuilder
    private func expiry(phase: SpendPhase, now: Date) -> some View {
        if phase == .pending || phase == .busy, let minutes = CardFormat.minutesLeft(until: spend.expiresAt, now: now) {
            Text("Expires in \(CardFormat.expiryDuration(minutes: minutes, locale: locale))")
                .font(.system(size: smallSize).monospacedDigit())
                .foregroundStyle(minutes <= 2 ? Palette.needsInput : Palette.secondaryText)
                .contentTransition(.numericText(countsDown: true))
                .fixedSize()
        }
    }

    @ViewBuilder
    private func footer(_ phase: SpendPhase) -> some View {
        switch phase {
        case .pending, .busy:
            Button { showSheet = true } label: {
                HStack(spacing: 6) {
                    Text("Approve in Link")
                    DuetIcon(glyph: .forward, size: bodySize, tint: Palette.linkGreenText)
                }
                .font(.system(size: bodySize, weight: .semibold))
                .foregroundStyle(Palette.linkGreenText)
                .opacity(phase == .busy ? 0 : 1)
                .overlay { if phase == .busy { ProgressView().tint(Palette.linkGreenText).controlSize(.small) } }
                .frame(maxWidth: .infinity, minHeight: 46)
                .background(Capsule().fill(Palette.linkGreen))
                .contentShape(Capsule())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.97))
            .disabled(phase == .busy)
            .accessibilityValue(phase == .busy ? Text("In progress") : Text(verbatim: ""))
        case .failed(let reason):
            InlineFailure(reason: reason, onRetry: { lastTap == .decline ? decline() : approve() }, onEdit: nil)
        case .approved:
            MakeOutcomeLine(icon: .done, color: Palette.success, title: Text("Approved"))
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.9)))
        case .declined:
            Button { expanded = false } label: {
                MakeOutcomeLine(icon: .failed, color: Palette.secondaryText, title: Text("Declined"))
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityHint(Text("Collapses the card"))
        case .expired:
            MakeOutcomeLine(icon: .clock, color: Palette.secondaryText, title: Text("Expired"))
        }
    }

    /// Declined, collapsed: a grey one-line summary that expands on tap.
    private var declinedSummary: some View {
        Button { expanded = true } label: {
            HStack(spacing: 8) {
                LinkMark(size: 18)
                Text("\(amount) at \(spend.merchant)").lineLimit(1)
                Text(verbatim: "·").accessibilityHidden(true)
                Text("Declined").fixedSize()
                Spacer(minLength: 4)
                Image(systemName: "chevron.down").font(.system(size: smallSize - 2, weight: .semibold)).accessibilityHidden(true)
            }
            .font(.system(size: smallSize))
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

    private func approve() {
        lastTap = .approve
        approveTaps += 1
        actions.cards.approve(message.id, spend.approvalId, Self.version)
    }

    private func decline() {
        lastTap = .decline
        actions.cards.decline(message.id, spend.approvalId, Self.version)
    }
}
