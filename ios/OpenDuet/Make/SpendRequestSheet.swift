// The Link-style spend request's sheet (prompt L158): "OpenDuet is requesting to spend $16.49",
// "Expires in 29 min", the merchant with Inspect, the description, the card row, the fine print
// and Decline / Approve. Test mode says plainly that nothing is charged. States follow the M3
// approval card: a spinner in the tapped button, ✓ Approved, Declined, Expired, a failure with
// Retry. The minutes tick on each whole minute.
import SwiftUI

/// The green Link mark: a rounded square with a chain link.
struct LinkMark: View {
    var size: CGFloat = 22

    var body: some View {
        DuetIcon(glyph: .link, size: size * 0.62, tint: Palette.linkGreenText)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(Palette.linkGreen))
            .accessibilityHidden(true)
    }
}

/// "Test mode": a small amber capsule.
struct TestModeBadge: View {
    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 12

    var body: some View {
        Text("Test mode")
            .font(.system(size: fontSize, weight: .semibold))
            .foregroundStyle(Palette.needsInput)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Palette.needsInput.opacity(0.14)))
            .fixedSize()
    }
}

struct SpendRequestSheet: View {
    var spend: SpendRequest
    var request: CardRequest?
    var lastTap: SpendRequestCard.Tap?
    var onApprove: () -> Void
    var onDecline: () -> Void
    var onClose: () -> Void

    @Environment(\.locale) private var locale
    @State private var inspecting = false
    @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = 24
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16
    @ScaledMetric(relativeTo: .caption) private var fineSize: CGFloat = 12
    @ScaledMetric(relativeTo: .body) private var brandSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var expirySize: CGFloat = 15
    @ScaledMetric(relativeTo: .subheadline) private var smallSize: CGFloat = 14

    private var amount: String { CardFormat.money(minor: spend.amount, currency: spend.currency, locale: locale) }

    var body: some View {
        TimelineView(.periodic(from: ApprovalCard.tickStart(spend.expiresAt), by: 60)) { context in
            content(phase: SpendPhase(spend, request: request, now: context.date), now: context.date)
        }
    }

    private func content(phase: SpendPhase, now: Date) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                LinkMark(size: 26)
                Text(verbatim: "Link").font(.system(size: brandSize, weight: .semibold)).foregroundStyle(Palette.primaryText)
                if spend.testMode { TestModeBadge() }
                Spacer()
                CircleIconButton(systemImage: "xmark", label: Text("Close"), action: onClose)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("OpenDuet is requesting to spend \(amount)")
                            .font(.system(size: titleSize, weight: .bold))
                            .foregroundStyle(Palette.primaryText)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                        expiry(phase: phase, now: now)
                    }
                    merchantCard
                    cardRow
                    Text("By approving this hold, you take responsibility for any agent purchases. Your real payment details are never shared.")
                        .font(.system(size: fineSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    if spend.testMode {
                        Label { Text("Test mode: no real money moves.") } icon: { DuetIcon(glyph: .info, size: fineSize + 3, tint: Palette.needsInput) }
                            .font(.system(size: fineSize, weight: .medium))
                            .foregroundStyle(Palette.needsInput)
                    }
                }
                .padding(20)
            }
            footer(phase)
                .padding(.horizontal, 20)
                .padding(.bottom, 12)
        }
        .animation(.easeInOut(duration: 0.25), value: phase)
        .animation(.easeInOut(duration: 0.25), value: inspecting)
    }

    @ViewBuilder
    private func expiry(phase: SpendPhase, now: Date) -> some View {
        if phase == .expired {
            Text("Expired").font(.system(size: expirySize)).foregroundStyle(Palette.secondaryText)
        } else if let minutes = CardFormat.minutesLeft(until: spend.expiresAt, now: now), phase.isOpen || phase == .busy {
            Text("Expires in \(CardFormat.expiryDuration(minutes: minutes, locale: locale))")
                .font(.system(size: expirySize).monospacedDigit())
                .foregroundStyle(minutes <= 2 ? Palette.needsInput : Palette.secondaryText)
                .contentTransition(.numericText(countsDown: true))
        }
    }

    private var merchantCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Text(verbatim: String(spend.merchant.prefix(1)).uppercased())
                    .font(.system(size: 17, weight: .bold))
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Palette.primaryText.opacity(0.06)))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: spend.merchant).font(.system(size: bodySize, weight: .semibold))
                    Text(verbatim: spend.item).font(.system(size: smallSize)).foregroundStyle(Palette.secondaryText).lineLimit(2)
                }
                Spacer(minLength: 8)
                Button { inspecting.toggle() } label: {
                    Text("Inspect")
                        .font(.system(size: smallSize, weight: .semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Capsule().strokeBorder(Palette.outline, lineWidth: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.95))
                .accessibilityValue(inspecting ? Text("Expanded") : Text("Collapsed"))
            }
            if !spend.description.isEmpty {
                Text(verbatim: spend.description)
                    .font(.system(size: bodySize))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if inspecting {
                VStack(spacing: 8) {
                    detail(Text("Merchant"), spend.merchant)
                    detail(Text("Item"), spend.item)
                    detail(Text("Amount"), amount)
                    detail(Text("Expires"), spend.expiresAt.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale)))
                }
                .transition(.opacity)
            }
        }
        .foregroundStyle(Palette.primaryText)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }

    private func detail(_ label: Text, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            label.foregroundStyle(Palette.secondaryText)
            Spacer(minLength: 12)
            Text(verbatim: value).multilineTextAlignment(.trailing)
        }
        .font(.system(size: smallSize))
        .accessibilityElement(children: .combine)
    }

    /// The card Link would use: a one-time card for this merchant (the real one is never shared).
    private var cardRow: some View {
        HStack(spacing: 12) {
            DuetIcon(glyph: .payments, size: 21, tint: Palette.linkGreen)
                .frame(width: 40, height: 28)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Palette.linkGreen.opacity(0.12)))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("One-time card from Link").font(.system(size: bodySize, weight: .semibold))
                Text("A hold of \(amount), only for \(spend.merchant)")
                    .font(.system(size: smallSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Palette.primaryText)
        .padding(16)
        .cardSurface()
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func footer(_ phase: SpendPhase) -> some View {
        switch phase {
        case .pending, .busy:
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Decline"), style: .outline, busy: phase == .busy && lastTap == .decline, action: onDecline)
                CapsuleButton(title: Text("Approve"), style: .filled, busy: phase == .busy && lastTap != .decline, action: onApprove)
                    .accessibilityLabel(Text("Approve spending \(amount) at \(spend.merchant)"))
            }
            .disabled(phase == .busy)
        case .failed(let reason):
            InlineFailure(reason: reason, onRetry: { lastTap == .decline ? onDecline() : onApprove() }, onEdit: nil)
        case .approved:
            MakeOutcomeLine(icon: .done, color: Palette.success, title: Text("Approved"))
        case .declined:
            MakeOutcomeLine(icon: .failed, color: Palette.secondaryText, title: Text("Declined"))
        case .expired:
            MakeOutcomeLine(icon: .clock, color: Palette.secondaryText, title: Text("Expired"))
        }
    }
}

/// A card's settled state: ✓ Approved / Saved, Declined, Expired (M3 approval-card style).
struct MakeOutcomeLine: View {
    var icon: DuetGlyph
    var color: Color
    var title: Text

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 16

    var body: some View {
        HStack(spacing: 6) {
            DuetIcon(glyph: icon, size: fontSize + 4, tint: color)
            title.font(.system(size: fontSize, weight: .semibold))
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}
