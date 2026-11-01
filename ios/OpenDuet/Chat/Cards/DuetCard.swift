// M9: the assistant's generic native info card (kind "card", the show_card tool, contract §2): an
// A2UI-style card so the assistant can show structured things instead of walls of text. The header is a
// DuetIconTile in the card's tint with the title and subtitle; then the blocks (markdown text,
// icon rows with a trailing value, a 2-column metric grid with trend-coloured deltas, progress
// bars, a checklist with hand-drawn marks, a small Swift Charts bar chart; unknown types are
// skipped, DuetCardBlocks.swift); then up to 3 capsule actions: send (the value as the user's
// message), open_url (https only, the thread's in-app Safari sheet) and open_route (duet://).
import SwiftUI

struct DuetCardView: View {
    var message: Message
    var payload: CardPayload
    var streaming: Bool
    var actions: ShellActions
    var onSent: () -> Void

    /// The thread's OpenURLAction: http(s) opens the in-app Safari sheet (ThreadView.route).
    @Environment(\.openURL) private var openURL
    @State private var sends = 0
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var subtitleSize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text, streaming: streaming)
            VStack(alignment: .leading, spacing: 16) {
                header
                ForEach(Array(payload.blocks.filter(\.isSupported).enumerated()), id: \.offset) { _, block in
                    // M24: a checkable checklist ticks through the card's action (check / uncheck).
                    DuetCardBlockView(block: block, tint: payload.tint, messageId: message.id) { itemId, done in
                        actions.cards.action(message.id, done ? .check : .uncheck, itemId)
                    }
                }
                if !buttons.isEmpty { actionRow.padding(.top, 2) }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()
            .accessibilityElement(children: .contain)
        }
        // Sending a value as the user: light, like the composer's send (L186).
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            DuetIconTile(icon: payload.icon, tint: payload.tint.tileGlyph, accent: payload.tint.color)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: payload.title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle = payload.subtitle, !subtitle.isEmpty {
                    Text(verbatim: subtitle)
                        .font(.system(size: subtitleSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: Actions

    /// The actions the app can carry out, at most 3: an open_url that isn't https or an
    /// open_route that isn't duet:// is left out rather than shown dead.
    private var buttons: [CardAction] {
        Array(payload.actions.filter(\.isUsable).prefix(3))
    }

    /// Side by side while they fit; stacked full-width otherwise. Primary filled, secondary outline.
    private var actionRow: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                ForEach(Array(buttons.enumerated()), id: \.offset) { _, action in
                    button(action, fullWidth: false).fixedSize()
                }
                Spacer(minLength: 0)
            }
            VStack(spacing: 8) {
                ForEach(Array(buttons.enumerated()), id: \.offset) { _, action in
                    button(action, fullWidth: true)
                }
            }
        }
    }

    private func button(_ action: CardAction, fullWidth: Bool) -> some View {
        CapsuleButton(title: Text(verbatim: action.label), style: action.style == .primary ? .filled : .outline, fullWidth: fullWidth) {
            perform(action)
        }
        .accessibilityHint(action.type == .send ? Text("Sends this as your message") : Text(verbatim: ""))
    }

    private func perform(_ action: CardAction) {
        switch action.type {
        case .send:
            sends += 1
            actions.cards.sendText(action.value)
            onSent()
        case .openURL:
            if let url = action.httpsURL { openURL(url) }
        case .openRoute:
            if let url = action.duetRoute { actions.openRoute(url) }
        }
    }
}

extension CardAction {
    /// open_url: https only (contract §2).
    var httpsURL: URL? {
        guard let url = URL(string: value), url.scheme?.lowercased() == "https", url.host != nil else { return nil }
        return url
    }

    /// open_route: a duet:// route only.
    var duetRoute: URL? {
        guard let url = URL(string: value), url.scheme?.lowercased() == "duet" else { return nil }
        return url
    }

    var isUsable: Bool {
        switch type {
        case .send: !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .openURL: httpsURL != nil
        case .openRoute: duetRoute != nil
        }
    }
}
