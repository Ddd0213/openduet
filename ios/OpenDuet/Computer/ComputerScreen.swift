// The full-screen "OpenDuet's computer" view (prompt L143): the mascot and status pill at the
// top, M27's tab strip and address bar, the live screen right under it (fitted to the width,
// pinch to zoom) and the black full-width "Take over" capsule at the bottom. After Take over,
// taps, drags, scrolls and typing (the keyboard button) go to the browser and the button becomes
// "Hand back to OpenDuet". ✕ or a swipe down closes it, following the finger; both call `onClose`,
// which every presenter routes to the store's closeComputer() (M20: hands back to the assistant when the
// user was in control). Opening it wakes a sleeping browser (the live stream starts it). M20
// (L138): "Let it sleep" in the top bar closes the browser now; the view then shows it asleep and
// lets the stream go until a tap on it wakes the browser again.
// M27 W6: the full-screen button, or the phone turned sideways, is the landscape full screen
// (ComputerFullScreen): a real interface rotation (OrientationLock), with the same typing,
// address editing and resting state carried across the turn.
import SwiftUI

struct ComputerScreen: View {
    var view: ComputerViewState
    var status: StatusKey?
    var actions: ComputerActions
    var onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var drag: CGFloat = 0
    @State private var typing = false
    @State private var toggles = 0
    /// M20: "Let it sleep" answered with the browser off; the view shows it asleep (and asks for
    /// no stream, which would wake it) until a tap or the assistant wakes it.
    @State private var resting = false
    /// M27 W6: the address field's editing, kept here so it lasts while the layout turns
    @State private var address = BrowserAddressEditing()

    private var progress: Double { min(Double(drag) / 420, 1) }
    /// iPhone only (TARGETED_DEVICE_FAMILY 1): a compact height is the interface turned sideways
    private var landscape: Bool { verticalSizeClass == .compact }
    /// xSmall … accessibility5 (Large = 3); BrowserBarMetrics caps it at accessibility1
    private var typeSizeIndex: Int { DynamicTypeSize.allCases.firstIndex(of: dynamicTypeSize) ?? 3 }
    private var canType: Bool { view.isUserInControl && ComputerDeployRules.body(view) == .screen && !resting }
    private var bar: BrowserBarRules.Model { BrowserBarRules.model(view, resting: resting) }

    var body: some View {
        let model = bar
        ZStack {
            Palette.background
                .opacity(1 - progress * 0.7)
                .ignoresSafeArea()
                .gesture(dismissDrag, including: landscape ? .none : .all)
            if landscape {
                ComputerFullScreen(
                    view: view, actions: actions, resting: resting, bar: model, typeSizeIndex: typeSizeIndex,
                    address: $address, handlers: handlers(model), canType: canType, typing: typing,
                    onExit: { exitFullScreen() }, onKeyboard: { toggleKeyboard() },
                    onTake: { take() }, onRelease: { release() }, onWake: { wake() },
                    onEndTyping: { typing = false }
                )
            } else {
                upright(model)
                    .offset(y: drag)
            }
        }
        // Landscape: the system keyboard covers the block's lower part (ComputerFullScreen reads
        // its frame); upright keeps the usual keyboard avoidance.
        .ignoresSafeArea(.keyboard, edges: landscape ? .bottom : [])
        .presentationBackground(.clear)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.4, dampingFraction: 0.86), value: typing && canType)
        .animation(.easeInOut(duration: 0.3), value: resting)
        .animation(.easeInOut(duration: 0.25), value: model.presence == .hidden)
        .sensoryFeedback(.impact(weight: .medium), trigger: toggles)
        .sensoryFeedback(trigger: view.control) { old, new in
            switch (old, new) {
            case (.taking, .idle), (.releasing, .idle), (.sleeping, .idle): .success
            case (_, .failed): .warning
            default: nil
            }
        }
        .onChange(of: view.control) { old, new in
            if ComputerDeployRules.startsResting(from: old, to: new, browser: view.computer?.browser) { resting = true }
        }
        .onChange(of: view.computer?.browser) { _, browser in
            if ComputerDeployRules.endsResting(browser: browser) { resting = false }
        }
        .onChange(of: canType) { _, can in if !can { typing = false } }
        .onChange(of: model.controls.canEdit) { _, can in if !can { address.cancel() } }
        // + answered: the field takes focus with the new tab's address selected
        .onChange(of: view.newTabs) { _, _ in
            guard bar.controls.canEdit else { return }
            typing = false
            address.begin(text: bar.editText)
        }
        // A refused address comes back to the field (caret at the end); any other answer to Go
        // forgets it.
        .onChange(of: view.barRefusals) { _, _ in
            if view.barRefusal?.keepsAddress == true, bar.controls.canEdit {
                typing = false
                address.refused()
            } else {
                address.answered()
            }
        }
        .onChange(of: landscape) { _, _ in drag = 0 }
        .onAppear {
            OrientationLock.allowLandscape = true
            actions.loadBar()
        }
        .onDisappear { OrientationLock.allowLandscape = false }
        .accessibilityAction(.escape) {
            if landscape { exitFullScreen() } else { onClose() }
        }
    }

    // MARK: - Upright

    private func upright(_ model: BrowserBarRules.Model) -> some View {
        let content = ComputerDeployRules.body(view)
        let metrics = BrowserBarMetrics(typeSizeIndex: typeSizeIndex)
        let showsBar = model.presence != .hidden
        return VStack(spacing: 12) {
            ComputerTopBar(
                pill: ComputerDeployRules.pill(view, status: status, resting: resting),
                compact: false, showsKeyboard: canType, typing: typing,
                sleep: ComputerDeployRules.sleepButton(view, status: status),
                onClose: onClose, onKeyboard: { toggleKeyboard() }, onSleep: actions.sleep,
                showsFullScreen: content == .screen && !resting,
                onFullScreen: { enterFullScreen() }
            )
            .contentShape(Rectangle())
            .gesture(dismissDrag)
            // The bar and the frame touch, so they read as one browser window.
            VStack(spacing: 0) {
                if showsBar {
                    BrowserBarView(model: model, metrics: metrics, editing: $address, handlers: handlers(model))
                        .transition(.opacity)
                }
                ComputerCanvas(
                    view: view, screen: actions.screen, resting: resting,
                    onInput: actions.input, onReload: actions.reload, onWake: { wake() },
                    onDismissDrag: canvasDrag, joinedTop: showsBar
                )
                .overlay { editingCatcher(model) }
                .overlay(alignment: .top) { refusalLine(metrics: metrics, shows: showsBar) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            if typing && canType {
                ComputerKeyboardBar(onInput: actions.input) { typing = false }
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
            ComputerControlBar(view: view, resting: resting, onTake: { take() }, onRelease: { release() })
        }
        .padding(.horizontal, FullScreenRules.uprightPadding)
        .padding(.top, 8)
        .padding(.bottom, 12)
    }

    /// While the address field edits, a tap on the page ends editing (the page gets nothing).
    @ViewBuilder private func editingCatcher(_ model: BrowserBarRules.Model) -> some View {
        if address.isEditing && model.controls.canEdit {
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { address.cancel() }
                .accessibilityHidden(true)
        }
    }

    /// The last refusal, one tappable line at the frame's top right under the bar.
    @ViewBuilder private func refusalLine(metrics: BrowserBarMetrics, shows: Bool) -> some View {
        if shows, let refusal = view.barRefusal {
            BrowserBarRefusalLine(refusal: refusal, metrics: metrics, onDismiss: actions.dismissBarRefusal)
                .padding(.top, 8)
                .padding(.horizontal, 12)
                .transition(.opacity)
        }
    }

    // MARK: - The bar's actions

    /// Every action ends the field's editing first (a tab switch, ✕, + or ← → ↻), so a draft
    /// never outlives the tab it was typed for.
    private func handlers(_ model: BrowserBarRules.Model) -> BrowserBarHandlers {
        BrowserBarHandlers(
            activate: { id in send(.activate(tabId: id)) },
            close: { id in send(.close(tabId: id)) },
            newTab: { send(.newTab(address: nil)) },
            navigate: { action in send(.navigate(.action(action))) },
            beginEditing: {
                guard model.controls.canEdit else { return }
                // the field and the remote keyboard never show together
                typing = false
                address.begin(text: model.editText)
            },
            submit: { submit() },
            cancelEditing: { address.cancel() }
        )
    }

    private func send(_ action: BrowserBarAction) {
        if address.isEditing { address.cancel() }
        actions.browserBar(action)
    }

    /// Go: what was typed, trimmed, as it is (the server resolves it); empty = no request.
    private func submit() {
        guard let text = address.submit(),
              let action = BrowserBarAction.submit(text, hasTab: view.bar.activeTab != nil) else { return }
        actions.browserBar(action)
    }

    /// The keyboard button; it ends the address field's editing.
    private func toggleKeyboard() {
        typing.toggle()
        if typing { address.cancel() }
    }

    // MARK: - Control and full screen

    private func take() {
        toggles += 1
        actions.take()
    }

    private func release() {
        toggles += 1
        typing = false
        address.cancel()
        actions.release()
    }

    private func wake() {
        resting = false
        actions.wake()
    }

    /// The full-screen button: the interface turns to landscape (OrientationLock).
    private func enterFullScreen() {
        OrientationLock.enterFullScreen()
    }

    /// ✕ in landscape and the escape gesture there: back upright (the assistant's computer stays open).
    private func exitFullScreen() {
        OrientationLock.exitFullScreen()
    }

    // MARK: - Swipe down to close (upright only)

    /// Reduce Motion: the view holds still under the finger and a long enough swipe still closes it.
    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .onChanged { value in drag = reduceMotion ? 0 : max(value.translation.height, 0) }
            .onEnded { value in finish(translation: value.translation.height, predicted: value.predictedEndTranslation.height) }
    }

    /// The live screen reports its own one-finger drag while the assistant drives (zoomed out).
    private func canvasDrag(_ translation: CGFloat, ended: Bool, predicted: CGFloat) {
        guard !landscape else { return }
        if ended { finish(translation: translation, predicted: predicted) } else { drag = reduceMotion ? 0 : translation }
    }

    private func finish(translation: CGFloat, predicted: CGFloat) {
        if !landscape, translation > 140 || predicted > 420 {
            onClose()
        } else {
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.85)) { drag = 0 }
        }
    }
}
