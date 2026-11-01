// Profile › Signed-in devices (M28, docs/API.md "M28 sessions"): This iPhone (its model name, when
// it signed in and when it signs out by itself; Sign out stays on the profile sheet), Other devices
// in the server's order (name or "Unknown device", Last active, the address, a bell when it gets
// pushes, Sign out asked in place), and "Sign out other devices" asked in place with "Signed out N
// devices" after. GET /api/sessions when the page appears and on pull to refresh; a server before
// M28 gets one line. Texts and rules: DevicesRules; data: DevicesModel. No alerts.
import SwiftUI

struct DevicesPage: View {
    var onBack: () -> Void

    @Environment(\.apiClient) private var api
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var devices = DevicesModel()
    /// the row whose Sign out question is open (one at a time)
    @State private var asking: String?
    /// "Sign out other devices" is asking
    @State private var askingOthers = false
    /// a sign-out that went through: one success haptic
    @State private var successes = 0

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Signed-in devices"), leading: .back, onLeading: onBack)
            ScrollView {
                // "Last active 5 minutes ago" moves on by itself.
                TimelineView(.everyMinute) { context in
                    content(clock: DevicesRules.Clock(locale: locale, now: context.date))
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .refreshable { await devices.refresh() }
        }
        .task {
            devices.attach(api)
            await devices.load()
        }
        .sensoryFeedback(.success, trigger: successes)
    }

    private var spring: Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86)
    }

    @ViewBuilder private func content(clock: DevicesRules.Clock) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            switch devices.screen {
            case .loading:
                SettingsRowsSkeleton(rows: 3)
                    .transition(.opacity)
            case .failed(let reason):
                InlineRetryLine(reason: reason) { Task { await devices.load() } }
                    .cardSurface()
                    .transition(.opacity)
            case .olderServer:
                QuietCard(text: Text("This server doesn't list devices yet. Update it to sign out other devices."))
                    .transition(.opacity)
            case .loaded(let list):
                loaded(DevicesRules.layout(list), clock: clock)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeInOut(duration: 0.25), value: devices.screen)
        .animation(spring, value: asking)
        .animation(spring, value: askingOthers)
        .animation(.easeInOut(duration: 0.2), value: devices.rowFailures)
        .animation(.easeInOut(duration: 0.2), value: devices.revokeFailure)
        .animation(.easeInOut(duration: 0.25), value: devices.revokedLine)
    }
}

// MARK: - The list

extension DevicesPage {
    @ViewBuilder private func loaded(_ layout: DevicesRules.Layout, clock: DevicesRules.Clock) -> some View {
        if let current = layout.current {
            let row = DevicesRules.currentRow(current, clock: clock)
            VStack(alignment: .leading, spacing: 0) {
                SheetSectionTitle(text: Text(verbatim: DevicesRules.currentTitle()))
                DeviceRow(row: row)
                    .cardSurface()
            }
            .transition(.opacity)
        }
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Other devices"))
            if layout.showsNoOthers {
                QuietCard(text: Text("No other devices are signed in."))
                    .transition(.opacity)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(layout.others.enumerated()), id: \.element.id) { index, session in
                        VStack(spacing: 0) {
                            if index > 0 {
                                Divider().overlay(Palette.cardBorder).padding(.leading, 16 + 32 + 12)
                            }
                            otherRow(DevicesRules.otherRow(session, clock: clock))
                        }
                        .transition(rowExit)
                    }
                }
                .frame(maxWidth: .infinity)
                .cardSurface()
                .transition(.opacity)
            }
        }
        if layout.showsSignOutOthers || devices.revoking {
            signOutOthers
                .transition(.opacity)
        }
        if let line = devices.revokedLine {
            DoneLine(text: line)
                .transition(.opacity)
        }
        SettingsNote(text: Text("Each device stays signed in for 90 days after it signs in. A device you sign out goes back to the sign-in screen and gets no more notifications from this app."))
    }

    /// A signed-out row leaves: it fades and slides away (a crossfade with Reduce Motion).
    private var rowExit: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .opacity, removal: .opacity.combined(with: .move(edge: .trailing)))
    }
}

// MARK: - Sign out, one or the others

extension DevicesPage {
    /// Another device's row: trailing "Sign out", then the question in place under it.
    private func otherRow(_ row: DevicesRules.Row) -> some View {
        let busy = devices.signingOut.contains(row.id)
        let failure = devices.rowFailures[row.id]
        return VStack(alignment: .leading, spacing: 0) {
            DeviceRow(row: row) {
                if asking != row.id && !busy && failure == nil {
                    RowSignOutButton(name: row.title) { ask(row.id) }
                        .transition(.opacity)
                }
            }
            if asking == row.id || busy || failure != nil {
                DeleteConfirmStrip(
                    question: Text("Sign out this device?"),
                    confirmTitle: Text("Sign out"),
                    busy: busy,
                    failure: failure,
                    announcement: "Confirm sign out",
                    onConfirm: { confirm(row.id) },
                    onCancel: { cancel(row.id) }
                )
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
                .transition(.confirmReveal(reduceMotion: reduceMotion))
            }
        }
    }

    /// "Sign out other devices": the capsule, then the question in place with Cancel and the red
    /// capsule; a refusal shows its reason with Retry and the list stays.
    @ViewBuilder private var signOutOthers: some View {
        if askingOthers || devices.revoking || devices.revokeFailure != nil {
            DeleteConfirmStrip(
                question: Text("Sign out every other device? They go back to the sign-in screen."),
                confirmTitle: Text("Sign out"),
                busy: devices.revoking,
                failure: devices.revokeFailure,
                announcement: "Confirm sign out",
                onConfirm: confirmOthers,
                onCancel: cancelOthers
            )
            .transition(.confirmReveal(reduceMotion: reduceMotion))
        } else {
            CapsuleButton(title: Text("Sign out other devices"), style: .outline) { askingOthers = true }
                .transition(.opacity)
        }
    }

    private func ask(_ id: String) {
        if let open = asking, open != id { devices.clearRowFailure(open) }
        askingOthers = false
        asking = id
    }

    private func confirm(_ id: String) {
        Task {
            switch await devices.signOut(id) {
            case .gone:
                successes += 1
                if asking == id { asking = nil }
            case .reload:
                if asking == id { asking = nil }
            case .ignore, .failed:
                break
            }
        }
    }

    private func cancel(_ id: String) {
        devices.clearRowFailure(id)
        if asking == id { asking = nil }
    }

    private func confirmOthers() {
        Task {
            guard await devices.signOutOthers() else { return }
            askingOthers = false
            successes += 1
        }
    }

    private func cancelOthers() {
        devices.clearRevokeFailure()
        askingOthers = false
    }
}

// MARK: - Pieces

/// One device: its tile, the name (a bell when it gets pushes), the detail line, the expiry or the
/// address in grey, then the trailing view.
private struct DeviceRow<Trailing: View>: View {
    var row: DevicesRules.Row
    @ViewBuilder var trailing: () -> Trailing

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 13.5
    @ScaledMetric(relativeTo: .footnote) private var addressSize: CGFloat = 12.5

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            RowSymbol(systemImage: row.symbol, tint: row.named ? Palette.tileGlyph : Palette.secondaryText)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: row.title)
                        .font(.system(size: titleSize, weight: .medium))
                        .foregroundStyle(row.named ? Palette.primaryText : Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    if row.push {
                        DuetIcon(.bell, size: titleSize - 2, tint: Palette.secondaryText)
                            .accessibilityHidden(true)
                    }
                }
                Text(verbatim: row.detail)
                    .font(.system(size: detailSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentTransition(.opacity)
                if let expiry = row.expiry {
                    Text(verbatim: expiry)
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let address = row.address {
                    Text(verbatim: address)
                        .font(.system(size: addressSize).monospacedDigit())
                        .foregroundStyle(Palette.secondaryText.opacity(0.8))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityValue(row.push ? Text("Gets notifications") : Text(verbatim: ""))
            trailing()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: Metrics.sheetRowMinHeight)
    }
}

extension DeviceRow where Trailing == EmptyView {
    init(row: DevicesRules.Row) {
        self.init(row: row) { EmptyView() }
    }
}

/// The row's trailing "Sign out" (red text, a 44 pt target).
private struct RowSignOutButton: View {
    var name: String
    var action: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 15

    var body: some View {
        Button(action: action) {
            Text("Sign out")
                .font(.system(size: fontSize, weight: .medium))
                .foregroundStyle(Palette.destructive)
                .lineLimit(1)
                .padding(.horizontal, 4)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.94))
        .accessibilityLabel(Text("Sign out \(name)"))
    }
}

/// "Signed out 2 devices" with a check, in place after Sign out other devices.
private struct DoneLine: View {
    var text: String

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14.5

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            DuetIcon(glyph: .done, size: fontSize + 1, tint: Palette.success)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(verbatim: text)
                .font(.system(size: fontSize, weight: .medium))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
        .accessibilityElement(children: .combine)
        .onAppear { AccessibilityNotification.Announcement(text).post() }
    }
}

/// One grey line on a card ("No other devices are signed in.", an older server's line).
private struct QuietCard: View {
    var text: Text

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14.5

    var body: some View {
        text
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .cardSurface()
    }
}
