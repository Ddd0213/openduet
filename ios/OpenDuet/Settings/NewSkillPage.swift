// M11: a new skill written in Everything (POST /api/skills: name, description, instructions;
// no channelId, so it's on in every channel). The name is a skill name (lowercase, digits,
// dashes): a typed title gets the suggested form; a name that exists is replaced on save.
// M25: no longer an entry on Settings › Skills (Add skill: Create with OpenDuet, Upload a skill,
// Import from GitHub); a saved skill is still edited on SkillDetailPage. Kept for its preview.
import SwiftUI

struct NewSkillPage: View {
    var model: EverythingModel
    var onBack: () -> Void
    var onCreated: (Skill) -> Void

    @State private var name = ""
    @State private var description = ""
    @State private var instructions = ""
    @State private var busy = false
    @State private var failure: String?

    private var cleanName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var nameIsValid: Bool { SkillRules.isValidName(cleanName) }
    private var exists: Bool { model.skills.value?.contains { $0.name == cleanName } ?? false }
    private var canCreate: Bool {
        nameIsValid && SkillRules.isValidEdit(description: description, instructions: instructions)
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("New skill"), leading: .back, onLeading: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    CardSection {
                        SettingsField(
                            label: Text("Skill name"), text: $name, prompt: Text(verbatim: "my-writing-style"),
                            monospaced: true, plain: true,
                            problem: nameProblem, footnote: nameFootnote
                        )
                        SettingsField(
                            label: Text("Description"), text: $description,
                            prompt: Text("When OpenDuet should use it"), limit: SkillRules.descriptionLimit, lines: 1...5
                        )
                        SettingsField(
                            label: Text("Instructions"), text: $instructions,
                            prompt: Text("What OpenDuet follows when it uses this skill"),
                            limit: SkillRules.instructionsLimit, lines: 6...16, monospaced: true
                        )
                    }
                    .disabled(busy)
                    SettingsSaveRow(
                        title: Text("Create"), busy: busy, enabled: canCreate, saved: false,
                        failure: failure, status: Text("On in all channels"), onSave: create
                    )
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    /// Only once something is typed: a name that isn't a skill name, with the form it could take.
    private var nameProblem: Text? {
        guard !cleanName.isEmpty, !nameIsValid else { return nil }
        if let suggestion = SkillRules.suggestedName(cleanName), suggestion != cleanName {
            return Text("Lowercase letters, digits and dashes only. Try \(suggestion)")
        }
        return Text("Lowercase letters, digits and dashes only.")
    }

    private var nameFootnote: Text {
        if cleanName.isEmpty { return Text("Lowercase letters, digits and dashes only.") }
        if exists { return Text("A skill with this name exists. Saving replaces it.") }
        return Text("Use it by typing /\(cleanName) in a message.")
    }

    private func create() {
        guard canCreate else { return }
        let body = CreateSkillRequest(
            name: cleanName,
            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
            instructions: instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        busy = true
        failure = nil
        Task {
            do {
                let skill = try await model.createSkill(body)
                busy = false
                onCreated(skill)
            } catch {
                failure = SettingsReason.line(for: error)
                busy = false
            }
        }
    }
}
