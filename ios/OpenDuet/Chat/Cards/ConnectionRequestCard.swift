// M11: request_connection / request_secret. The card names what the assistant wants to connect, why,
// and the server URL or domain as a quiet line. api_key and mcp cards take the fields the assistant
// listed (SecureField for secrets) and Connect posts them once (POST /api/messages/:id/connect):
// secrets leave the card's state the moment Connect is tapped, everything goes once it connects,
// and a 400 shows the server's reason under the fields with the card still open. app cards use
// the existing Composio connect for `toolkit`. Not now = action "dismiss". Connected folds to
// "Connected · <name>". M29: a card the assistant withdrew reads "Withdrawn" instead of "Not now".
import SwiftUI

struct ConnectionRequestCard: View {
    var message: Message
    var payload: ConnectionRequestPayload
    var actions: ShellActions
    var onSent: () -> Void

    @Environment(\.cardContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private enum Tap { case connect, dismiss }
    private enum Focus: Hashable { case url, domain, field(String) }
    @State private var lastTap: Tap?
    @State private var draft = ConnectionDraft()
    @State private var expanded = false
    @State private var connectTaps = 0
    @State private var successes = 0
    @State private var failures = 0
    @FocusState private var focus: Focus?
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var smallSize: CGFloat = 13
    @ScaledMetric(relativeTo: .body) private var fieldSize: CGFloat = 16

    /// An app card's Composio connect, in flight while its OAuth page is up.
    private var connectKey: String? {
        guard payload.type == .app, let toolkit = payload.toolkit, !toolkit.isEmpty else { return nil }
        return ShellState.RequestKey.connect(toolkit)
    }

    private var phase: ConnectionRequestPhase {
        ConnectionRequestPhase(payload.state, request: context.requests[message.id], connect: connectKey.flatMap { context.requests[$0] })
    }

    private var canConnect: Bool {
        payload.type == .app ? connectKey != nil : draft.canSubmit(payload)
    }

    var body: some View {
        let phase = phase
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text)
            switch phase {
            case .connected:
                FoldedCardLine(glyph: .done, tint: Palette.success, label: Text("Connected · \(payload.name)"), onExpand: nil)
                    .transition(.opacity)
            case .dismissed where !expanded:
                // M29: "Withdrawn" when the assistant took the card back (closedBy "assistant").
                FoldedCardLine(
                    glyph: .link, tint: Palette.secondaryText,
                    label: payload.isWithdrawn ? Text("\(payload.name) · Withdrawn") : Text("\(payload.name) · Not now"),
                    onExpand: { expanded = true }
                )
                .transition(.opacity)
            default:
                card(phase).transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86), value: phase)
        .animation(.easeInOut(duration: 0.25), value: expanded)
        .onChange(of: phase) { old, new in
            switch new {
            case .connected:
                // Nothing typed stays once it's connected (whoever connected it).
                draft = ConnectionDraft()
                focus = nil
                if lastTap != nil { successes += 1 }
                lastTap = nil
            case .dismissed:
                draft = ConnectionDraft()
                focus = nil
                lastTap = nil
                expanded = false
            case .failed:
                if old == .busy { failures += 1 }
            default:
                break
            }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: connectTaps)
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.warning, trigger: failures)
    }

    private func card(_ phase: ConnectionRequestPhase) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if !payload.purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(verbatim: payload.purpose)
                    .font(.system(size: bodySize))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if phase.showsForm && payload.type != .app {
                form(busy: phase == .busy)
            }
            if case .failed(let reason) = phase {
                FormFailureLine(reason: reason).transition(.opacity)
            }
            footer(phase)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .opacity(phase == .dismissed ? 0.75 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Connect \(payload.name)"))
    }

    private var header: some View {
        HStack(spacing: 12) {
            logo
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: payload.name)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let line = ConnectionCardCopy.addressLine(payload) {
                    Text(verbatim: line)
                        .font(.system(size: smallSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var logo: some View {
        switch payload.type {
        case .app:
            ConnectorLogo(toolkit: payload.toolkit ?? "", name: payload.name, size: 36)
        case .mcp:
            DuetIconTile(glyph: .tool, size: 36)
        case .apiKey:
            DuetIconTile(glyph: .link, size: 36)
        }
    }

    // MARK: - Form (api_key / mcp)

    private func form(busy: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if ConnectionDraft.needsURL(payload) {
                input(label: Text("Server URL"), focus: .url, secret: false) {
                    TextField(text: $draft.url, prompt: Text(verbatim: "https://")) { Text("Server URL") }
                        .keyboardType(.URL)
                }
            }
            if ConnectionDraft.needsDomain(payload) {
                input(label: Text("Domain"), focus: .domain, secret: false) {
                    TextField(text: $draft.domain, prompt: Text(verbatim: "api.example.com")) { Text("Domain") }
                        .keyboardType(.URL)
                }
            }
            ForEach(payload.fields) { field in
                input(label: Text(verbatim: field.label), focus: .field(field.key), secret: field.secret) {
                    if field.secret {
                        SecureField(text: binding(field.key), prompt: prompt(field)) { Text(verbatim: field.label) }
                    } else {
                        TextField(text: binding(field.key), prompt: prompt(field)) { Text(verbatim: field.label) }
                    }
                }
            }
            if payload.fields.contains(where: \.secret) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    DuetIcon(glyph: .info, size: smallSize + 1, tint: Palette.secondaryText)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    Text("Goes straight to your server's vault. OpenDuet never sees it.")
                        .font(.system(size: smallSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .disabled(busy)
    }

    /// A field with its small label above and the sign-in card's field look.
    private func input<Field: View>(label: Text, focus target: Focus, secret: Bool, @ViewBuilder field: () -> Field) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            label
                .font(.system(size: smallSize, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
                .accessibilityHidden(true)
            field()
                .font(.system(size: fieldSize))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .privacySensitive(secret)
                .focused($focus, equals: target)
                .submitLabel(next(after: target) == nil ? .go : .next)
                .onSubmit {
                    if let next = next(after: target) { focus = next } else { connect() }
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.tile))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline))
        }
    }

    private func prompt(_ field: ConnectionRequestPayload.Field) -> Text {
        if let placeholder = field.placeholder, !placeholder.isEmpty { Text(verbatim: placeholder) } else { Text("Required") }
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(
            get: { draft.value(key) },
            set: { draft.values[key] = $0 }
        )
    }

    /// The fields in order, for Return = next.
    private var focusOrder: [Focus] {
        var order: [Focus] = []
        if ConnectionDraft.needsURL(payload) { order.append(.url) }
        if ConnectionDraft.needsDomain(payload) { order.append(.domain) }
        order += payload.fields.map { .field($0.key) }
        return order
    }

    private func next(after target: Focus) -> Focus? {
        let order = focusOrder
        guard let index = order.firstIndex(of: target), index + 1 < order.count else { return nil }
        return order[index + 1]
    }

    // MARK: - Footer

    @ViewBuilder
    private func footer(_ phase: ConnectionRequestPhase) -> some View {
        switch phase {
        case .open, .busy, .failed:
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Not now"), style: .outline, busy: phase == .busy && lastTap == .dismiss) { dismiss() }
                CapsuleButton(title: Text("Connect"), style: .filled, busy: phase == .busy && lastTap != .dismiss) { connect() }
                    .disabled(phase != .busy && !canConnect)
                    .accessibilityLabel(Text("Connect \(payload.name)"))
            }
            .disabled(phase == .busy)
        case .dismissed:
            Button { expanded = false } label: {
                MakeOutcomeLine(icon: .failed, color: Palette.secondaryText, title: payload.isWithdrawn ? Text("Withdrawn") : Text("Not now"))
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityHint(Text("Collapses the card"))
        case .connected:
            EmptyView()
        }
    }

    // MARK: - Taps

    private func connect() {
        guard phase != .busy, canConnect else { return }
        lastTap = .connect
        connectTaps += 1
        focus = nil
        if payload.type == .app {
            if let toolkit = payload.toolkit { actions.connectors.connect(toolkit) }
            return
        }
        // The values go into this one request; the secrets leave the card's state right away.
        let body = draft.submission(for: payload)
        draft.dropSecrets(of: payload)
        actions.submitConnection(message.id, body)
    }

    private func dismiss() {
        guard phase != .busy else { return }
        lastTap = .dismiss
        focus = nil
        actions.cards.action(message.id, .dismiss, nil)
    }
}
