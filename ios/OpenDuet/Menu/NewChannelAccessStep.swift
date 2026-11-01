// M11: the New channel sheet's second step, "What can OpenDuet use here?": the user's skills, custom
// connectors and connected apps (NewChannelAccess). Items on for every channel show on with "All
// channels" and can't be turned off here; the rest start off and are picked with a tap. Loading
// shows skeleton rows, a failure its reason with Retry (Create still works: the channel then
// starts with what's on everywhere). Selection logic is in NewChannelAccess.swift.
import SwiftUI

enum NewChannelAccessLoad: Hashable, Sendable {
    case loading
    case loaded
    case failed(reason: String)
}

struct NewChannelAccessStep: View {
    var access: NewChannelAccess
    var load: NewChannelAccessLoad
    /// cardRequests[RequestKey.createChannel]: a failed Create shows its reason here
    var request: CardRequest?
    var onToggle: (ChannelAccess.Item) -> Void
    var onRetryLoad: () -> Void
    var onRetryCreate: () -> Void

    @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = 24
    @ScaledMetric(relativeTo: .subheadline) private var noteSize: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("What can OpenDuet use here?")
                    .font(Typography.serifTitle(titleSize))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text("What's on for all channels is already here. Pick anything else this channel should have.")
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 6)
            switch load {
            case .loading:
                AccessPickSkeleton().transition(.opacity)
            case .failed(let reason):
                InlineFailure(reason: reason, onRetry: onRetryLoad, onEdit: nil)
                    .padding(.horizontal, 6)
            case .loaded:
                if access.isEmpty {
                    Text("No skills, connectors or apps yet. You can add them later in the OpenDuet sheet.")
                        .font(.system(size: noteSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 6)
                } else {
                    ForEach(access.sections) { section in
                        VStack(spacing: 0) {
                            SheetSectionTitle(text: Self.title(section.kind))
                            CardSection(dividerInset: 60) {
                                ForEach(section.items) { item in
                                    AccessPickRow(
                                        item: item, on: access.isOn(item), locked: access.isLocked(item),
                                        onToggle: { onToggle(item) }
                                    )
                                }
                            }
                        }
                    }
                }
            }
            if case .failed(let reason) = request {
                InlineFailure(reason: reason, onRetry: onRetryCreate, onEdit: nil)
                    .padding(.horizontal, 6)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: load)
    }

    static func title(_ kind: AccessKind) -> Text {
        switch kind {
        case .skill: Text("Skills")
        case .connector: Text("Custom connectors")
        case .app: Text("Apps")
        }
    }
}

/// One item: its mark, name and description; a hand-drawn box that's ticked when it's on.
private struct AccessPickRow: View {
    var item: ChannelAccess.Item
    var on: Bool
    var locked: Bool
    var onToggle: () -> Void

    @ScaledMetric(relativeTo: .body) private var boxSize: CGFloat = 24

    var body: some View {
        Group {
            if locked {
                row
            } else {
                Button(action: onToggle) { row }
                    .buttonStyle(RowPressStyle())
                    .sensoryFeedback(.selection, trigger: on)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityValue(locked ? Text("All channels") : (on ? Text("On") : Text("Off")))
        .accessibilityHint(locked ? Text(verbatim: "") : Text("Turns it on or off for this channel"))
    }

    private var row: some View {
        SheetRow(
            title: Text(verbatim: item.name),
            subtitle: subtitle,
            action: nil,
            leading: { leading },
            trailing: {
                HandCheckbox(checked: on, size: boxSize, doneInk: locked ? Palette.secondaryText : Palette.accent)
            }
        )
    }

    private var subtitle: Text? {
        let description = item.description.trimmingCharacters(in: .whitespacesAndNewlines)
        if locked {
            return description.isEmpty ? Text("All channels") : Text("All channels · \(description)")
        }
        return description.isEmpty ? nil : Text(verbatim: description)
    }

    @ViewBuilder
    private var leading: some View {
        switch item.kind {
        case .skill: DuetIconTile(glyph: .skill, size: 32, tint: Palette.makePurple)
        case .connector: DuetIconTile(glyph: .tool, size: 32)
        case .app: ConnectorLogo(toolkit: item.id, name: item.name, size: 32)
        }
    }
}

/// Three grey rows while the list loads.
private struct AccessPickSkeleton: View {
    var body: some View {
        CardSection(dividerInset: 60) {
            ForEach(0..<3, id: \.self) { _ in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.skeleton).frame(width: 32, height: 32)
                    VStack(alignment: .leading, spacing: 6) {
                        Capsule().fill(Palette.skeleton).frame(width: 120, height: 11)
                        Capsule().fill(Palette.skeleton).frame(width: 190, height: 9)
                    }
                    Spacer()
                }
                .padding(.horizontal, 16)
                .frame(minHeight: Metrics.sheetRowMinHeight)
            }
        }
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading"))
    }
}
