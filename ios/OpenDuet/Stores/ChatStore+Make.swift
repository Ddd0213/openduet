// M6 (iOS 2, owned by the iOS-2 agent): the Make tab and the chat extras on the store side.
// ChatStore calls `routeMake` for every event, `teardownMake` on sign-out and `openArtifact`
// for duet://artifacts/<id>. Rendered state lives in `makeBoard` (observed); tasks live in
// `makeRuntime` (not observed). The state changes themselves are MakeState's (MakeReducer).
// M27: `syncData` fetches a dashboard's newer live data for the open viewers (GET /data, one per
// artifact at a time) wherever a reload could start; the viewer hands it to the page.
import Foundation

/// What the shell renders for M6 iOS 2 (ShellState.make / .chatExtras).
struct MakeBoard {
    var state = MakeState()
    var extras = ChatExtrasState()
    /// M9: artifacts deleted in this session (or being deleted): a late `artifact` event or a list
    /// answer doesn't bring them back. A failed DELETE takes its id out again.
    var deleted = Set<String>()
}

/// In-flight requests (ignored by observation).
@MainActor
final class MakeRuntime {
    var listTask: Task<Void, Never>?
    var viewerTasks: [MakeState.Slot: Task<Void, Never>] = [:]
    var requestTasks: [String: Task<Void, Never>] = [:]
    var skillsTask: Task<Void, Never>?
    /// Reactions and ratings in flight, by "<messageId>|<emoji>" / "<messageId>|rate".
    var extraTasks: [String: Task<Void, Never>] = [:]
    /// The /skill of each queued message, by clientId (SendMessageRequest.skill).
    var pendingSkills: [String: String] = [:]
    /// What each build of this session was asked for, so the Build view's Retry can ask again.
    var prompts: [String: (type: ArtifactType, prompt: String)] = [:]
    /// M27: GET /data, one in flight per artifact (both viewers of it share it).
    var dataFetches = LiveDataFetches()
    var dataTasks: [String: Task<Void, Never>] = [:]

    func cancelAll() {
        listTask?.cancel()
        skillsTask?.cancel()
        viewerTasks.values.forEach { $0.cancel() }
        requestTasks.values.forEach { $0.cancel() }
        extraTasks.values.forEach { $0.cancel() }
        dataTasks.values.forEach { $0.cancel() }
        listTask = nil
        skillsTask = nil
        viewerTasks = [:]
        requestTasks = [:]
        extraTasks = [:]
        dataTasks = [:]
        dataFetches = LiveDataFetches()
        pendingSkills = [:]
        prompts = [:]
    }
}

extension ChatStore {
    var makeActions: MakeActions {
        var actions = MakeActions()
        actions.refresh = { [weak self] in self?.refreshMake() }
        actions.create = { [weak self] type, prompt in self?.createArtifact(type, prompt: prompt) }
        actions.open = { [weak self] id in self?.openArtifact(id) }
        actions.close = { [weak self] in self?.closeArtifact() }
        actions.closeBuild = { [weak self] in self?.makeBoard.state.build = nil }
        actions.refreshArtifact = { [weak self] id in self?.refreshArtifact(id) }
        actions.edit = { [weak self] id, prompt in self?.editArtifact(id, prompt: prompt) }
        actions.setPinned = { [weak self] id, on in self?.setArtifactPinned(id, on) }
        actions.retryBuild = { [weak self] id in self?.retryBuild(id) }
        actions.comment = { [weak self] id, quote, note in
            self?.editArtifact(id, prompt: Self.commentPrompt(quote: quote, note: note))
        }
        actions.showPinned = { [weak self] in self?.showPinned() }
        actions.delete = { [weak self] id in self?.deleteArtifact(id) }
        actions.pinInMake = { [weak self] id, on in self?.pinArtifactInMake(id, on) }
        actions.dataHandedOver = { [weak self] pinned, id, version, load, shown in
            self?.dataHandedOver(pinned ? .pinned : .viewer, id: id, version: version, load: load, shown: shown)
        }
        return actions
    }

    var chatExtrasActions: ChatExtrasActions {
        var actions = ChatExtrasActions()
        actions.loadSkills = { [weak self] in self?.loadSkills() }
        actions.sendWithSkill = { [weak self] text, skill, ids in self?.send(text: text, attachmentIds: ids, skill: skill) }
        actions.react = { [weak self] id, emoji, on in self?.react(messageId: id, emoji: emoji, on: on) }
        actions.rate = { [weak self] id, rating in self?.rate(messageId: id, rating) }
        return actions
    }

    /// `artifact` events: the gallery, the Build view's status line, the viewers' reloads. The
    /// chat's artifact cards take the same event in ThreadReducer.
    func routeMake(_ event: DuetEvent) {
        guard !tornDown, case .artifact(let update) = event.body, !makeBoard.deleted.contains(update.artifact.id) else { return }
        // M21: with its editStatus / refreshStatus (the viewer shows an edit's progress and failure).
        let reload = makeBoard.state.apply(update)
        for slot in reload { loadViewer(slot, id: update.artifact.id, detail: false) }
        // M27: newer data alone goes to the open page without a reload.
        syncData()
    }

    /// M27: GET /data for each artifact whose open viewer is behind on its data
    /// (MakeState.dataBehind), one fetch per artifact at a time; a newer version asked for
    /// meanwhile is looked at again when it ends. The answer is handed to the page (or reloads
    /// it once when the data was cleared). A failure is silent: the next event or list load
    /// tries again (404: the artifact is gone, the list says so).
    func syncData() {
        guard !tornDown else { return }
        let behind = Set(makeBoard.state.dataBehind().values)
        for id in behind {
            guard let version = makeBoard.state.artifact(id)?.dataVersion,
                  makeRuntime.dataFetches.ask(id, version: version) else { continue }
            makeRuntime.dataTasks[id] = Task { [client] in
                let result = await Self.result { try await client.artifactData(id: id) }
                // Cancelled only by teardown (cancelAll starts the bookkeeping over).
                guard !Task.isCancelled, !tornDown else { return }
                makeRuntime.dataTasks[id] = nil
                let again = makeRuntime.dataFetches.ended(id)
                if case .success(let response) = result, response.artifactId == id {
                    markOnline()
                    for slot in makeBoard.state.dataFetched(response) { loadViewer(slot, id: id, detail: false) }
                }
                if again { syncData() }
            }
        }
    }

    /// M27: the open page answered a hand-over; a page without a data element reloads once.
    func dataHandedOver(_ slot: MakeState.Slot, id: String, version: Int, load: Int, shown: Int?) {
        guard !tornDown else { return }
        if makeBoard.state.handedOver(slot, id: id, version: version, load: load, shown: shown) {
            loadViewer(slot, id: id, detail: false)
        }
    }

    func teardownMake() {
        makeRuntime.cancelAll()
        makeBoard = MakeBoard()
        // The thumbnails are this account's pages: drop them on sign-out (memory only).
        ArtifactSnapshots.shared.clear()
    }

    /// duet://artifacts/<id> (notifications, chat links, task Resources): over the current tab.
    func openArtifact(_ id: String) {
        guard !tornDown, !id.isEmpty else { return }
        if makeBoard.state.open(id) {
            loadViewer(.viewer, id: id, detail: true)
        }
        // Known only by id (a link before the gallery loaded): the list fills in its card.
        if makeBoard.state.phase != .loaded && makeRuntime.listTask == nil { refreshMake() }
    }
}
