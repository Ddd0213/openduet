// M6 (iOS 2) additions to the data <-> UI seam (see ShellContract.swift): the Make tab (gallery,
// FAB, Describe sheet, Build view, artifact viewer, docs reader, Add to tab bar, artifact cards in
// chat) and the chat extras (/ skills, skill proposal cards, reactions and feedback, the spend
// request card). Prompt L146-L158, L164, L181, L185 (Make pull to refresh).
//
// Written by the main agent as a starting point; during M6 the iOS-2 agent owns this file and
// extends it (the original names are kept: ChatStore and MainShellView call them).
// Approving a spend request goes through CardActions.approve / decline like other approvals;
// Save skill / Not now go through CardActions.action (.saveSkill / .dismiss).
import Foundation

struct MakeState: Hashable, Sendable {
    var phase: TasksState.Phase = .loading
    /// pull to refresh: a reload of a loaded gallery is running
    var refreshing = false
    /// a reload of a loaded gallery failed: a grey line with the reason and Retry above it
    var refreshFailure: String?
    /// GET /api/artifacts, then upserted from `artifact` events (newest first)
    var artifacts: [ArtifactSummary] = []
    /// latest Build view status line per building artifact (`artifact` event buildStatus); for a
    /// failed build, its reason
    var buildStatus: [String: Phrase] = [:]
    /// the Build view on screen (it replaces the shell header, L164); nil = none
    var build: String?
    /// the artifact viewer / docs reader on screen; nil = none
    var viewer: ArtifactViewerState?
    /// M6: the pinned artifact's own viewer (the 4th tab, no ✕), loaded when that tab shows
    var pinnedViewer: ArtifactViewerState?
    /// made in this session and not opened yet: orange border + "Just made" (L147, L150)
    var justMade: Set<String> = []
    /// ✎ / Comment accepted by the server, until the new version is ready
    var editing: Set<String> = []
    /// M21: what the `artifact` events say the assistant is doing to a page that is already made (an
    /// edit from the viewer or the chat, a refresh): working, or failed with the reason
    /// (MakeReducer applyWork). No entry = nothing going on.
    var work: [String: ArtifactWork] = [:]
    /// artifacts first seen building (new ones, not an edit or ↻) until they are first ready:
    /// those open in the Build view and land with "Just made"
    var firstBuilds: Set<String> = []
    /// Make taps in flight or failed, by MakeState.RequestKey (create, edit, refresh, pin)
    var requests: ShellState.CardRequests = [:]
    /// M10: the artifacts pinned in Make (ArtifactSummary.pinned), newest pin first. The server
    /// sends them first in that order; a pin made here goes to the front at once.
    var pinOrder: [String] = []

    /// The artifact that is the 4th tab (at most one is pinned; the newest wins if two are).
    var pinned: ArtifactSummary? {
        artifacts.filter(\.pinnedToTabBar).max { $0.updatedAt < $1.updatedAt }
    }

    func artifact(_ id: String) -> ArtifactSummary? {
        artifacts.first { $0.id == id }
    }

    enum RequestKey {
        /// hero composer / Describe sheet / Retry in the Build view
        static let create = "make.create"
        static func edit(_ id: String) -> String { "make.edit.\(id)" }
        static func refresh(_ id: String) -> String { "make.refresh.\(id)" }
        static func pin(_ id: String) -> String { "make.pin.\(id)" }
        /// M9: long-press Delete on a gallery tile
        static func delete(_ id: String) -> String { "make.delete.\(id)" }
        /// M10: long-press Pin / Unpin (pinned first in Make; not the tab bar)
        static func pinInMake(_ id: String) -> String { "make.pinTop.\(id)" }
    }
}

struct ArtifactViewerState: Hashable, Sendable, Identifiable {
    enum Phase: Hashable, Sendable {
        case loading
        /// GET /api/artifacts/:id/html, rendered with loadHTMLString (never a public URL)
        case ready(html: String)
        case failed(reason: String)
    }
    var artifactId: String
    var detail: ArtifactDetail?
    var phase: Phase = .loading
    /// ↻ / "Refreshing..." in flight (the page keeps showing the last HTML)
    var refreshing = false
    /// bumps when an edit (✎ or by chat) re-rendered the page: the UI glows the changed passage
    var editGeneration = 0
    /// M27: the `pageVersion` of the page whose HTML is shown (a newer ready page reloads it; a
    /// newer `dataVersion` alone is handed to the page in place)
    var loadedVersion: Date?
    /// M27: the data-version inside the HTML string shown (`#duet-data`); nil = the page has none
    var htmlDataVersion: Int?
    /// M27: the highest data version the open page has rendered (`htmlDataVersion` after a load,
    /// raised by each hand-over); nil = none
    var dataShown: Int?
    /// M27: GET /data answered with a newer version, waiting for the page to take it
    var pendingData: ArtifactDataResponse?
    /// M27: the data version a reload was asked for because the page had no data element (or
    /// the data was cleared); the reload is asked for once per version, never in a loop
    var dataReload: Int?
    /// M27: counts the HTML loads (a hand-over's answer from a page since replaced is dropped)
    var pageLoads = 0
    /// M27: ↻ tapped here, until it ends (`RefreshWait`); the success haptic waits for its data
    var refreshWait: RefreshWait?
    /// M27: bumps when the data a ↻ tapped here brought is on the page (the success haptic)
    var dataLanded = 0
    var id: String { artifactId }

    /// M27: where a ↻ tapped in this viewer is, for its haptic (never for data a task or chat
    /// pushed).
    enum RefreshWait: Hashable, Sendable {
        /// tapped; the server hasn't said it is working yet
        case asked
        /// the refresh is reported working
        case running
        /// it ended with this newer data version; the haptic fires once the page shows it
        case landing(Int)
    }
}

struct ChatExtrasState: Hashable, Sendable {
    /// "/" in the composer lists these (GET /api/skills); nil until loaded
    var skills: [Skill]?
    /// GET /api/skills running (the list shows skeleton rows before the first answer)
    var skillsLoading = false
    /// the first GET /api/skills failed: the list shows the reason with Retry
    var skillsFailure: String?
    /// Good / Bad response given in this session, by message id (the menu checks it)
    var ratings: [String: FeedbackRequest.Rating] = [:]
    /// a reaction or rating that didn't go through, by message id (a grey line under the bubble)
    var failures: [String: String] = [:]
}

@MainActor
struct MakeActions {
    /// the Make tab appeared / pull to refresh
    var refresh: () -> Void = {}
    /// hero composer and Describe sheet: POST /api/artifacts, then the Build view opens
    var create: (_ type: ArtifactType, _ prompt: String) -> Void = { _, _ in }
    /// gallery item, chat artifact card, duet://artifacts/<id>: the viewer (or the Build view
    /// while it is still building)
    var open: (_ artifactId: String) -> Void = { _ in }
    var close: () -> Void = {}
    var closeBuild: () -> Void = {}
    /// dashboard ↻
    var refreshArtifact: (_ artifactId: String) -> Void = { _ in }
    /// ✎: ask the assistant for changes
    var edit: (_ artifactId: String, _ prompt: String) -> Void = { _, _ in }
    /// ⋯ Add to tab bar / long-press the 4th tab "− Remove from tab bar"
    var setPinned: (_ artifactId: String, _ pinned: Bool) -> Void = { _, _ in }
    /// M6: the Build view's Retry after a failed build (the same type and prompt again)
    var retryBuild: (_ artifactId: String) -> Void = { _ in }
    /// M6: ⋯ Comment / select-to-comment: an edit that quotes the selected passage
    var comment: (_ artifactId: String, _ quote: String?, _ note: String) -> Void = { _, _, _ in }
    /// M6: the 4th tab appeared (loads the pinned artifact into `pinnedViewer`)
    var showPinned: () -> Void = {}
    /// M9: long-press a gallery tile > Delete, after the in-place confirmation (DELETE
    /// /api/artifacts/:id; MakeState.requests[RequestKey.delete(id)]). The tile leaves the
    /// gallery at once; a failure puts it back with the reason.
    var delete: (_ artifactId: String) -> Void = { _ in }
    /// M10: long-press Pin / Unpin in Make (PATCH {pinned}; MakeState.requests[RequestKey.pinInMake(id)]).
    /// The item moves at once; a failure puts it back with the reason under it. Independent of
    /// Add to tab bar (`setPinned`).
    var pinInMake: (_ artifactId: String, _ pinned: Bool) -> Void = { _, _ in }
    /// M27: the open page answered a data hand-over (`shown`: the version it now shows, -1 = it
    /// has no data element, nil = the script failed); `load` is the viewer's `pageLoads` it ran on
    var dataHandedOver: (_ pinned: Bool, _ artifactId: String, _ version: Int, _ load: Int, _ shown: Int?) -> Void = { _, _, _, _, _ in }
}

@MainActor
struct ChatExtrasActions {
    /// "/" typed: load the skills list
    var loadSkills: () -> Void = {}
    /// send with a /skill (SendMessageRequest.skill)
    var sendWithSkill: (_ text: String, _ skill: String, _ attachmentIds: [UUID]) -> Void = { _, _, _ in }
    /// long-press 👍 ❤️ ⭐: PUT / DELETE /api/messages/:id/reactions/:emoji
    var react: (_ messageId: String, _ emoji: String, _ on: Bool) -> Void = { _, _, _ in }
    /// long-press Good response / Bad response (POST /api/feedback with messageId)
    var rate: (_ messageId: String, _ rating: FeedbackRequest.Rating) -> Void = { _, _ in }
}
