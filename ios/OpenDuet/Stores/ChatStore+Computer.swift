// M6 (iOS 1, owned by the iOS-1 agent): the assistant's computer on the store side (L141-L144).
// ChatStore calls `routeComputer` for every event, `teardownComputer` on sign-out, and
// `openComputer` / `openFile` for duet://computer, duet://files/<id> and the Open browser alert.
// Rendered state lives in `computerBoard` (observed); the stream socket, the tasks and the live
// frames (LiveScreen) live in `computerRuntime` (not observed). Files are in ComputerFiles.swift.
import Foundation

/// What the shell renders for M6 iOS 1 (ShellState.computer / .files).
struct ComputerBoard {
    var view = ComputerViewState()
    var files = FilesState()
}

/// Requests, the stream socket and the live frames (ignored by observation).
@MainActor
final class ComputerRuntime {
    let screen = LiveScreen()
    var stream: ComputerStream?
    var loadTask: Task<Void, Never>?
    /// closes the socket a moment after the last live view left (scrolling past a card)
    var stopTask: Task<Void, Never>?
    /// opens the full-screen view once a covering sheet has gone
    var openTask: Task<Void, Never>?
    var previewTask: Task<Void, Never>?
    /// the temporary copy of the file on preview (removed when it closes)
    var previewDirectory: URL?
    var listTasks: [String: Task<Void, Never>] = [:]
    /// M20: after "Let it sleep" the open stream would wake the browser again (agent-computer's
    /// /stream opens a page); neither state updates nor a live view attaching (SwiftUI can attach
    /// one again while the full-screen view flips to asleep) restart it while the browser is off.
    /// Only a deliberate wake ends it: opening the full-screen view, the tap on the asleep view
    /// (`wakeComputer()`), or the browser coming up on its own (the assistant used it).
    var holdStreamWhileAsleep = false
    /// M27 W6: GET /api/computer/tabs in flight (one at a time)
    var barLoadTask: Task<Void, Never>?
    /// M27 W6: the bar action in flight; the queue holds it and the ones waiting behind it
    var barActionTask: Task<Void, Never>?
    var barQueue = BrowserBarQueue()
    /// M27 W6: drops a GET answer that arrives after a stream message or a POST answer
    var barFeed = BrowserBarFeed()

    func cancelAll() {
        stream?.stop()
        stream = nil
        for task in [loadTask, stopTask, openTask, previewTask, barLoadTask, barActionTask] { task?.cancel() }
        listTasks.values.forEach { $0.cancel() }
        listTasks = [:]
        loadTask = nil
        stopTask = nil
        openTask = nil
        previewTask = nil
        barLoadTask = nil
        barActionTask = nil
        barQueue = BrowserBarQueue()
        barFeed = BrowserBarFeed()
    }
}

extension ChatStore {
    static let computerControlRequest = "computer:control"

    var computerActions: ComputerActions {
        let screen = computerRuntime.screen
        if screen.onDemand == nil {
            screen.onDemand = { [weak self] wanted in self?.computerDemand(wanted) }
        }
        var actions = ComputerActions()
        actions.open = { [weak self] in self?.openComputer() }
        actions.close = { [weak self] in self?.closeComputer() }
        actions.take = { [weak self] in self?.changeControl(take: true) }
        actions.release = { [weak self] in self?.changeControl(take: false) }
        actions.reload = { [weak self] in self?.loadComputer() }
        actions.input = { [weak self] message in self?.sendComputerInput(message) }
        actions.sendSignIn = { [weak self] messageId, requestId, email, password in
            self?.sendSignIn(messageId: messageId, requestId: requestId, email: email, password: password)
        }
        actions.sendSignInCode = { [weak self] _, requestId, code in self?.sendSignInCode(requestId: requestId, code: code) }
        actions.takeOverSignIn = { [weak self] _, requestId in self?.answerSignIn(requestId: requestId, takeOver: true) }
        actions.dismissSignIn = { [weak self] _, requestId in self?.answerSignIn(requestId: requestId, takeOver: false) }
        actions.sleep = { [weak self] in self?.sleepComputer() }
        actions.wake = { [weak self] in self?.wakeComputer() }
        actions.screen = screen
        actions.loadBar = { [weak self] in self?.loadBrowserBar() }
        actions.browserBar = { [weak self] action in self?.runBrowserBar(action) }
        actions.dismissBarRefusal = { [weak self] in self?.computerBoard.view.barRefusal = nil }
        return actions
    }

    func routeComputer(_ event: DuetEvent) {
        switch event.body {
        case .computer(let state):
            applyComputer(state)
        case .message(let message):
            noteFileMessage(message)
        default:
            break
        }
    }

    func teardownComputer() {
        computerRuntime.cancelAll()
        computerRuntime.screen.reset()
        computerBoard = ComputerBoard()
        ComputerFiles.removeAll()
    }

    // MARK: - The full-screen view

    /// Live browser card, Open browser alert, duet://computer, "OpenDuet's browser" resource. A
    /// sheet in the way (a link tapped inside one) closes first, so the view presents from the
    /// shell's root.
    func openComputer() {
        guard !tornDown else { return }
        // Opening the full-screen view is asking to see the browser: it wakes a sleeping one.
        computerRuntime.holdStreamWhileAsleep = ComputerDeployRules.holdsStream(computerRuntime.holdStreamWhileAsleep, after: .openedFullScreen)
        computerRuntime.openTask?.cancel()
        loadComputer()
        // M27 W6: the bar shows before the stream is up.
        loadBrowserBar()
        let files = computerBoard.files
        let covered = account.presented != nil || account.connectorDetail != nil || files.channelSheet != nil || files.preview != nil
        guard covered else {
            computerBoard.view.isOpen = true
            return
        }
        if account.connectorDetail != nil { closeConnectorDetail() }
        dismissSheet()
        computerBoard.files.channelSheet = nil
        closeFilePreview()
        computerRuntime.openTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard let self, !Task.isCancelled, !self.tornDown else { return }
            self.computerBoard.view.isOpen = true
        }
    }

    /// ✕ or swipe down. M20 (user 2026-10-28): closing the view while the user is in control
    /// hands back to the assistant without asking; nobody can drive a browser they aren't looking at.
    /// Leaving the app (to fetch a code from Messages) doesn't come through here and keeps
    /// control; the server hands back on its own after a long while without input.
    func closeComputer() {
        computerRuntime.openTask?.cancel()
        computerBoard.view.isOpen = false
        if case .failed = computerBoard.view.control { computerBoard.view.control = .idle }
        if computerBoard.view.isUserInControl, !computerBoard.view.isBusy { changeControl(take: false) }
    }

    /// GET /api/computer; once loaded, a failed refresh keeps what is shown.
    func loadComputer() {
        guard !tornDown else { return }
        if computerBoard.view.computer == nil { computerBoard.view.phase = .loading }
        computerRuntime.loadTask?.cancel()
        computerRuntime.loadTask = Task { [client] in
            let result = await Self.result { try await client.computer() }
            guard !Task.isCancelled, !tornDown else { return }
            switch result {
            case .success(let state):
                markOnline()
                applyComputer(state)
            case .failure(let error):
                noteFailure(error)
                if computerBoard.view.computer == nil {
                    computerBoard.view.phase = .failed(reason: TaskBoard.reason(for: error))
                }
            }
        }
    }

    /// A ComputerState from GET, an event, the stream or take / release.
    func applyComputer(_ state: ComputerState) {
        let wasInControl = computerBoard.view.isUserInControl
        computerBoard.view.apply(state)
        if wasInControl, !computerBoard.view.isUserInControl { endBarDriving() }
        computerRuntime.holdStreamWhileAsleep = ComputerDeployRules.holdsStream(computerRuntime.holdStreamWhileAsleep, after: .state(state.browser))
        if !state.available {
            stopComputerStream()
        } else if computerRuntime.screen.hasViewers, !computerRuntime.holdStreamWhileAsleep {
            startComputerStream()
        }
    }

    // MARK: - Take over / Hand back

    /// POST /api/computer/take or /release; spinner in the button meanwhile, the reason inline
    /// above it on failure (the haptics follow these states in the view).
    func changeControl(take: Bool) {
        guard !tornDown, !computerBoard.view.isBusy else { return }
        computerBoard.view.control = take ? .taking : .releasing
        if !take { endBarDriving() }
        runTap(Self.computerControlRequest, { [client] in
            if take { return try await client.takeComputer() }
            return try await client.releaseComputer()
        }) { store, result in
            switch result {
            case .success(let state):
                store.computerBoard.view.control = .idle
                store.applyComputer(state)
            case .failure(let error) where error is CancellationError:
                store.computerBoard.view.control = .idle
            case .failure(let error):
                store.computerBoard.view.control = .failed(reason: TaskBoard.reason(for: error))
            }
        }
    }

    /// M20: "Let it sleep": POST /api/computer/sleep; spinner meanwhile, the reason inline on
    /// failure (409 computer_busy while the assistant is using it or the user is in control).
    func sleepComputer() {
        guard !tornDown, !computerBoard.view.isBusy else { return }
        computerBoard.view.control = .sleeping
        // The live stream keeps a page open; close it first so it can't wake the browser again.
        computerRuntime.stopTask?.cancel()
        computerRuntime.stopTask = nil
        stopComputerStream()
        runTap(Self.computerControlRequest, { [client] in try await client.sleepComputer() }) { store, result in
            switch result {
            case .success(let state):
                store.computerBoard.view.control = .idle
                store.computerRuntime.holdStreamWhileAsleep = state.browser == .off
                store.applyComputer(state)
            case .failure(let error) where error is CancellationError:
                store.computerBoard.view.control = .idle
                store.resumeStreamIfWatched()
            case .failure(let error):
                store.computerBoard.view.control = .failed(reason: TaskBoard.reason(for: error))
                store.resumeStreamIfWatched()
            }
        }
    }

    /// M20: the tap on the asleep view: the hold ends and the watching views get the stream
    /// back, which wakes the browser ("Waking OpenDuet's workspace" until it's up).
    func wakeComputer() {
        guard !tornDown else { return }
        computerRuntime.holdStreamWhileAsleep = ComputerDeployRules.holdsStream(computerRuntime.holdStreamWhileAsleep, after: .tappedWake)
        resumeStreamIfWatched()
    }

    /// A tap, drag, scroll, text or key for the browser, only while the user is in control.
    func sendComputerInput(_ message: ComputerClientMessage) {
        guard !tornDown, computerBoard.view.isUserInControl else { return }
        computerRuntime.stream?.send(message)
    }

    // MARK: - Sign-in card

    /// "Send to OpenDuet's browser" (cardRequests[RequestKey.signIn(requestId)]). The password
    /// only lives in the request's closure until it returns; nothing stores or logs it.
    func sendSignIn(messageId: String, requestId: String, email: String, password: String) {
        let key = ShellState.RequestKey.signIn(requestId)
        guard !tornDown, account.begin(key) else { return }
        computerBoard.view.signIns[requestId] = nil
        computerBoard.view.signInAnswers[requestId] = nil
        runTap(key, { [client] in
            try await client.sendSignIn(requestId: requestId, email: email, password: password)
        }) { store, result in
            if case .failure(let error) = result, let api = error as? APIError, api == .expired || api == .notFound {
                // The pending secret is gone on the computer: the card shows Expired.
                store.account.clear(key)
                store.computerBoard.view.signIns[requestId] = .expired
                return
            }
            guard let response = store.account.answer(key, result) else { return }
            store.noteSignIn(response)
        }
    }

    /// M20: the verification code the site asked for after the password (same request key as
    /// the first send). The code only lives in the request's closure until it returns.
    func sendSignInCode(requestId: String, code: String) {
        let key = ShellState.RequestKey.signIn(requestId)
        guard !tornDown, account.begin(key) else { return }
        runTap(key, { [client] in
            try await client.sendSignInCode(requestId: requestId, code: code)
        }) { store, result in
            if case .failure(let error) = result, let api = error as? APIError, api == .expired || api == .notFound {
                store.account.clear(key)
                store.computerBoard.view.signIns[requestId] = .expired
                return
            }
            guard let response = store.account.answer(key, result) else { return }
            store.noteSignIn(response)
        }
    }

    /// M20: "Take control instead" (the user gets the browser and the full-screen view opens) or
    /// "Not now". Both close the card.
    func answerSignIn(requestId: String, takeOver: Bool) {
        let key = ShellState.RequestKey.signIn(requestId)
        guard !tornDown, account.begin(key) else { return }
        runTap(key, { [client] in
            takeOver ? try await client.takeOverSignIn(requestId: requestId) : try await client.dismissSignIn(requestId: requestId)
        }) { store, result in
            if case .failure(let error) = result, let api = error as? APIError, api == .expired || api == .notFound {
                store.account.clear(key)
                store.computerBoard.view.signIns[requestId] = .expired
                return
            }
            guard let response = store.account.answer(key, result) else { return }
            store.noteSignIn(response)
            if let computer = response.computer { store.applyComputer(computer) }
            if takeOver, response.outcome == .takenOver { store.openComputer() }
        }
    }

    /// Every sign-in answer: its state for SignInCardPhase, the whole answer for the card's step,
    /// reason and outcome.
    private func noteSignIn(_ response: SignInCardResponse) {
        computerBoard.view.signIns[response.requestId] = response.state
        computerBoard.view.signInAnswers[response.requestId] = response
    }

    // MARK: - The live stream

    /// The first live view appeared (true) or the last one left (false, closed after 2 s).
    func computerDemand(_ wanted: Bool) {
        guard !tornDown else { return }
        let runtime = computerRuntime
        runtime.stopTask?.cancel()
        runtime.stopTask = nil
        if wanted {
            if computerBoard.view.computer == nil { loadComputer() }
            // Asleep after "Let it sleep": a view attaching doesn't wake it (wakeComputer does).
            runtime.holdStreamWhileAsleep = ComputerDeployRules.holdsStream(runtime.holdStreamWhileAsleep, after: .viewAttached)
            if computerBoard.view.computer?.available != false, !runtime.holdStreamWhileAsleep { startComputerStream() }
        } else {
            runtime.stopTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { return }
                self.stopComputerStream()
            }
        }
    }

    func startComputerStream() {
        let runtime = computerRuntime
        if runtime.stream == nil {
            guard let request = client.computerStreamRequest() else { return }
            runtime.stream = ComputerStream(request: request) { [weak self] signal in
                self?.handleComputerSignal(signal)
            }
        }
        guard let stream = runtime.stream, !stream.isRunning else { return }
        runtime.screen.setConnection(.connecting)
        stream.start()
    }

    func stopComputerStream() {
        computerRuntime.stream?.stop()
        computerRuntime.stream = nil
        computerRuntime.screen.setConnection(.idle)
    }

    /// A failed or cancelled "Let it sleep": the live views that were watching get their stream back.
    private func resumeStreamIfWatched() {
        guard computerRuntime.screen.hasViewers, computerBoard.view.computer?.available != false else { return }
        startComputerStream()
    }

    private func handleComputerSignal(_ signal: ComputerStream.Signal) {
        guard !tornDown else { return }
        let screen = computerRuntime.screen
        switch signal {
        case .open:
            screen.setConnection(.live)
            // M27 W6: a new connection (the first, or after a drop): read the bar once.
            loadBrowserBar()
        case .frame(let jpeg):
            screen.show(jpeg)
        case .message(.state(let state)):
            applyComputer(state)
        case .message(.frameMeta(let width, let height)):
            screen.setSize(width: width, height: height)
        case .message(.browserBar(let bar)):
            // M27 W6: newer than any GET still on its way. A message that didn't decode never
            // gets here (ComputerStream drops it), so the last good bar stays.
            computerRuntime.barFeed.noteNewer()
            applyBrowserBar(bar)
        case .closed:
            screen.setConnection(.reconnecting)
        }
    }
}

// MARK: - M27 W6: the full-screen view's tab strip and address bar

extension ChatStore {
    /// GET /api/computer/tabs when the full-screen view opens and on every new stream connection
    /// (one at a time). A backend from before M27 answers 404 and anything that doesn't decode
    /// reads as an older computer: `.unsupported`, no error line. An answer that arrives after a
    /// stream message or an action's answer is older: dropped.
    func loadBrowserBar() {
        guard !tornDown, computerRuntime.barLoadTask == nil, ComputerDeployRules.isDeployed(computerBoard.view) else { return }
        let ticket = computerRuntime.barFeed.ticket()
        computerRuntime.barLoadTask = Task { [client] in
            let result = await Self.result { try await client.browserBar() }
            guard !Task.isCancelled, !tornDown else { return }
            computerRuntime.barLoadTask = nil
            guard computerRuntime.barFeed.accept(ticket) else { return }
            switch result {
            case .success(let bar):
                applyBrowserBar(bar)
            case .failure(let error) where error is CancellationError:
                break
            case .failure(let error):
                // Connectivity: the bar waits as it is for the stream; anything else is an
                // older backend or computer.
                if (error as? APIError)?.isConnectivity == true { return }
                computerBoard.view.barKnown = true
            }
        }
    }

    /// Every bar from the GET, the stream or an action's answer, cleaned (at most 50 tabs, valid
    /// distinct ids, one active) before anything reads it.
    func applyBrowserBar(_ bar: BrowserBar) {
        let clean = BrowserBarRules.sanitized(bar)
        if computerBoard.view.bar != clean { computerBoard.view.bar = clean }
        if !computerBoard.view.barKnown { computerBoard.view.barKnown = true }
    }

    /// A tab strip or address bar action after Take over. One runs at a time; a tap meanwhile waits
    /// behind it (the same one twice is dropped). Any action clears the refusal line.
    func runBrowserBar(_ action: BrowserBarAction) {
        guard !tornDown, computerBoard.view.isUserInControl else { return }
        computerBoard.view.barRefusal = nil
        computerRuntime.barQueue.enqueue(action)
        startNextBarAction()
    }

    private func startNextBarAction() {
        guard computerBoard.view.isUserInControl, let action = computerRuntime.barQueue.next() else { return }
        computerBoard.view.barAction = action
        computerRuntime.barActionTask = Task { [client] in
            let result = await Self.result { try await client.browserBar(action) }
            guard !Task.isCancelled, !tornDown else { return }
            finishBarAction(action, result)
        }
    }

    /// Each answer replaces the bar (and wins over a GET on its way); the loaded titles follow on
    /// the stream. A refusal shows one line under the bar.
    private func finishBarAction(_ action: BrowserBarAction, _ result: Result<BrowserBar, any Error>) {
        computerRuntime.barQueue.finish()
        computerRuntime.barActionTask = nil
        computerBoard.view.barAction = nil
        switch result {
        case .success(let bar):
            markOnline()
            computerRuntime.barFeed.noteNewer()
            applyBrowserBar(bar)
            if action.isBlankNewTab { computerBoard.view.newTabs &+= 1 }
        case .failure(let error):
            noteFailure(error)
            switch BrowserBarRules.outcome(of: error, newTab: action.isNewTab) {
            case .refused(let refusal): noteBarRefusal(refusal)
            case .refetch: loadBrowserBar()
            case .none: break
            }
        }
        if computerBoard.view.isUserInControl {
            startNextBarAction()
        } else {
            computerRuntime.barQueue.dropWaiting()
        }
    }

    private func noteBarRefusal(_ refusal: BrowserBarRules.Refusal) {
        switch refusal {
        case .needsUpdate:
            // An older computer: the address-only row from now on (a later answer that says
            // otherwise brings the tabs back).
            computerBoard.view.bar.supported = false
            computerBoard.view.barKnown = true
            computerRuntime.barQueue.dropWaiting()
        case .takeOverFirst:
            computerRuntime.barQueue.dropWaiting()
            // Hand back while it ran: the user already gave the browser back; nothing to say.
            guard computerBoard.view.isUserInControl, computerBoard.view.control != .releasing else { return }
        case .tooFast:
            computerRuntime.barQueue.dropWaiting()
        default:
            break
        }
        computerBoard.view.barRefusal = refusal
        computerBoard.view.barRefusals &+= 1
    }

    /// Hand back (asked for, or the server's): the actions still waiting are dropped and the
    /// refusal line goes; the one in flight finishes on its own.
    func endBarDriving() {
        computerRuntime.barQueue.dropWaiting()
        computerBoard.view.barRefusal = nil
    }
}
