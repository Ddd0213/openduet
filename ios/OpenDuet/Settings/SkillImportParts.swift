// M11: what an import preview found: one row per folder with a SKILL.md (checkbox, name,
// description, the excerpt, its file paths, "Has scripts…" and "Replaces your skill"), the
// server's warnings as quiet lines, and Import with how many are picked.
import SwiftUI

struct SkillImportResults: View {
    var preview: SkillImportPreview
    var selection: SkillImportSelection
    var importing: Bool
    var failure: String?
    var onToggle: (String) -> Void
    var onImport: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SheetSectionTitle(text: preview.skills.count == 1 ? Text("1 skill found") : Text("\(preview.skills.count) skills found"))
            if let url = preview.sourceUrl, !url.isEmpty {
                SettingsNote(text: Text(verbatim: url)).lineLimit(2)
            }
            if preview.skills.isEmpty {
                SettingsNote(text: Text("No folder with a SKILL.md was found."))
            } else {
                CardSection(dividerInset: 16 + 24 + 12) {
                    ForEach(preview.skills) { candidate in
                        SkillCandidateRow(
                            candidate: candidate,
                            picked: selection.isPicked(candidate.name),
                            enabled: !importing && selection.canPick(candidate.name),
                            onToggle: { onToggle(candidate.name) }
                        )
                    }
                }
            }
            ForEach(Array(preview.warnings.enumerated()), id: \.offset) { _, warning in
                SettingsNote(text: Text(verbatim: warning))
            }
            if !preview.skills.isEmpty {
                SettingsSaveRow(
                    title: Text("Import"), busy: importing, enabled: selection.count > 0, saved: false,
                    failure: failure, status: status, onSave: onImport
                )
                .padding(.top, 4)
            }
        }
    }

    private var status: Text {
        if selection.count >= SkillImportSelection.maxPerImport, preview.skills.count > SkillImportSelection.maxPerImport {
            return Text("\(SkillImportSelection.maxPerImport) at a time")
        }
        return Text("\(selection.count) of \(preview.skills.count) picked")
    }
}

/// One candidate: the whole row toggles it.
struct SkillCandidateRow: View {
    var candidate: SkillImportPreview.Candidate
    var picked: Bool
    var enabled: Bool
    var onToggle: () -> Void

    @ScaledMetric(relativeTo: .body) private var nameSize: CGFloat = 15.5
    @ScaledMetric(relativeTo: .footnote) private var textSize: CGFloat = 13.5
    @ScaledMetric(relativeTo: .caption) private var metaSize: CGFloat = 12.5
    @ScaledMetric(relativeTo: .body) private var boxSize: CGFloat = 24

    var body: some View {
        Button(action: onToggle) {
            HStack(alignment: .top, spacing: 12) {
                HandCheckbox(checked: picked, size: boxSize)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: "/" + candidate.name)
                        .font(.system(size: nameSize, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Palette.primaryText)
                    if !candidate.description.isEmpty {
                        Text(verbatim: candidate.description)
                            .font(.system(size: textSize))
                            .foregroundStyle(Palette.primaryText)
                            .lineLimit(3)
                    }
                    if !candidate.excerpt.isEmpty {
                        Text(verbatim: candidate.excerpt)
                            .font(.system(size: metaSize, design: .monospaced))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(3)
                    }
                    if let files = filesLine {
                        files
                            .font(.system(size: metaSize, design: .monospaced))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                    if candidate.hasScripts {
                        Text("Has scripts: they run on OpenDuet's computer and ask the first time")
                            .font(.system(size: metaSize, weight: .medium))
                            .foregroundStyle(Palette.secondaryText)
                    }
                    if candidate.exists {
                        Text("Replaces your skill")
                            .font(.system(size: metaSize, weight: .semibold))
                            .foregroundStyle(Palette.needsInput)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
            .opacity(enabled || picked ? 1 : 0.5)
        }
        .buttonStyle(RowPressStyle())
        .disabled(!enabled)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
        .sensoryFeedback(.selection, trigger: picked)
    }

    /// The folder's files after SKILL.md (paths as the server lists them); nothing when it's alone.
    private var filesLine: Text? {
        guard !candidate.files.isEmpty else { return nil }
        return Text(verbatim: (["SKILL.md"] + candidate.files.map(\.path)).joined(separator: ", "))
    }
}
