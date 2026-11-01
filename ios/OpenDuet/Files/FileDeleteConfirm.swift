// M26: the in-place question before a file is deleted, under a Files row and at the bottom of the
// preview (its ⋯ › Delete), never an alert. DeleteConfirmStrip's look (the question, Cancel and
// the red capsule, the spinner while it runs) plus, for a file whose original is on the assistant's
// computer outside artifacts/ and .skills/ (FileDeleteRules.offersWorkspaceDelete), the switch
// "Also delete from OpenDuet's computer", off each time it opens. A refusal stays in it: Retry
// when trying again can work; when the original is gone already, the red capsule becomes
// "Delete from the chat only" (the switch goes).
import SwiftUI

struct FileDeleteConfirm: View {
    var file: ChannelFile
    @Binding var alsoWorkspace: Bool
    var busy: Bool
    var failure: FileDeleteFailure?
    var onConfirm: (_ alsoWorkspace: Bool) -> Void
    var onCancel: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var questionSize: CGFloat = 14.5
    @ScaledMetric(relativeTo: .subheadline) private var switchSize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var pathSize: CGFloat = 12.5

    /// The original is gone: only the chat's copy can go.
    private var chatOnly: Bool { failure?.offersChatOnly == true }
    private var showsSwitch: Bool { FileDeleteRules.offersWorkspaceDelete(file) && !chatOnly }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Delete \"\(file.name)\"? It's removed from your files. This can't be undone.")
                .font(.system(size: questionSize))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            if showsSwitch {
                workspaceSwitch
                    .transition(.opacity)
            }
            if let failure {
                failureLine(failure)
            }
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Cancel"), style: .outline, action: onCancel)
                    .disabled(busy)
                DestructiveCapsule(
                    title: chatOnly ? Text("Delete from the chat only") : Text("Delete"), busy: busy
                ) {
                    onConfirm(showsSwitch && alsoWorkspace)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Palette.cardSurface)
                .strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline)
        )
        .animation(.easeInOut(duration: 0.2), value: failure)
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
        .accessibilityElement(children: .contain)
        .accessibilityAction(.escape, onCancel)
        .onAppear {
            // VoiceOver hears the question as soon as it opens.
            AccessibilityNotification.Announcement(String(localized: "Confirm delete")).post()
        }
    }

    /// The whole row toggles; the switch is drawn in the app's language (no system Toggle).
    private var workspaceSwitch: some View {
        Button {
            alsoWorkspace.toggle()
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Also delete from OpenDuet's computer")
                        .font(.system(size: switchSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    if let path = file.workspacePath {
                        Text(verbatim: path)
                            .font(.system(size: pathSize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                SettingsSwitch(on: alsoWorkspace)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .disabled(busy)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(alsoWorkspace ? Text("On") : Text("Off"))
        .sensoryFeedback(.selection, trigger: alsoWorkspace)
    }

    @ViewBuilder private func failureLine(_ failure: FileDeleteFailure) -> some View {
        if failure.retries {
            InlineFailure(reason: failure.reason) { onConfirm(showsSwitch && alsoWorkspace) }
        } else {
            SettingsReasonLine(reason: failure.reason)
                .transition(.opacity)
        }
    }
}
