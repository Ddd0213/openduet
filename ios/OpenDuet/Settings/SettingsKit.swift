// M11 pieces the OpenDuet sheets' pages share (Everything and a channel's): the mascot header,
// the on / off switch row, quiet notes, the save row, and the theme constants of these pages.
// Same visual language as SheetKit / CardKit / ConfirmKit.
import SwiftUI

extension Metrics {
    /// Rows with a 32 pt leading tile: the hairline starts after the tile.
    static let settingsTileInset: CGFloat = 16 + 32 + 12
    /// The on / off switch track.
    static let settingsSwitchWidth: CGFloat = 46
    static let settingsSwitchHeight: CGFloat = 28
}

extension Palette {
    /// The switch track when on: the accent (reads in light and dark, unlike the black / white fill).
    static let settingsSwitchOn = Palette.accent
}

/// The large mascot and a serif title under it ("OpenDuet", or a channel's "#name"), with an
/// optional grey line (the channel's purpose).
struct SettingsHero: View {
    var title: Text
    var subtitle: Text?

    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 30
    @ScaledMetric(relativeTo: .subheadline) private var subtitleSize: CGFloat = 15

    var body: some View {
        VStack(spacing: 0) {
            DuetMascot(pose: .idle, size: 56, animated: true)
                .frame(width: 104, height: 104)
                .background(Circle().fill(Palette.floatingSurface).floatingShadow())
                .accessibilityHidden(true)
            title
                .font(Typography.serifTitle(titleSize))
                .foregroundStyle(Palette.primaryText)
                .multilineTextAlignment(.center)
                .padding(.top, 14)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                subtitle
                    .font(.system(size: subtitleSize))
                    .foregroundStyle(Palette.secondaryText)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .padding(.top, 6)
                    .padding(.horizontal, 24)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// A capsule switch drawn in the app's language (no system Toggle anywhere in the app). Visual
/// only: the row around it is the button and carries the accessibility value.
struct SettingsSwitch: View {
    var on: Bool
    var busy = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let knob = Metrics.settingsSwitchHeight - 6
        ZStack(alignment: on ? .trailing : .leading) {
            Capsule()
                .fill(on ? Palette.settingsSwitchOn : Palette.tile)
                .overlay(Capsule().strokeBorder(on ? .clear : Palette.cardBorder, lineWidth: Metrics.hairline))
            Circle()
                .fill(Color.white)
                .shadow(color: .black.opacity(0.16), radius: 2, y: 1)
                .frame(width: knob, height: knob)
                .overlay { if busy { ProgressView().controlSize(.mini).tint(Palette.secondaryText) } }
                .padding(3)
        }
        .frame(width: Metrics.settingsSwitchWidth, height: Metrics.settingsSwitchHeight)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.28, dampingFraction: 0.8), value: on)
        .accessibilityHidden(true)
    }
}

/// A row with a title, an optional grey line and a switch; the whole row toggles. A failure
/// shows its reason under the row (the switch is back where it was by then).
struct SettingsToggleRow<Leading: View>: View {
    var title: Text
    var subtitle: Text?
    var on: Bool
    var busy = false
    var failure: String?
    var onChange: (Bool) -> Void
    @ViewBuilder var leading: () -> Leading

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetRow(title: title, subtitle: subtitle, action: { onChange(!on) }, leading: leading) {
                SettingsSwitch(on: on, busy: busy)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isToggle)
            .accessibilityValue(on ? Text("On") : Text("Off"))
            if let failure {
                SettingsReasonLine(reason: failure)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: failure)
        .sensoryFeedback(.selection, trigger: on)
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
    }
}

extension SettingsToggleRow where Leading == EmptyView {
    init(title: Text, subtitle: Text? = nil, on: Bool, busy: Bool = false, failure: String? = nil, onChange: @escaping (Bool) -> Void) {
        self.init(title: title, subtitle: subtitle, on: on, busy: busy, failure: failure, onChange: onChange) { EmptyView() }
    }
}

/// A failure's reason as one quiet line with the warning mark (no Retry: the form or row is
/// still there to try again).
struct SettingsReasonLine: View {
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

/// Skeleton rows of a settings card (a tile and two lines) while its first load runs.
struct SettingsRowsSkeleton: View {
    var rows = 2

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Palette.skeleton)
                        .frame(width: 32, height: 32)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 110 : 84), height: 13)
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 190 : 150), height: 10)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: Metrics.sheetRowMinHeight + 4)
            }
        }
        .cardSurface()
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading"))
    }
}

/// A row's trailing spinner while its request runs (nothing otherwise).
struct BusySpinner: View {
    var busy: Bool

    var body: some View {
        if busy {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel(Text("In progress"))
        }
    }
}

/// A grey explanatory line under a section or a field.
struct SettingsNote: View {
    var text: Text

    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        text
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
    }
}
