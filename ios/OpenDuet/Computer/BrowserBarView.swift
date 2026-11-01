// M27 W6: the full-screen "OpenDuet's computer" view's own tab strip and address bar, like desktop
// Chrome in the app's colours: a light grey strip of tabs (title and ✕, no icon) with + pinned at
// its end, the active tab white and joined to the row below; ← → ↻ and a white rounded address
// field. Read-only while the assistant drives (no ✕ or +, the rest dimmed; every frame stays put so Take
// over doesn't jump). Laid out at `metrics.scale` in the landscape full screen (fonts, heights and
// paddings scaled; never scaleEffect). Page titles and hosts are plain text only
// (Text(verbatim:), already cleaned and cut by BrowserBarRules): no link detection, no selection.
import SwiftUI
import UIKit

enum BrowserBarPalette {
    /// the tab strip (the card look's top bar)
    static let strip = BrowserPalette.bar
    /// the active tab and the address row (joined)
    static let surface = Color.dynamic(light: 0xFFFFFF, dark: 0x3A3A3A)
    /// the address field inside the row
    static let field = Color.dynamic(light: 0xFFFFFF, dark: 0x2A2A2A)
    static let fieldBorder = Color.dynamic(light: 0xDADAD8, dark: 0x4A4A4A)
}

/// What the bar does after Take over (ComputerScreen wires them to the store and the field).
struct BrowserBarHandlers {
    var activate: (_ tabId: String) -> Void = { _ in }
    var close: (_ tabId: String) -> Void = { _ in }
    var newTab: () -> Void = {}
    var navigate: (_ action: NavigateRequest.Action) -> Void = { _ in }
    var beginEditing: () -> Void = {}
    var submit: () -> Void = {}
    var cancelEditing: () -> Void = {}
}

struct BrowserBarView: View {
    var model: BrowserBarRules.Model
    var metrics: BrowserBarMetrics
    @Binding var editing: BrowserAddressEditing
    var handlers: BrowserBarHandlers
    /// the frame below joins the bar (no rounded bottom corners)
    var corner: CGFloat = 12

    var body: some View {
        let live = model.presence == .live
        VStack(spacing: 0) {
            if model.layout == .tabs {
                BrowserTabStrip(model: model, metrics: metrics, handlers: handlers)
                    .frame(height: metrics.tabRowHeight)
            }
            BrowserAddressRow(model: model, metrics: metrics, editing: $editing, handlers: handlers)
                .frame(height: metrics.addressRowHeight)
                .background(BrowserBarPalette.surface)
        }
        .background(BrowserBarPalette.strip)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: corner * metrics.scale, topTrailingRadius: corner * metrics.scale, style: .continuous))
        .redacted(reason: model.presence == .skeleton ? .placeholder : [])
        .opacity(model.presence == .dimmed ? ComputerDeployRules.dimmedOpacity : 1)
        // Asleep or loading: nothing is touchable. While the assistant drives each control ignores the
        // tap itself (disabled, or guarded), so VoiceOver still reads it with its hint.
        .allowsHitTesting(live)
        .accessibilityHidden(model.presence == .skeleton)
        .animation(.easeInOut(duration: 0.25), value: model.presence)
        .animation(.easeInOut(duration: 0.25), value: model.controls)
    }
}

/// "Take over to use the browser" on every element while the assistant drives (none when it can't help:
/// asleep, loading, an older computer).
private func readOnlyHint(_ model: BrowserBarRules.Model) -> Text {
    model.presence == .live && model.layout == .tabs && !model.controls.interactive
        ? Text("Take over to use the browser") : Text(verbatim: "")
}

// MARK: - The tab strip

private struct BrowserTabStrip: View {
    var model: BrowserBarRules.Model
    var metrics: BrowserBarMetrics
    var handlers: BrowserBarHandlers

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let plusWidth = metrics.length(40)
        GeometryReader { proxy in
            let width = metrics.tabWidth(row: proxy.size.width - plusWidth)
            HStack(spacing: 0) {
                ScrollViewReader { reader in
                    ScrollView(.horizontal) {
                        HStack(spacing: metrics.length(2)) {
                            ForEach(model.tabs) { item in
                                BrowserTabCell(item: item, model: model, metrics: metrics, handlers: handlers)
                                    .frame(width: width)
                                    .id(item.id)
                            }
                        }
                        .padding(.leading, metrics.length(6))
                        .frame(maxHeight: .infinity, alignment: .bottom)
                    }
                    .scrollIndicators(.hidden)
                    .onAppear { reader.scrollTo(model.activeId, anchor: .center) }
                    .onChange(of: model.activeId) { _, id in
                        guard let id else { return }
                        if reduceMotion {
                            reader.scrollTo(id, anchor: .center)
                        } else {
                            withAnimation(.easeInOut(duration: 0.25)) { reader.scrollTo(id, anchor: .center) }
                        }
                    }
                }
                plus
                    .frame(width: plusWidth)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Tabs"))
    }

    /// Pinned outside the scroll so it is always reachable; hidden (its space kept) while the assistant drives.
    private var plus: some View {
        Button(action: handlers.newTab) {
            Image(systemName: "plus")
                .font(.system(size: metrics.length(15), weight: .medium))
                .foregroundStyle(Palette.primaryText)
                .frame(width: metrics.length(32), height: metrics.length(28))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.9))
        .opacity(model.controls.canAdd ? 1 : 0)
        .disabled(!model.controls.canAdd)
        .accessibilityLabel(Text("New tab"))
        .accessibilityHidden(!model.controls.canAdd)
    }
}

/// One tab: its cleaned title (one line, cut at the tail) and ✕; the active one white and joined
/// to the address row. No icon and no placeholder glyph.
private struct BrowserTabCell: View {
    var item: BrowserBarRules.TabItem
    var model: BrowserBarRules.Model
    var metrics: BrowserBarMetrics
    var handlers: BrowserBarHandlers

    private var canClose: Bool { model.controls.canClose && !item.placeholder }

    var body: some View {
        let corner = metrics.length(9)
        HStack(spacing: metrics.length(4)) {
            name
                .font(.system(size: metrics.tabFontSize, weight: item.active ? .semibold : .regular))
                .foregroundStyle(item.active ? Palette.primaryText : Palette.secondaryText)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            closeButton
        }
        .padding(.leading, metrics.length(10))
        .padding(.trailing, metrics.length(2))
        .frame(height: metrics.tabRowHeight - metrics.length(5))
        .background {
            if item.active {
                UnevenRoundedRectangle(topLeadingRadius: corner, topTrailingRadius: corner, style: .continuous)
                    .fill(BrowserBarPalette.surface)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard model.controls.canSwitch, !item.placeholder, !item.active else { return }
            handlers.activate(item.id)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(nameText)
        .accessibilityAddTraits(item.active ? [.isSelected] : [])
        .accessibilityAddTraits(model.controls.canSwitch ? [.isButton] : [])
        .accessibilityHint(readOnlyHint(model))
        .accessibilityActions {
            if canClose {
                Button(action: { handlers.close(item.id) }) { Text("Close tab") }
            }
        }
    }

    /// Plain text only: the title, the domain (its end kept), or "New tab".
    @ViewBuilder private var name: some View {
        switch item.name {
        case .title(let title): Text(verbatim: title).truncationMode(.tail)
        case .domain(let domain): Text(verbatim: domain).truncationMode(.head)
        case .newTab: Text("New tab").truncationMode(.tail)
        }
    }

    private var nameText: Text {
        switch item.name {
        case .title(let title): Text(verbatim: title)
        case .domain(let domain): Text(verbatim: domain)
        case .newTab: Text("New tab")
        }
    }

    /// Hidden while the assistant drives, keeping its space.
    private var closeButton: some View {
        Button(action: { handlers.close(item.id) }) {
            Image(systemName: "xmark")
                .font(.system(size: metrics.length(9), weight: .bold))
                .foregroundStyle(Palette.secondaryText)
                .frame(width: metrics.length(26), height: metrics.length(26))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.85))
        .opacity(canClose ? 1 : 0)
        .disabled(!canClose)
    }
}

// MARK: - The address row

/// ← → ↻ and the rounded field (the host when idle). Editing: the field takes the row with Cancel
/// (← → ↻ step aside, as in Safari and Chrome). An older computer: the field alone, read-only.
private struct BrowserAddressRow: View {
    var model: BrowserBarRules.Model
    var metrics: BrowserBarMetrics
    @Binding var editing: BrowserAddressEditing
    var handlers: BrowserBarHandlers

    private var isEditing: Bool { editing.isEditing && model.controls.canEdit }

    var body: some View {
        HStack(spacing: metrics.length(2)) {
            if model.layout == .tabs && !isEditing {
                navButton("chevron.backward", label: Text("Go back"), enabled: model.controls.canGoBack) { handlers.navigate(.back) }
                navButton("chevron.forward", label: Text("Go forward"), enabled: model.controls.canGoForward) { handlers.navigate(.forward) }
                reload
            }
            field
            if isEditing {
                Button(action: handlers.cancelEditing) {
                    Text("Cancel")
                        .font(.system(size: metrics.addressFontSize))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, metrics.length(6))
                        .frame(maxHeight: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.95))
                .transition(.opacity)
            }
        }
        .padding(.horizontal, metrics.length(6))
        .padding(.vertical, metrics.length(5))
        .animation(.easeInOut(duration: 0.2), value: isEditing)
    }

    private func navButton(_ systemImage: String, label: Text, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: { if enabled { action() } }) {
            Image(systemName: systemImage)
                .font(.system(size: metrics.length(15), weight: .medium))
                .foregroundStyle(Palette.primaryText)
                .opacity(enabled ? 1 : 0.3)
                .frame(width: metrics.length(32), height: metrics.length(30))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.85))
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityHint(readOnlyHint(model))
    }

    /// ↻, or a spinner in its place while a bar action runs (the same frame).
    private var reload: some View {
        ZStack {
            if model.busy {
                ProgressView()
                    .controlSize(metrics.length(1) > 1.15 ? .regular : .small)
                    .transition(.opacity)
                    .accessibilityHidden(true)
            } else {
                navButton("arrow.clockwise", label: Text("Reload"), enabled: model.controls.canReload) { handlers.navigate(.reload) }
                    .transition(.opacity)
            }
        }
        .frame(width: metrics.length(32), height: metrics.length(30))
        .animation(.easeInOut(duration: 0.2), value: model.busy)
    }

    /// The rounded field, always left-to-right (recheck point 4). Idle: the shown host (its end
    /// kept: a long host loses its left labels, never the registrable domain) or the placeholder;
    /// a tap after Take over begins editing with the full URL selected.
    private var field: some View {
        let shape = RoundedRectangle(cornerRadius: metrics.length(10), style: .continuous)
        return ZStack(alignment: .leading) {
            if isEditing {
                AddressTextField(
                    editing: $editing,
                    fontSize: metrics.addressFontSize,
                    onSubmit: handlers.submit,
                    onEndEditing: handlers.cancelEditing
                )
                .padding(.leading, metrics.length(12))
                .padding(.trailing, metrics.length(4))
            } else {
                idleText
                    .font(.system(size: metrics.addressFontSize))
                    .lineLimit(1)
                    .padding(.horizontal, metrics.length(12))
                    .frame(maxWidth: .infinity, alignment: model.layout == .tabs ? .leading : .center)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(shape.fill(BrowserBarPalette.field))
        .overlay(shape.strokeBorder(BrowserBarPalette.fieldBorder, lineWidth: 1))
        .contentShape(shape)
        .onTapGesture {
            guard model.controls.canEdit, !isEditing else { return }
            handlers.beginEditing()
        }
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityElement(children: isEditing ? .contain : .ignore)
        .accessibilityLabel(Text("Address"))
        .accessibilityValue(isEditing ? Text(verbatim: "") : Text(verbatim: model.host))
        .accessibilityAddTraits(model.controls.canEdit && !isEditing ? [.isButton] : [])
        .accessibilityHint(readOnlyHint(model))
    }

    /// Plain text only (Text(verbatim:)); the placeholder is UI copy.
    @ViewBuilder private var idleText: some View {
        if !model.host.isEmpty {
            Text(verbatim: model.host)
                .truncationMode(.head)
                .foregroundStyle(Palette.primaryText)
        } else if model.showsPlaceholder {
            Text("Search or type a web address")
                .truncationMode(.tail)
                .foregroundStyle(Palette.secondaryText)
        } else if model.presence == .skeleton {
            // the redacted skeleton's grey bar
            Text(verbatim: "example.com")
                .foregroundStyle(Palette.secondaryText)
        } else {
            Text(verbatim: "")
        }
    }
}

// MARK: - The address text field

/// A UITextField for what SwiftUI's TextField can't set: the web-search keyboard with Go, no
/// smart quotes, dashes or insert-delete, the whole text selected when editing begins, and the
/// caret at the end when a refused address comes back. The draft lives in `editing` (never stored).
private struct AddressTextField: UIViewRepresentable {
    @Binding var editing: BrowserAddressEditing
    var fontSize: CGFloat
    var onSubmit: () -> Void
    /// the keyboard went away by itself while the field is still on screen
    var onEndEditing: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.keyboardType = .webSearch
        field.returnKeyType = .go
        field.textContentType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.clearButtonMode = .whileEditing
        field.enablesReturnKeyAutomatically = true
        field.borderStyle = .none
        field.backgroundColor = .clear
        field.textColor = UIColor(Palette.primaryText)
        field.tintColor = UIColor(Palette.primaryText)
        field.semanticContentAttribute = .forceLeftToRight
        field.textAlignment = .left
        field.accessibilityLabel = String(localized: "Address")
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        if field.font?.pointSize != fontSize { field.font = .systemFont(ofSize: fontSize) }
        if field.text != editing.draft { field.text = editing.draft }
        // a new editing session (a tap, +, a refused address): focus, then select or go to the end
        guard context.coordinator.session != editing.session else { return }
        context.coordinator.session = editing.session
        let selectAll = editing.selectAll
        Task { @MainActor in
            guard field.window != nil else { return }
            if !field.isFirstResponder { field.becomeFirstResponder() }
            if selectAll {
                field.selectAll(nil)
            } else {
                let end = field.endOfDocument
                field.selectedTextRange = field.textRange(from: end, to: end)
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextField, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 200, height: proposal.height ?? uiView.intrinsicContentSize.height)
    }

    @MainActor
    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: AddressTextField
        var session = -1

        init(_ parent: AddressTextField) { self.parent = parent }

        @objc func changed(_ field: UITextField) {
            parent.editing.draft = field.text ?? ""
        }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            parent.editing.draft = field.text ?? ""
            parent.onSubmit()
            return false
        }

        /// The keyboard was dismissed some other way (the field stays): back to the shown host.
        /// Not when the field is leaving the screen (Go, Cancel, the layout turning): the next run
        /// of the loop finds it without a window, and the editing state carries over.
        func textFieldDidEndEditing(_ field: UITextField) {
            Task { @MainActor [weak field] in
                guard let field, field.window != nil, !field.isFirstResponder else { return }
                self.parent.onEndEditing()
            }
        }
    }
}

// MARK: - The refusal line

/// One line under the bar (like InlineFailure): the warning glyph and the reason; a tap clears it,
/// the next action does too. The reason is the app's own text, never the server's.
struct BrowserBarRefusalLine: View {
    var refusal: BrowserBarRules.Refusal
    var metrics: BrowserBarMetrics
    var onDismiss: () -> Void

    var body: some View {
        Button(action: onDismiss) {
            HStack(alignment: .center, spacing: metrics.length(6)) {
                DuetIcon(glyph: .warning, size: metrics.length(15), tint: Palette.failure)
                Text(verbatim: refusal.message)
                    .font(.system(size: metrics.length(14)))
                    .foregroundStyle(Palette.primaryText)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, metrics.length(12))
            .padding(.vertical, metrics.length(8))
            .background(Capsule().fill(BrowserBarPalette.surface))
            .overlay(Capsule().strokeBorder(BrowserBarPalette.fieldBorder, lineWidth: 1))
            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.97))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityHint(Text("Double-tap to dismiss."))
    }
}
