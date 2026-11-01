// Skills (prompt L156): the "/name" pill, the dismissed proposal's grey line, the "View skill"
// sheet (instructions), and the composer's "/" list (skeleton rows, failure with Retry, "no
// skills yet", no matches) with the chosen skill's chip. M11: the library row of Everything
// (the library pages themselves are in Settings/).
import SwiftUI

/// "/my-writing-style" in a soft purple capsule.
struct SkillNamePill: View {
    var name: String
    var size: CGFloat = 15

    var body: some View {
        Text(verbatim: "/" + name)
            .font(.system(size: size, weight: .semibold, design: .monospaced))
            .foregroundStyle(Palette.makePurple)
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().fill(Palette.makePurple.opacity(0.12)))
    }
}

/// Not now, collapsed: "/name · Not now", tap to show the card again.
struct SkillDismissedLine: View {
    var name: String
    var onExpand: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14

    var body: some View {
        Button(action: onExpand) {
            HStack(spacing: 8) {
                DuetIcon(glyph: .skill, size: fontSize + 2, tint: Palette.secondaryText)
                Text(verbatim: "/" + name).lineLimit(1)
                Text(verbatim: "·").accessibilityHidden(true)
                Text("Not now").fixedSize()
                Spacer(minLength: 4)
                Image(systemName: "chevron.down").font(.system(size: fontSize - 2, weight: .semibold)).accessibilityHidden(true)
            }
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.secondaryText)
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface(corner: 14)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Shows the card"))
    }
}

/// "View skill ›": the name, description and the instructions the assistant would follow.
struct SkillDetailSheet: View {
    var name: String
    var description: String
    var instructions: String
    var onClose: () -> Void

    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text(verbatim: "/" + name), leading: .close, onLeading: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !description.isEmpty {
                        Text(verbatim: description)
                            .font(.system(size: bodySize))
                            .foregroundStyle(Palette.primaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    SheetSectionTitle(text: Text("Instructions"))
                    Text(verbatim: instructions)
                        .font(.system(size: bodySize - 1))
                        .foregroundStyle(Palette.primaryText)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .cardSurface()
                }
                .padding(20)
            }
        }
    }
}

/// The composer's "/" list: above the composer, filtered by what follows the slash.
struct SkillPicker: View {
    var extras: ChatExtrasState
    var query: String
    var onPick: (Skill) -> Void
    var onRetry: () -> Void

    @ScaledMetric(relativeTo: .body) private var nameSize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var descriptionSize: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var noteSize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxHeight: 260)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Palette.floatingSurface)
                .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                .floatingShadow()
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Skills"))
    }

    @ViewBuilder
    private var content: some View {
        if let skills = extras.skills {
            let matches = SkillQuery.filter(skills, query: query)
            if skills.isEmpty {
                note(Text("No skills yet. When OpenDuet offers to save one, it shows up here."))
            } else if matches.isEmpty {
                note(Text("No skills match \"/\(query)\""))
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(matches) { skill in row(skill) }
                    }
                    .padding(.vertical, 6)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        } else if let reason = extras.skillsFailure {
            InlineFailure(reason: reason, onRetry: onRetry, onEdit: nil).padding(14)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(0..<3, id: \.self) { index in
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: index == 1 ? 110 : 140, height: 13)
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: index == 1 ? 200 : 170, height: 10)
                    }
                }
            }
            .skeletonPulse()
            .padding(16)
            .accessibilityElement()
            .accessibilityLabel(Text("Loading"))
        }
    }

    private func row(_ skill: Skill) -> some View {
        Button { onPick(skill) } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "/" + skill.name)
                    .font(.system(size: nameSize, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(1)
                if !skill.description.isEmpty {
                    Text(verbatim: skill.description)
                        .font(.system(size: descriptionSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .accessibilityElement(children: .combine)
    }

    private func note(_ text: Text) -> some View {
        text
            .font(.system(size: noteSize))
            .foregroundStyle(Palette.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            .padding(16)
    }
}

/// M11: a skill in Everything's library: "/name", its description, then where it came from,
/// where it's on and whether it has scripts (SkillMeta).
struct SkillLibraryRow: View {
    var skill: Skill
    var onOpen: () -> Void

    @ScaledMetric(relativeTo: .body) private var nameSize: CGFloat = 15.5
    @ScaledMetric(relativeTo: .footnote) private var descriptionSize: CGFloat = 13.5
    @ScaledMetric(relativeTo: .caption) private var metaSize: CGFloat = 12.5

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                DuetIconTile(glyph: .skill, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: "/" + skill.name)
                        .font(.system(size: nameSize, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                    if !skill.description.isEmpty {
                        Text(verbatim: skill.description)
                            .font(.system(size: descriptionSize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    Text(verbatim: SkillMeta.line(skill))
                        .font(.system(size: metaSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                RowChevron()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: Metrics.sheetRowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityElement(children: .combine)
    }
}

/// The chosen skill in the composer: "/name ✕".
struct SkillChip: View {
    var name: String
    var onRemove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            SkillNamePill(name: name, size: 14)
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.9))
            .accessibilityLabel(Text("Remove skill /\(name)"))
        }
    }
}
