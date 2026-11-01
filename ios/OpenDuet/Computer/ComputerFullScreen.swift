// M27 W6: "OpenDuet's computer" turned to landscape (the full-screen button, or the phone turned
// sideways): the tab strip, the address row and the live frame as one block, the upright block
// scaled to the safe area's height and centred (FullScreenRules); ✕ in the left margin, the
// Keyboard and Take over / Hand back column in the right one. The bar is laid out at the scale
// (fonts, heights, paddings), never scaleEffect, so text stays sharp and hit areas stay right.
// The system keyboard covers the page's lower part (the address field) or, for the remote
// keyboard, the bar steps aside and the frame fits above a one-row ComputerKeyboardBar. No swipe
// down here; the escape gesture leaves full screen (ComputerScreen).
import SwiftUI
import UIKit

struct ComputerFullScreen: View {
    var view: ComputerViewState
    var actions: ComputerActions
    var resting: Bool
    var bar: BrowserBarRules.Model
    var typeSizeIndex: Int
    @Binding var address: BrowserAddressEditing
    var handlers: BrowserBarHandlers
    var canType: Bool
    var typing: Bool
    var onExit: () -> Void
    var onKeyboard: () -> Void
    var onTake: () -> Void
    var onRelease: () -> Void
    var onWake: () -> Void
    var onEndTyping: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// the system keyboard's top in global coordinates (nil = not shown)
    @State private var keyboardTop: CGFloat?

    var body: some View {
        GeometryReader { proxy in
            let container = proxy.frame(in: .global)
            let layout = FullScreenRules.layout(input(container, window: windowSize(proxy)))
            let metrics = BrowserBarMetrics(typeSizeIndex: typeSizeIndex, scale: layout.scale)
            ZStack(alignment: .topLeading) {
                if bar.presence != .hidden, layout.bar.height > 0 {
                    BrowserBarView(model: bar, metrics: metrics, editing: $address, handlers: handlers)
                        .frame(width: layout.bar.width, height: layout.bar.height, alignment: .top)
                        .offset(x: layout.bar.minX, y: layout.bar.minY)
                        .accessibilitySortPriority(3)
                        .transition(.opacity)
                }
                canvas(layout: layout, metrics: metrics)
                    .accessibilitySortPriority(2)
                if typing && canType {
                    keyboardRow(layout, container: container.size)
                        .transition(.opacity)
                }
                exitButton
                    .position(x: layout.leftMargin.midX, y: layout.controlsY)
                    .accessibilitySortPriority(4)
                ComputerControlColumn(
                    view: view, resting: resting, canType: canType, typing: typing, captions: layout.captions,
                    onKeyboard: onKeyboard, onTake: onTake, onRelease: onRelease
                )
                .frame(width: layout.rightMargin.width)
                .position(x: layout.rightMargin.midX, y: layout.controlsY)
                .accessibilitySortPriority(1)
            }
            .frame(width: container.width, height: container.height, alignment: .topLeading)
            .accessibilityElement(children: .contain)
        }
        .ignoresSafeArea(.keyboard)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .easeOut(duration: 0.25), value: keyboardTop)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            // Screen coordinates (the cover fills the screen). A keyboard leaving ends below the
            // container, which `input` clamps to the full height; keyboardWillHide then clears it.
            keyboardTop = end.height > 0 ? end.minY : nil
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardTop = nil
        }
    }

    /// The upright content width: the window's short side less the upright padding.
    private func input(_ container: CGRect, window: CGSize) -> FullScreenRules.Input {
        let upright = max(min(window.width, window.height) - 2 * FullScreenRules.uprightPadding, 1)
        let barHeight = bar.presence == .hidden ? 0 : BrowserBarMetrics(typeSizeIndex: typeSizeIndex).height(bar.layout)
        // a keyboard top below the container (a hardware keyboard's thin bar) still counts
        let visible = keyboardTop.map { min($0 - container.minY, container.height) }
        // the remote keyboard before the system one shows (or with a hardware keyboard): its row
        // sits at the bottom
        let remote = typing && canType
        return FullScreenRules.Input(
            container: container.size, uprightWidth: upright, barHeight: barHeight,
            frame: frameSize, visibleHeight: visible ?? (remote ? container.height : nil), remoteTyping: remote
        )
    }

    /// The cover fills the window: the safe area plus its insets (no UIScreen).
    private func windowSize(_ proxy: GeometryProxy) -> CGSize {
        let insets = proxy.safeAreaInsets
        return CGSize(width: proxy.size.width + insets.leading + insets.trailing, height: proxy.size.height + insets.top + insets.bottom)
    }

    /// frame_meta's size once known (any unit; zero = 16:10).
    private var frameSize: CGSize {
        CGSize(width: CGFloat(actions.screen?.pixelWidth ?? 0), height: CGFloat(actions.screen?.pixelHeight ?? 0))
    }

    // MARK: - The frame

    /// The live screen in the block's frame rect (its input fractions are of that rect, whatever
    /// the scale), with the refusal chip at its top and, while the address field edits, a clear
    /// layer that ends editing on a tap (the page itself gets nothing then).
    private func canvas(layout: FullScreenRules.Layout, metrics: BrowserBarMetrics) -> some View {
        ComputerCanvas(
            view: view, screen: actions.screen, resting: resting,
            onInput: actions.input, onReload: actions.reload, onWake: onWake,
            onDismissDrag: { _, _, _ in },
            joinedTop: layout.bar.height > 0, dismissible: false
        )
        .frame(width: layout.frame.width, height: layout.frame.height, alignment: .top)
        .overlay {
            if address.isEditing && bar.controls.canEdit {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture(perform: handlers.cancelEditing)
                    .accessibilityHidden(true)
            }
        }
        .overlay(alignment: .top) {
            if let refusal = view.barRefusal, layout.bar.height > 0 {
                BrowserBarRefusalLine(refusal: refusal, metrics: metrics, onDismiss: actions.dismissBarRefusal)
                    .padding(.top, metrics.length(8))
                    .padding(.horizontal, metrics.length(12))
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: view.barRefusal)
        .offset(x: layout.frame.minX, y: layout.frame.minY)
    }

    // MARK: - The remote keyboard and ✕

    /// One row across the block above the system keyboard (FullScreenRules.Layout.keyboardRow);
    /// until the keyboard's frame is known, at the container's bottom.
    private func keyboardRow(_ layout: FullScreenRules.Layout, container: CGSize) -> some View {
        let row = layout.keyboardRow ?? CGRect(
            x: layout.block.minX, y: max(container.height - FullScreenRules.keyboardRow, 0),
            width: layout.block.width, height: FullScreenRules.keyboardRow
        )
        return ComputerKeyboardBar(onInput: actions.input, compact: true, onDone: onEndTyping)
            .frame(width: max(row.width, 1), height: row.height)
            .offset(x: row.minX, y: row.minY)
            .accessibilitySortPriority(2)
    }

    /// ✕ in the left margin: back to the upright view (it doesn't close "OpenDuet's computer").
    private var exitButton: some View {
        FileChromeButton(systemImage: DuetGlyph.close.symbol, label: Text("Exit full screen"), action: onExit)
    }
}
