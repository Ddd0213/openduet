// Confirmation, single-action alert and "Your plate today" cards (prompt L111): a booked
// confirmation (app tile, title, detail, green ✓); "One thing needs you" with a full-width black
// button (http(s) links open in the thread's Safari sheet, everything else goes to the store);
// and the plate, one row per item with an outline action pill that sends the action's prompt
// (done items check off and grey out).
import SwiftUI

// MARK: - Confirmation

struct ConfirmationCard: View {
    var message: Message
    var payload: ConfirmationPayload

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            HStack(alignment: .top, spacing: 12) {
                if CardFormat.toolkitSlug(payload.app) != nil {
                    IconTile(app: payload.app)
                } else {
                    DuetIconTile(glyph: .confirmation)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: payload.title)
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    if !payload.detail.isEmpty {
                        Text(verbatim: payload.detail)
                            .font(.system(size: detailSize))
                            .foregroundStyle(Palette.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 4)
                DuetIcon(glyph: .done, size: 22, tint: Palette.success)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Alert

struct AlertCard: View {
    var message: Message
    var payload: AlertPayload
    var onAction: (AlertPayload.Action) -> Void

    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    if let toolkit = payload.action.toolkit {
                        AppLogo(toolkit: toolkit, name: toolkit, size: 18)
                    }
                    PhraseText(phrase: payload.title)
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                PhraseText(phrase: payload.body)
                    .font(.system(size: bodySize))
                    .foregroundStyle(Palette.primaryText.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                CapsuleButton(title: PhraseText.text(payload.action.label), style: .filled) { tap() }
                    .padding(.top, 6)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()
            .accessibilityElement(children: .contain)
        }
    }

    /// open_url with an http(s) link: the thread's in-app Safari sheet (its OpenURLAction);
    /// other links and kinds go to the store (duet:// routes, connectors, usage, browser).
    private func tap() {
        if payload.action.type == .openURL, let link = payload.action.url, let url = URL(string: link), SafariLink(url) != nil {
            openURL(url)
        } else {
            onAction(payload.action)
        }
    }
}

extension PhraseText {
    /// A phrase as Text for places that take a Text (button titles).
    static func text(_ phrase: Phrase) -> Text {
        Text(verbatim: string(phrase))
    }
}

// MARK: - Plate

struct PlateCard: View {
    var message: Message
    var payload: PlatePayload
    var onSend: (_ prompt: String) -> Void

    @ScaledMetric(relativeTo: .title3) private var headerSize: CGFloat = 17
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var pillSize: CGFloat = 14
    @State private var sends = 0

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            VStack(alignment: .leading, spacing: 0) {
                Text("Your plate today")
                    .font(.system(size: headerSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .padding(.bottom, 6)
                ForEach(Array(payload.items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Divider().overlay(Palette.cardBorder) }
                    row(item)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()
            .animation(.easeInOut(duration: 0.25), value: payload.items.map(\.done))
        }
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
    }

    private func row(_ item: PlatePayload.Item) -> some View {
        HStack(alignment: .center, spacing: 10) {
            DuetIcon(glyph: item.done ? .done : .pending, size: 22, tint: item.done ? Palette.success : Palette.secondaryText.opacity(0.6))
                .id(item.done)
                .transition(.opacity)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.title)
                    .font(.system(size: titleSize, weight: .medium))
                    .strikethrough(item.done, color: Palette.secondaryText)
                    .foregroundStyle(item.done ? Palette.secondaryText : Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                if !item.detail.isEmpty {
                    Text(verbatim: item.detail)
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 6)
            if !item.done {
                Button {
                    sends += 1
                    onSend(item.action.prompt)
                } label: {
                    Text(verbatim: item.action.label)
                        .font(.system(size: pillSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(Capsule().strokeBorder(Palette.outline, lineWidth: 1))
                        .contentShape(Capsule())
                        .fixedSize()
                }
                .buttonStyle(PressableButtonStyle(scale: 0.95))
                .accessibilityLabel(Text(verbatim: "\(item.action.label): \(item.title)"))
                .transition(.opacity)
            }
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
        .accessibilityValue(item.done ? Text("Done") : Text(verbatim: ""))
    }
}
