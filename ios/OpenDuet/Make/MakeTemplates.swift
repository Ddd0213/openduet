// The Make tab's empty state (prompt L147, L184): "Templates" (horizontal cards with an icon tile
// and +: Daily todo, Email triage, Calendar prep; a tap makes it with the template's prompt)
// above the centred "Everything OpenDuet makes shows up here".
import SwiftUI

struct MakeTemplate: Identifiable {
    var id: String
    var title: LocalizedStringResource
    var subtitle: LocalizedStringResource
    var type: ArtifactType
    /// M9: the template's tile from the hand-drawn set (was a 💡 emoji on every card).
    var icon: CardIcon

    static let all: [MakeTemplate] = [
        MakeTemplate(id: "daily-todo", title: "Daily todo", subtitle: "Today's list, refreshed every morning", type: .dashboard, icon: .checklist),
        MakeTemplate(id: "email-triage", title: "Email triage", subtitle: "What needs a reply, sorted by urgency", type: .dashboard, icon: .mail),
        MakeTemplate(id: "calendar-prep", title: "Calendar prep", subtitle: "What's coming up and what to prepare", type: .dashboard, icon: .calendar),
    ]

    /// What the assistant is asked to make: "Daily todo: Today's list, refreshed every morning".
    var prompt: String {
        String(localized: title) + ": " + String(localized: subtitle)
    }
}

struct TemplateCard: View {
    var template: MakeTemplate
    var busy: Bool
    var action: () -> Void

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var subtitleSize: CGFloat = 14
    @State private var taps = 0

    var body: some View {
        Button {
            taps += 1
            action()
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    DuetIconTile(icon: template.icon, size: 36)
                    Spacer(minLength: 8)
                    ZStack {
                        Circle().fill(Palette.fab)
                        if busy {
                            ProgressView().tint(.white).controlSize(.mini)
                        } else {
                            DuetIcon(glyph: .add, size: 17, tint: .white)
                        }
                    }
                    .frame(width: 26, height: 26)
                    .accessibilityHidden(true)
                }
                Text(template.title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(1)
                Text(template.subtitle)
                    .font(.system(size: subtitleSize))
                    .foregroundStyle(Palette.secondaryText)
                    .lineLimit(3, reservesSpace: true)
                    .multilineTextAlignment(.leading)
            }
            .padding(14)
            .frame(width: Metrics.templateWidth, alignment: .leading)
            .cardSurface(corner: Metrics.galleryCorner)
            .contentShape(RoundedRectangle(cornerRadius: Metrics.galleryCorner, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.97))
        .disabled(busy)
        // A tap sends the template's prompt to the assistant: light, like a send (L186).
        .sensoryFeedback(.impact(weight: .light), trigger: taps)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(Text(template.title)), \(Text(template.subtitle))"))
        .accessibilityHint(Text("Makes it"))
    }
}

struct MakeEmptyLine: View {
    @ScaledMetric(relativeTo: .callout) private var textSize: CGFloat = 16

    var body: some View {
        VStack(spacing: 12) {
            DuetIcon(glyph: .artifact, size: 36, tint: Palette.secondaryText)
            Text("Everything OpenDuet makes shows up here")
                .font(.system(size: textSize))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
        .accessibilityElement(children: .combine)
    }
}

/// The gallery's first load in the chosen layout (M24): the chips' row, then two rows of grid
/// cards (title lines over a thumbnail cut by the card's edge) or five list rows, with a soft pulse.
struct GallerySkeleton: View {
    var layout: GalleryLayout = .grid

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                ForEach([54, 84, 64], id: \.self) { width in
                    Capsule().fill(Palette.skeleton).frame(width: CGFloat(width), height: 32)
                }
            }
            .padding(.bottom, 6)
            RoundedRectangle(cornerRadius: 8).fill(Palette.skeleton).frame(width: 150, height: 22)
            switch layout {
            case .grid: cards
            case .list: rows
            }
        }
        .skeletonPulse()
        .accessibilityElement()
        .accessibilityLabel(Text("Loading"))
    }

    private var cards: some View {
        Grid(horizontalSpacing: 12, verticalSpacing: 12) {
            ForEach(0..<2, id: \.self) { _ in
                GridRow {
                    ForEach(0..<2, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: 0) {
                            VStack(alignment: .leading, spacing: 8) {
                                RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(height: 15)
                                RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(width: 90, height: 15)
                                RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(width: 70, height: 11)
                            }
                            .padding(14)
                            UnevenRoundedRectangle(topLeadingRadius: 12, topTrailingRadius: 12, style: .continuous)
                                .fill(Palette.skeleton)
                                .aspectRatio(Metrics.galleryPeekAspect, contentMode: .fit)
                                .padding(.horizontal, 10)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: Metrics.galleryCorner, style: .continuous))
                        .cardSurface(corner: Metrics.galleryCorner)
                    }
                }
            }
        }
    }

    private var rows: some View {
        VStack(spacing: 10) {
            ForEach(0..<5, id: \.self) { _ in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 10).fill(Palette.skeleton).frame(width: 64, height: 64)
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(height: 14)
                        RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(width: 90, height: 11)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .cardSurface(corner: Metrics.galleryCorner)
            }
        }
    }
}
