// M24 (review-make P1-4): the viewer's ⋯ Versions sheet: the saved versions newest first, each
// with who saved it and why ("Edited by OpenDuet"), what was asked and when. The newest is "Current"
// (the page as it is now); the others have Restore (its row spins while it runs; a failure says
// why under the list). Rules in VersionRules; the same chrome as the Sources sheet.
import SwiftUI

struct VersionsSheet: View {
    var listing: VersionRules.Listing
    var onRestore: (ArtifactVersion) -> Void
    var onRetry: () -> Void
    var onClose: () -> Void

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 14
    @ScaledMetric(relativeTo: .footnote) private var noteSize: CGFloat = 13

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Versions"), leading: .close, onLeading: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    content
                }
                .padding(16)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: listing)
    }

    @ViewBuilder
    private var content: some View {
        if listing.list.versions.isEmpty {
            switch listing.phase {
            case .failed(let reason):
                InlineFailure(reason: reason, onRetry: onRetry, onEdit: nil)
            case .loaded:
                Text("No versions yet")
                    .font(.system(size: detailSize))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 28)
            default:
                skeleton
            }
        } else {
            rows
            if let failure = listing.failure {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    DuetIcon(glyph: .warning, size: noteSize + 2, tint: Palette.failure)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    Text(verbatim: failure)
                        .font(.system(size: noteSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 6)
                .transition(.opacity)
            }
            Text("The last 10 versions are kept.")
                .font(.system(size: noteSize))
                .foregroundStyle(Palette.secondaryText)
                .padding(.horizontal, 6)
        }
    }

    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(Array(listing.list.versions.enumerated()), id: \.element.id) { index, version in
                if index > 0 { Divider() }
                row(version, newest: index == 0)
            }
        }
        .padding(.horizontal, 16)
        .cardSurface()
    }

    private func row(_ version: ArtifactVersion, newest: Bool) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Self.title(VersionRules.label(version))
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                if let detail = VersionRules.detail(version.prompt) {
                    Text(verbatim: detail)
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(2)
                } else if let updates = VersionRules.updates(version) {
                    // M27: a data row has no prompt; its merged updates instead ("5 updates").
                    Text("\(updates) updates")
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                }
                Text(verbatim: ChatDateFormat(locale: locale).separator(version.createdAt))
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.secondaryText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            if newest {
                Text("Current")
                    .font(.system(size: noteSize, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(Palette.tile))
            } else {
                CapsuleButton(title: Text("Restore"), style: .outline, busy: listing.restoring == version.id, fullWidth: false) {
                    onRestore(version)
                }
                .disabled(listing.restoring != nil)
            }
        }
        .padding(.vertical, 12)
    }

    private var skeleton: some View {
        VStack(spacing: 0) {
            ForEach(0..<3, id: \.self) { index in
                if index > 0 { Divider() }
                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(width: 140, height: 14)
                    RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(height: 12)
                    RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(width: 90, height: 11)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 14)
            }
        }
        .padding(.horizontal, 16)
        .cardSurface()
        .skeletonPulse()
        .accessibilityElement()
        .accessibilityLabel(Text("Loading"))
    }

    /// "Edited by OpenDuet", "Restored by you", ... ("Edited" alone for a value from a newer server).
    static func title(_ label: VersionRules.Label) -> Text {
        switch label {
        case .made(let who): pick(who, you: Text("Made by you"), assistant: Text("Made by OpenDuet"), plain: Text("Made"))
        case .edited(let who): pick(who, you: Text("Edited by you"), assistant: Text("Edited by OpenDuet"), plain: Text("Edited"))
        case .refreshed(let who): pick(who, you: Text("Refreshed by you"), assistant: Text("Refreshed by OpenDuet"), plain: Text("Refreshed"))
        case .restored(let who): pick(who, you: Text("Restored by you"), assistant: Text("Restored by OpenDuet"), plain: Text("Restored"))
        // "Saved by OpenDuet" is taken (a memory fact, "OpenDuet 记下的"), so an unknown reason reads "Changed".
        case .changed(let who): pick(who, you: Text("Changed by you"), assistant: Text("Changed by OpenDuet"), plain: Text("Changed"))
        // M27: live data updates (a task's or chat's update_artifact_data).
        case .dataUpdated(let who): pick(who, you: Text("Data updated by you"), assistant: Text("Data updated by OpenDuet"), plain: Text("Data updated"))
        }
    }

    private static func pick(_ who: VersionRules.Label.Who?, you: Text, assistant: Text, plain: Text) -> Text {
        guard let who else { return plain }
        switch who {
        case .you: return you
        case .assistant: return assistant
        }
    }
}
