// Profile > Files (PART C, L180): the main thread's files, newest first, in the same list as
// the channel sheet. Refreshes when it appears and on pull. M9: long-press a file for Open, Share,
// Copy name and Delete. M26: in groups by origin (FileListSection); a task group's title and an
// artifact's page open through `actions.openLink` (the profile sheet closes first).
import SwiftUI

struct FilesPage: View {
    var list: FileListState
    var actions: FileActions
    var onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Files"), leading: .back, onLeading: onBack)
            ScrollView {
                FileListSection(
                    list: list, empty: "Files you or OpenDuet share show up here.",
                    onOpen: { actions.open($0.id) }, onRetry: actions.refreshMainFiles,
                    onDelete: { actions.delete($0.id, $1) }, onOpenLink: actions.openLink
                )
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .refreshable { actions.refreshMainFiles() }
        }
        .onAppear(perform: actions.refreshMainFiles)
    }
}
