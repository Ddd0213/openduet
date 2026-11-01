// Task detail ⋯ "Run details" (M8 brief §7a): one run → its detail; several → the task's list
// (?taskId=). The choice is made once, on the first answer, so a run that starts while the sheet
// is open doesn't swap the page under the user's finger.
import SwiftUI

struct RunsTaskSheet: View {
    var taskId: String
    var onClose: () -> Void

    @Environment(\.runs) private var runs
    @State private var mode: Mode?

    private enum Mode: Hashable { case single(String), list }

    private var scope: RunScope { .task(taskId) }

    var body: some View {
        Group {
            switch mode {
            case .single(let runId):
                RunDetailPage(runId: runId, leading: .close, onLeading: onClose)
            case .list:
                RunsListPage(scope: scope, title: Text("Run details"), leading: .close, onLeading: onClose)
            case nil:
                VStack(spacing: 0) {
                    SheetHeader(title: Text("Run details"), leading: .close, onLeading: onClose)
                    ScrollView {
                        RunRowsSkeleton(rows: 3)
                            .padding(.horizontal, 16)
                            .padding(.top, 8)
                    }
                    .scrollDisabled(true)
                }
            }
        }
        .transition(.opacity)
        .animation(.easeInOut(duration: 0.2), value: mode)
        .onAppear { if mode == nil { runs.actions.loadList(scope) } }
        // The first answer decides (or the list from an earlier visit, which reloads meanwhile;
        // a pushed detail polls on its own).
        .onChange(of: runs.state.list(scope), initial: true) { _, list in
            guard mode == nil, list.phase != .loading else { return }
            switch TaskRunsChoice(list) {
            case .loading: break
            case .single(let run): mode = .single(run.id)
            // Several, none or a failure: the list page shows them (or its empty / Retry line).
            case .list, .empty, .failed: mode = .list
            }
        }
    }
}
