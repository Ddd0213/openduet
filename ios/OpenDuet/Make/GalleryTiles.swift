// The gallery's items (prompt L147): a grid card and a list row, and the "Just made" treatment
// (orange border, orange badge, "this minute"). M24, the card as in OpenDuet: a rounded card
// with the 2-line semibold title, the type icon in its colour + "2 hr ago", then the live
// thumbnail set into its lower half and cut off by the card's bottom edge (a page shows its top,
// a design the whole thing scaled down on the tile colour); "Just made" sits at the thumbnail's
// bottom-right. The row keeps its small thumbnail and title with the same icon + time. A building
// item shows its skeleton with the orange line; a failed one says so. Long-press: Open, Add to tab
// bar / Remove from tab bar, Delete. M9: Delete asks in place under the item first; the item then
// leaves at once, and a failed delete brings it back with the reason and Retry under it. M10: Pin /
// Unpin (first in Make, separate from the tab bar): the item moves at once; a failed PATCH puts it
// back with the reason and Retry under it.
import SwiftUI

extension Metrics {
    /// M24: the grid card's thumbnail slot (width / height): the top ~70% of a 3:4 page.
    static let galleryPeekAspect: CGFloat = 1.45
}

/// The type icon in its colour + "2 hr ago" (or "Making it...", "Couldn't finish this one") under
/// a title.
struct ArtifactMetaLine: View {
    var artifact: ArtifactSummary
    var now: Date
    var justMade = false

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        HStack(spacing: 5) {
            DuetIcon(artifact.type.cardIcon, size: fontSize + 3, tint: artifact.type.tint)
                .accessibilityHidden(true)
            Group {
                switch artifact.status {
                case .building: Text("Making it...")
                case .failed: Text("Couldn't finish this one")
                case .ready: Text(verbatim: MakeCopy(format: ChatDateFormat(locale: locale)).ago(artifact.updatedAt, now: now))
                }
            }
            .font(.system(size: fontSize))
            .foregroundStyle(justMade ? Palette.justMade : Palette.secondaryText)
            .lineLimit(1)
        }
    }
}

/// The orange "Just made" badge.
struct JustMadeBadge: View {
    var body: some View {
        Text("Just made")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(Palette.justMade))
            .fixedSize()
    }
}

/// A thumbnail that becomes the pulsing skeleton + running orange line while building.
struct ArtifactPreview: View {
    var artifact: ArtifactSummary
    var corner: CGFloat

    var body: some View {
        if artifact.status == .building {
            ZStack {
                RoundedRectangle(cornerRadius: corner, style: .continuous).fill(Palette.cardSurface)
                BuildSkeleton(type: artifact.type).padding(10)
                ProgressPerimeter(corner: corner, lineWidth: 2)
            }
        } else {
            ArtifactThumbnail(artifact: artifact, corner: corner)
        }
    }
}

struct GalleryTile: View {
    var artifact: ArtifactSummary
    var justMade: Bool
    var now: Date
    var onOpen: () -> Void
    var onPin: (Bool) -> Void
    /// M9: MakeState.requests[RequestKey.delete(id)] (a failed delete put the tile back)
    var deleteRequest: CardRequest? = nil
    var onDelete: () -> Void = {}
    /// M10: MakeState.requests[RequestKey.pinInMake(id)] and long-press Pin / Unpin
    var pinRequest: CardRequest? = nil
    var onPinInMake: ((Bool) -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmingDelete = false
    /// A failed delete brings the item back as a new view: the warning plays as it appears.
    @State private var failedHaptic = 0
    @ScaledMetric(relativeTo: .headline) private var titleSize: CGFloat = 17

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            tile
            ArtifactDeleteQuestion(
                artifact: artifact, confirming: $confirmingDelete, failure: deleteRequest?.failureReason,
                compact: true, onDelete: onDelete
            )
            ArtifactPinFailure(artifact: artifact, request: pinRequest, onPin: onPinInMake)
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: confirmingDelete)
        .animation(.easeInOut(duration: 0.2), value: pinRequest)
        .onAppear { if deleteRequest?.failureReason != nil { failedHaptic += 1 } }
        .sensoryFeedback(.warning, trigger: failedHaptic)
        .sensoryFeedback(.warning, trigger: pinRequest) { _, new in new?.failureReason != nil }
    }

    private var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Metrics.galleryCorner, style: .continuous)
    }

    private var tile: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: artifact.title)
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2, reservesSpace: true)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ArtifactMetaLine(artifact: artifact, now: now, justMade: justMade)
                }
                .padding(.horizontal, 14)
                .padding(.top, 14)
                .padding(.bottom, 12)
                // The thumbnail in the card's lower half, its bottom cut off by the card's edge.
                GalleryCardLower(artifact: artifact)
                    .padding(.horizontal, 10)
                    .overlay(alignment: .bottomTrailing) {
                        if justMade { JustMadeBadge().padding(.trailing, 18).padding(.bottom, 10).transition(.scale.combined(with: .opacity)) }
                    }
            }
            .clipShape(cardShape)
            .background(cardShape.fill(Palette.cardSurface))
            .overlay {
                if artifact.status == .building {
                    ProgressPerimeter(corner: Metrics.galleryCorner, lineWidth: 2)
                } else {
                    cardShape.strokeBorder(justMade ? Palette.justMade : Palette.cardBorder, lineWidth: justMade ? 2 : Metrics.hairline)
                }
            }
            .contentShape(cardShape)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.97))
        .cleanContextPreview(corner: Metrics.galleryCorner)
        .artifactContextMenu(artifact, onOpen: onOpen, onPin: onPin, onPinInMake: onPinInMake, pinBusy: pinRequest == .inFlight) { confirmingDelete = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ArtifactAccessibility.label(artifact, justMade: justMade, now: now))
        .accessibilityHint(Text("Opens it"))
    }
}

/// M24: the grid card's lower half: a slot whose top corners are rounded and whose bottom is the
/// card's edge. A page fills its width from the top (the rest is cut off), a design shows whole
/// on the tile colour, a build pulses its skeleton (the card's border runs the orange line).
private struct GalleryCardLower: View {
    var artifact: ArtifactSummary

    private var slot: UnevenRoundedRectangle {
        UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 0, bottomTrailingRadius: 0, topTrailingRadius: 12, style: .continuous)
    }

    var body: some View {
        Color.clear
            .aspectRatio(Metrics.galleryPeekAspect, contentMode: .fit)
            .overlay {
                if artifact.status == .building {
                    ZStack(alignment: .top) {
                        Palette.tile
                        BuildSkeleton(type: artifact.type)
                            .aspectRatio(Metrics.thumbnailAspect, contentMode: .fit)
                            .padding(.horizontal, 12)
                            .padding(.top, 12)
                    }
                } else {
                    ArtifactThumbnail(artifact: artifact, corner: 0, fit: MakeGallery.designTypes.contains(artifact.type) ? .whole : .top)
                }
            }
            .clipShape(slot)
    }
}

struct GalleryRow: View {
    var artifact: ArtifactSummary
    var justMade: Bool
    var now: Date
    var onOpen: () -> Void
    var onPin: (Bool) -> Void
    /// M9: MakeState.requests[RequestKey.delete(id)] (a failed delete put the row back)
    var deleteRequest: CardRequest? = nil
    var onDelete: () -> Void = {}
    /// M10: MakeState.requests[RequestKey.pinInMake(id)] and long-press Pin / Unpin
    var pinRequest: CardRequest? = nil
    var onPinInMake: ((Bool) -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmingDelete = false
    @State private var failedHaptic = 0
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            row
            ArtifactDeleteQuestion(
                artifact: artifact, confirming: $confirmingDelete, failure: deleteRequest?.failureReason,
                compact: false, onDelete: onDelete
            )
            ArtifactPinFailure(artifact: artifact, request: pinRequest, onPin: onPinInMake)
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: confirmingDelete)
        .animation(.easeInOut(duration: 0.2), value: pinRequest)
        .onAppear { if deleteRequest?.failureReason != nil { failedHaptic += 1 } }
        .sensoryFeedback(.warning, trigger: failedHaptic)
        .sensoryFeedback(.warning, trigger: pinRequest) { _, new in new?.failureReason != nil }
    }

    private var row: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                // A fixed 64 pt square whatever the state: the 3:4 snapshot fills it from the
                // page's top and the rest is cut off (left alone it grows to ~64×85 and the row
                // with it), so ready, failed and building rows are the same height.
                ArtifactPreview(artifact: artifact, corner: 10)
                    .frame(width: 64, height: 64, alignment: .top)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 5) {
                    Text(verbatim: artifact.title)
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    ArtifactMetaLine(artifact: artifact, now: now, justMade: justMade)
                }
                Spacer(minLength: 4)
                if justMade { JustMadeBadge() }
                RowChevron()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: Metrics.galleryCorner, style: .continuous)
                    .fill(Palette.cardSurface)
                    .strokeBorder(justMade ? Palette.justMade : Palette.cardBorder, lineWidth: justMade ? 2 : Metrics.hairline)
            )
            .contentShape(RoundedRectangle(cornerRadius: Metrics.galleryCorner, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .cleanContextPreview(corner: Metrics.galleryCorner)
        .artifactContextMenu(artifact, onOpen: onOpen, onPin: onPin, onPinInMake: onPinInMake, pinBusy: pinRequest == .inFlight) { confirmingDelete = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ArtifactAccessibility.label(artifact, justMade: justMade, now: now))
        .accessibilityHint(Text("Opens it"))
    }
}

enum ArtifactAccessibility {
    /// "Web page, Bike shop bookings, 2 hr ago" (+ "Just made").
    static func label(_ artifact: ArtifactSummary, justMade: Bool, now: Date) -> Text {
        let when: Text = switch artifact.status {
        case .building: Text("Making it...")
        case .failed: Text("Couldn't finish this one")
        case .ready: Text(verbatim: MakeCopy().ago(artifact.updatedAt, now: now))
        }
        let base = Text("\(Text(artifact.type.title)), \(artifact.title), \(when)")
        return justMade ? Text("\(base), \(Text("Just made"))") : base
    }
}

extension View {
    /// Long-press: Open, Pin / Unpin (M10, first in Make), Add to tab bar / Remove from tab bar,
    /// Delete (M9: `onAskDelete` opens the in-place question; nothing is deleted from the menu
    /// itself).
    func artifactContextMenu(
        _ artifact: ArtifactSummary, onOpen: @escaping () -> Void, onPin: @escaping (Bool) -> Void,
        onPinInMake: ((Bool) -> Void)? = nil, pinBusy: Bool = false,
        onAskDelete: @escaping () -> Void
    ) -> some View {
        contextMenu {
            Button(action: onOpen) { Label { Text("Open") } icon: { Image(glyph: .forward) } }
            if let onPinInMake {
                Button { onPinInMake(!artifact.pinned) } label: {
                    if artifact.pinned {
                        Label { Text("Unpin") } icon: { Image(systemName: "pin.slash") }
                    } else {
                        Label { Text("Pin") } icon: { Image(glyph: .pin) }
                    }
                }
                .disabled(pinBusy)
            }
            if artifact.status == .ready {
                if artifact.pinnedToTabBar {
                    Button { onPin(false) } label: { Label { Text("Remove from tab bar") } icon: { Image(glyph: .removeFromTabBar) } }
                } else {
                    Button { onPin(true) } label: { Label { Text("Add to tab bar") } icon: { Image(glyph: .addToTabBar) } }
                }
            }
            Divider()
            Button(role: .destructive, action: onAskDelete) {
                Label { Text("Delete") } icon: { Image(glyph: .delete) }
            }
        }
        .accessibilityAction(named: artifact.pinned ? Text("Unpin") : Text("Pin")) {
            if !pinBusy { onPinInMake?(!artifact.pinned) }
        }
        .accessibilityAction(named: artifact.pinnedToTabBar ? Text("Remove from tab bar") : Text("Add to tab bar")) {
            onPin(!artifact.pinnedToTabBar)
        }
        .accessibilityAction(named: Text("Delete"), onAskDelete)
    }
}

/// M10: a Pin / Unpin that didn't go through (the item is back where it was): the reason and
/// Retry under it.
private struct ArtifactPinFailure: View {
    var artifact: ArtifactSummary
    var request: CardRequest?
    var onPin: ((Bool) -> Void)?

    var body: some View {
        if let reason = request?.failureReason, let onPin {
            // The item went back, so Retry asks for the same change again.
            InlineFailure(reason: reason, onRetry: { onPin(!artifact.pinned) }, onEdit: nil)
                .padding(.horizontal, 4)
                .transition(.opacity)
        }
    }
}

/// M9: a gallery item's Delete question in place under it ("Delete "Bike shop bookings"? It
/// leaves your gallery. This can't be undone.") and, after a failed delete put the item back,
/// the reason with Retry.
private struct ArtifactDeleteQuestion: View {
    var artifact: ArtifactSummary
    @Binding var confirming: Bool
    var failure: String?
    /// stacked buttons (a grid tile)
    var compact: Bool
    var onDelete: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if confirming {
            DeleteConfirmStrip(
                question: Text("Delete \"\(artifact.title)\"? It leaves your gallery. This can't be undone."),
                compact: compact,
                onConfirm: {
                    confirming = false
                    onDelete()
                },
                onCancel: { confirming = false }
            )
            .transition(.confirmReveal(reduceMotion: reduceMotion))
        } else if let failure {
            InlineFailure(reason: failure, onRetry: onDelete, onEdit: nil)
                .padding(.horizontal, 4)
        }
    }
}
