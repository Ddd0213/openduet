// M11: a skill in Everything's library: where it came from and where it's on, the description
// and instructions editor (PATCH, only what changed), its files (text files open), and Share with
// all channels, Export (share sheet with the zip) and Delete (asks in place).
import SwiftUI

struct SkillDetailPage: View {
    var model: EverythingModel
    var skillId: String
    var onBack: () -> Void

    @State private var description = ""
    @State private var instructions = ""
    @State private var base: Skill?
    @State private var busy = false
    @State private var failure: String?
    @State private var saved = false
    /// kept while the page pops after Delete (the skill is gone from the list by then)
    @State private var last: Skill?
    @ScaledMetric(relativeTo: .footnote) private var metaSize: CGFloat = 13.5

    private var skill: Skill? { model.skills.value?.first { $0.id == skillId } ?? last }
    private var dirty: Bool {
        base.map { SkillRules.update(description: description, instructions: instructions, saved: $0) != nil } ?? false
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: skill.map { Text(verbatim: "/" + $0.name) }, leading: .back, onLeading: onBack)
            ScrollView {
                if let skill {
                    content(skill)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 32)
                } else {
                    MemorySkeleton().padding(16)
                }
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .onChange(of: skill, initial: true) { _, skill in
            guard let skill else { return }
            last = skill
            guard !dirty else { return }
            description = skill.description
            instructions = skill.instructions
            base = skill
        }
        .onChange(of: description) { _, _ in if dirty { saved = false } }
        .onChange(of: instructions) { _, _ in if dirty { saved = false } }
    }

    private func content(_ skill: Skill) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: SkillMeta.line(skill))
                    .font(.system(size: metaSize, weight: .medium))
                    .foregroundStyle(Palette.secondaryText)
                if let url = skill.sourceUrl, !url.isEmpty {
                    Text(verbatim: url)
                        .font(.system(size: metaSize - 1))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
                if skill.hasScripts {
                    // M25: an uploaded skill's note is the zip / GitHub one.
                    SettingsNote(text: skill.source.scriptsAskFirst
                        ? Text("Its scripts run on OpenDuet's computer and ask you the first time each version runs.")
                        : Text("Its scripts run on OpenDuet's computer."))
                        .padding(.horizontal, -6)
                }
            }
            .padding(.horizontal, 6)
            .padding(.top, 4)
            VStack(alignment: .leading, spacing: 10) {
                CardSection {
                    SettingsField(
                        label: Text("Description"), text: $description,
                        prompt: Text("When OpenDuet should use it"), limit: SkillRules.descriptionLimit, lines: 1...5
                    )
                    SettingsField(
                        label: Text("Instructions"), text: $instructions,
                        prompt: Text("What OpenDuet follows when it uses this skill"),
                        limit: SkillRules.instructionsLimit, lines: 4...16, monospaced: true
                    )
                }
                .disabled(busy)
                SettingsSaveRow(
                    busy: busy, enabled: dirty && SkillRules.isValidEdit(description: description, instructions: instructions),
                    saved: saved && !dirty, failure: failure, status: nil, onSave: save
                )
            }
            SkillFilesSection(model: model, skill: skill)
            SkillActionsSection(model: model, skill: skill, onDeleted: onBack)
        }
    }

    private func save() {
        guard let base, let body = SkillRules.update(description: description, instructions: instructions, saved: base) else { return }
        let sent = (description, instructions)
        busy = true
        failure = nil
        Task {
            do {
                try await model.updateSkill(skillId, body)
                if let skill = model.skills.value?.first(where: { $0.id == skillId }) {
                    self.base = skill
                    if (description, instructions) == sent {
                        description = skill.description
                        instructions = skill.instructions
                    }
                }
                saved = true
            } catch {
                failure = SettingsReason.line(for: error)
            }
            busy = false
        }
    }
}
