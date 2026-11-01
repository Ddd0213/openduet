// M22 (#47) the rows of Everything → Setup: a tile, the title, the status word (Ready / Not
// checked / Needs setup) and the detail line; under a row that isn't ready, its fix: a button
// that opens the page (models, apps, voice, the assistant's computer), or the backend/.env names in a
// monospaced block with the hint (long-press copies; nothing to tap). The phone's own
// Notifications row comes first, with "Turn on" while they are off.
import SwiftUI
import UIKit

/// "● Ready" as a small tinted capsule at the end of a row.
struct SetupStatusChip: View {
    var status: SetupRowStatus

    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 12
    @ScaledMetric(relativeTo: .caption) private var dot: CGFloat = 6

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(tint).frame(width: dot, height: dot)
            Text(status.label)
        }
        .font(.system(size: fontSize, weight: .semibold))
        .foregroundStyle(status == .notChecked ? Palette.secondaryText : tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(status == .notChecked ? Palette.tile : tint.opacity(0.12)))
        .lineLimit(1)
        .fixedSize()
        .contentTransition(.opacity)
    }

    private var tint: Color {
        switch status {
        case .ready: Palette.success
        case .needsSetup: Palette.needsInput
        case .notChecked: Palette.secondaryText
        }
    }
}

/// One Setup row: tile, title and status, the detail under them, then `fix` (if any).
struct SetupRowFrame<Fix: View>: View {
    var symbol: String
    var title: Text
    var status: SetupRowStatus
    var detail: Text?
    @ViewBuilder var fix: () -> Fix

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 13.5

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RowSymbol(systemImage: symbol)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        title
                            .font(.system(size: titleSize, weight: .medium))
                            .foregroundStyle(Palette.primaryText)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        SetupStatusChip(status: status)
                    }
                    if let detail {
                        detail
                            .font(.system(size: detailSize))
                            .foregroundStyle(Palette.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
                fix()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: Metrics.sheetRowMinHeight, alignment: .top)
        .animation(.easeInOut(duration: 0.2), value: status)
    }
}

/// A server row (GET /api/setup).
struct SetupItemRow: View {
    var item: SetupItem
    var onFix: (SetupFixAction) -> Void

    @Environment(\.locale) private var locale

    /// The server's detail phrase; no line when it renders empty.
    private var detail: Text? {
        let text = PhraseText.string(item.detail, locale: locale).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : Text(verbatim: text)
    }

    var body: some View {
        let fix = SetupFixAction(item)
        SetupRowFrame(
            symbol: Self.symbol(item.id), title: Text(verbatim: PhraseText.string(item.title, locale: locale)),
            status: SetupRowStatus(item.status), detail: detail
        ) {
            if let fix {
                switch fix {
                case .env(let names, let hint):
                    SetupEnvFix(names: names, hint: hint)
                case .page, .link:
                    if let title = fix.buttonTitle {
                        CapsuleButton(title: Text(title), style: .outline, fullWidth: false) { onFix(fix) }
                    }
                }
            }
        }
    }

    /// The tile of each dependency (hand-drawn where the set has it); a newer row gets the wrench.
    static func symbol(_ id: String) -> String {
        switch id {
        case "model": "text.bubble"
        case "search": "magnifyingglass"
        case "apps": "square.grid.2x2"
        case "computer": DuetGlyph.computer.symbol
        case "push": "paperplane"
        case "voice": "waveform"
        default: DuetGlyph.notSetUp.symbol
        }
    }
}

/// A server setting the app can't change: the variable names (monospaced, selectable; a
/// long-press copies them) and what to do with them.
struct SetupEnvFix: View {
    var names: [String]
    var hint: Phrase

    @State private var copies = 0
    @ScaledMetric(relativeTo: .footnote) private var codeSize: CGFloat = 13
    @ScaledMetric(relativeTo: .footnote) private var hintSize: CGFloat = 13

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: names.joined(separator: "\n"))
                .font(.system(size: codeSize, design: .monospaced))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.tile))
                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .contextMenu {
                    Button {
                        UIPasteboard.general.string = names.joined(separator: "\n")
                        copies += 1
                    } label: {
                        Label { Text("Copy") } icon: { Image(systemName: DuetGlyph.copy.symbol) }
                    }
                }
                .accessibilityLabel(Text(verbatim: names.joined(separator: ", ")))
            PhraseText(phrase: hint)
                .font(.system(size: hintSize))
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .sensoryFeedback(.success, trigger: copies)
    }
}

/// The phone's own first row: are notifications on for OpenDuet?
struct SetupPhoneNotificationsRow: View {
    var access: NotificationAccess?
    var onTurnOn: () -> Void

    var body: some View {
        SetupRowFrame(
            symbol: "bell", title: Text("Notifications"),
            status: SetupNotificationsRow.status(access), detail: detail
        ) {
            if SetupNotificationsRow.action(access) != nil {
                CapsuleButton(title: Text("Turn on"), style: .outline, fullWidth: false, action: onTurnOn)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: access)
    }

    private var detail: Text? {
        switch access {
        case .on?: Text("Briefs, finished tasks and questions reach this iPhone.")
        case .off?: Text("Notifications are off for OpenDuet in iOS Settings, so briefs and check-ins only show up in the app.")
        case .undecided?: Text("Allow notifications so OpenDuet can tell you when tasks are done or your input is needed.")
        case nil: nil
        }
    }
}
