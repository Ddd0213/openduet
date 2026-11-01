// M6 (iOS 2): the Make tab's requests (prompt L147-L152, L181, L185). The gallery list (on
// appear and pull to refresh), Create (hero composer / Describe sheet / the Build view's Retry),
// the viewers' detail + HTML (fetched through the signed-in session, L172), dashboard ↻, ✎ edit
// and Comment, and Add to tab bar (optimistic, one pinned at a time, rolled back on failure).
// Each tap shows `.inFlight` in MakeState.requests until its answer.
import Foundation

extension ChatStore {
    // MARK: - Gallery

    func refreshMake() {
        guard !tornDown else { return }
        makeRuntime.listTask?.cancel()
        if makeBoard.state.phase == .loaded { makeBoard.state.refreshing = true } else { makeBoard.state.phase = .loading }
        makeRuntime.listTask = Task { [client] in
            let result = await Self.result { try await client.artifacts() }
            guard !Task.isCancelled, !tornDown else { return }
            makeRuntime.listTask = nil
            switch result {
            case .success(let list):
                markOnline()
                // M9: a delete in flight (or done) keeps the item out of a list read before it.
                makeBoard.state.applyList(list.filter { !makeBoard.deleted.contains($0.id) })
                // M24: a viewer behind the list (its `artifact` event was missed, e.g. after a
                // restore) catches up. M27: a new page reloads; newer data alone is handed over.
                for (slot, id) in makeBoard.state.staleViewers() { loadViewer(slot, id: id, detail: false) }
                syncData()
            case .failure(let error):
                noteFailure(error)
                makeBoard.state.failList(reason: TaskBoard.reason(for: error))
            }
        }
    }

    // MARK: - Create

    /// POST /api/artifacts in the main thread's channel (where "OpenDuet made a page." lands); the
    /// Build view opens on the answer.
    func createArtifact(_ type: ArtifactType, prompt: String) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = MakeState.RequestKey.create
        guard !tornDown, !text.isEmpty, makeBoard.state.requests[key] != .inFlight else { return }
        makeBoard.state.requests[key] = .inFlight
        let body = CreateArtifactRequest(type: type, prompt: text, channelId: user.mainChannelId)
        runMake(key, { [client] in try await client.createArtifact(body) }) { store, result in
            switch result {
            case .success(let artifact):
                store.makeRuntime.prompts[artifact.id] = (type, text)
                store.makeBoard.state.created(artifact)
                if artifact.status == .ready { store.loadViewer(.viewer, id: artifact.id, detail: true) }
            case .failure(let error):
                store.failMakeRequest(key, error)
            }
        }
    }

    /// The Build view's Retry on a failed first build.
    func retryBuild(_ id: String) {
        // M21: Retry rebuilds the same artifact in place (POST /api/artifacts/:id/refresh, with the
        // trust of whoever started it) instead of creating a copy with the user's trust.
        refreshArtifact(id)
    }

    // MARK: - Viewer

    func closeArtifact() {
        makeRuntime.viewerTasks[.viewer]?.cancel()
        makeBoard.state.viewer = nil
    }

    /// The 4th tab appeared: its artifact loads into `pinnedViewer` (once; again after a failure).
    func showPinned() {
        guard !tornDown, let pinned = makeBoard.state.pinned else { return }
        if let shown = makeBoard.state.pinnedViewer, shown.artifactId == pinned.id {
            guard case .failed = shown.phase else { return }
        }
        makeBoard.state.pinnedViewer = ArtifactViewerState(artifactId: pinned.id)
        loadViewer(.pinned, id: pinned.id, detail: true)
    }

    /// GET /api/artifacts/:id (with `detail`) and GET /api/artifacts/:id/html for one viewer. A
    /// version that became ready meanwhile loads again right after.
    func loadViewer(_ slot: MakeState.Slot, id: String, detail: Bool) {
        guard !tornDown else { return }
        // M24: a viewer that never got its detail (the Build view handed over) fetches it now: the
        // GET records the open (lastOpenedAt) and brings the sources.
        let detail = detail || makeBoard.state.needsDetail(slot, id: id)
        makeRuntime.viewerTasks[slot]?.cancel()
        // M27: the page's own clock (`pageVersion`), and the data version the page is asked at.
        let known = makeBoard.state.artifact(id)?.pageVersion
        let knownData = makeBoard.state.artifact(id)?.dataVersion
        makeRuntime.viewerTasks[slot] = Task { [client] in
            var info: Result<ArtifactDetail, any Error>?
            var page: Result<String, any Error>
            if detail {
                async let d = Self.result { try await client.artifact(id: id) }
                async let h = Self.result { try await client.artifactHTML(id: id) }
                (info, page) = await (d, h)
            } else {
                page = await Self.result { try await client.artifactHTML(id: id) }
            }
            guard !Task.isCancelled, !tornDown else { return }
            var version = known
            var data = knownData
            if case .success(let loaded)? = info {
                makeBoard.state.detailLoaded(loaded, slot: slot)
                version = loaded.summary.pageVersion
                data = data ?? loaded.summary.dataVersion
            }
            switch page {
            case .success(let html):
                markOnline()
                makeBoard.state.htmlLoaded(html, version: version, knownData: data, slot: slot, id: id)
                if let current = makeBoard.state.artifact(id), current.status == .ready, let version, current.pageVersion > version {
                    loadViewer(slot, id: id, detail: false)
                } else {
                    // M27: data newer than the page's (it changed meanwhile) goes in place.
                    syncData()
                }
            case .failure(let error):
                noteFailure(error)
                makeBoard.state.htmlFailed(reason: TaskBoard.reason(for: error), slot: slot, id: id)
            }
        }
    }

    // MARK: - Refresh, edit, pin

    /// Dashboard ↻: "Refreshing..." until the new version is ready (it reloads in place). M27: a
    /// dashboard with data refreshes only its data: it lands in place (MakeReducer noteData).
    func refreshArtifact(_ id: String) {
        let key = MakeState.RequestKey.refresh(id)
        guard !tornDown, makeBoard.state.requests[key] != .inFlight else { return }
        makeBoard.state.requests[key] = .inFlight
        makeBoard.state.askRefresh(id)
        makeBoard.state.retryWork(id, edit: false)
        runMake(key, { [client] in try await client.refreshArtifact(id: id) }) { store, result in
            switch result {
            case .success(let artifact):
                store.makeBoard.state.requests[key] = nil
                store.makeBoard.state.refreshAnswered(artifact).forEach { store.loadViewer($0, id: id, detail: false) }
                store.syncData()
            case .failure(let error):
                store.makeBoard.state.endRefresh(id)
                store.failMakeRequest(key, error)
            }
        }
    }

    /// ✎ / Comment: POST /api/artifacts/:id/edit; the viewer shows the assistant working until the new
    /// version is ready, then re-renders it in place (the page glows what changed, L181).
    func editArtifact(_ id: String, prompt: String) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = MakeState.RequestKey.edit(id)
        guard !tornDown, !text.isEmpty, makeBoard.state.requests[key] != .inFlight else { return }
        makeBoard.state.requests[key] = .inFlight
        makeBoard.state.retryWork(id, edit: true)
        runMake(key, { [client] in try await client.editArtifact(id: id, prompt: text) }) { store, result in
            switch result {
            case .success(let artifact):
                store.makeBoard.state.requests[key] = nil
                store.makeBoard.state.editing.insert(id)
                store.makeBoard.state.apply(artifact).forEach { store.loadViewer($0, id: id, detail: false) }
                store.syncData()
            case .failure(let error):
                store.failMakeRequest(key, error)
            }
        }
    }

    /// M10: long-press Pin / Unpin in Make (pinned first; not the tab bar): at once, PATCH
    /// {pinned}; a failure puts the item back and leaves the reason under it
    /// (MakeState.requests[RequestKey.pinInMake(id)]).
    func pinArtifactInMake(_ id: String, _ on: Bool) {
        let key = MakeState.RequestKey.pinInMake(id)
        guard !tornDown, makeBoard.state.requests[key] != .inFlight,
              let change = makeBoard.state.setPinnedInMake(id, on) else { return }
        makeBoard.state.requests[key] = .inFlight
        let body = UpdateArtifactRequest(pinned: on)
        runMake(key, { [client] in try await client.updateArtifact(id: id, body) }) { store, result in
            switch result {
            case .success(let artifact):
                store.makeBoard.state.requests[key] = nil
                store.makeBoard.state.apply(artifact)
                store.syncData()
            case .failure(let error):
                // Gone meanwhile (deleted here): nothing to put back.
                guard !store.makeBoard.deleted.contains(id) else { store.makeBoard.state.requests[key] = nil; return }
                store.makeBoard.state.restorePinInMake(change)
                store.failMakeRequest(key, error)
            }
        }
    }

    /// Add to tab bar / Remove from tab bar: at once, one pinned at a time (the server unpins the
    /// previous one too); a failure puts the tab bar back and leaves the reason.
    func setArtifactPinned(_ id: String, _ on: Bool) {
        let key = MakeState.RequestKey.pin(id)
        guard !tornDown, makeBoard.state.requests[key] != .inFlight else { return }
        let before = makeBoard.state.setPinned(id, on)
        makeBoard.state.requests[key] = .inFlight
        let body = UpdateArtifactRequest(pinnedToTabBar: on, title: nil)
        runMake(key, { [client] in try await client.updateArtifact(id: id, body) }) { store, result in
            switch result {
            case .success(let artifact):
                store.makeBoard.state.requests[key] = nil
                store.makeBoard.state.apply(artifact)
                store.syncData()
            case .failure(let error):
                store.makeBoard.state.restorePins(before)
                store.failMakeRequest(key, error)
            }
        }
    }

    /// M9: long-press Delete (after the in-place confirmation): the item leaves the gallery at
    /// once (its viewer, Build view and 4th tab close); DELETE /api/artifacts/:id. A failure puts
    /// it back with the reason under it (MakeState.requests[RequestKey.delete(id)]); 404 counts as
    /// gone.
    func deleteArtifact(_ id: String) {
        let key = MakeState.RequestKey.delete(id)
        guard !tornDown, makeBoard.state.requests[key] != .inFlight else { return }
        makeRuntime.requestTasks[MakeState.RequestKey.pin(id)]?.cancel()
        makeRuntime.requestTasks[MakeState.RequestKey.pinInMake(id)]?.cancel()
        makeRuntime.requestTasks[MakeState.RequestKey.edit(id)]?.cancel()
        makeRuntime.requestTasks[MakeState.RequestKey.refresh(id)]?.cancel()
        let removal = makeBoard.state.remove(id)
        makeBoard.deleted.insert(id)
        makeBoard.state.requests[key] = .inFlight
        runMake(key, { [client] in try await client.deleteArtifact(id: id) }) { store, result in
            switch result {
            case .success:
                store.makeBoard.state.requests[key] = nil
            case .failure(let error as APIError) where error == .notFound:
                store.makeBoard.state.requests[key] = nil
            case .failure(let error):
                store.makeBoard.deleted.remove(id)
                if let removal { store.makeBoard.state.restore(removal) }
                store.failMakeRequest(key, error)
            }
        }
    }

    /// Comment: the selected passage quoted above the note, as one edit request for the assistant.
    nonisolated static func commentPrompt(quote: String?, note: String) -> String {
        let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let quote = quote?.trimmingCharacters(in: .whitespacesAndNewlines), !quote.isEmpty else { return note }
        let quoted = quote.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
        return note.isEmpty ? quoted : quoted + "\n\n" + note
    }

    // MARK: - Helpers

    /// Runs one Make request (cancelled on teardown) and hands its outcome to `answer`.
    private func runMake<T: Sendable>(
        _ key: String,
        _ request: @escaping @Sendable () async throws -> T,
        answer: @escaping @MainActor (ChatStore, Result<T, any Error>) -> Void
    ) {
        makeRuntime.requestTasks[key]?.cancel()
        makeRuntime.requestTasks[key] = Task { [weak self] in
            let result = await Self.result(request)
            guard let self, !self.tornDown, !Task.isCancelled else { return }
            switch result {
            case .success: self.markOnline()
            case .failure(let error): self.noteFailure(error)
            }
            answer(self, result)
        }
    }

    private func failMakeRequest(_ key: String, _ error: any Error) {
        makeBoard.state.requests[key] = error is CancellationError ? nil : .failed(reason: TaskBoard.reason(for: error))
    }
}
