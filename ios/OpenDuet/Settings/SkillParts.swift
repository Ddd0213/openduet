// M11: the skill page's files (scripts/, references/, assets/: text files open in a sheet, binary
// ones can't be shown) and its actions: Share with all channels, Export (the zip in the share
// sheet), Delete (asks in place).
import SwiftUI

struct SkillFilesSection: View {
    var model: EverythingModel
    var skill: Skill

    private struct OpenFile: Identifiable, Hashable {
        var path: String
        var id: String { path }
    }

    @State private var open: OpenFile?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Files"))
            CardSection(dividerInset: Metrics.settingsTileInset) {
                row(path: "SKILL.md", detail: Text("The instructions above"), action: nil)
                ForEach(skill.files, id: \.path) { file in
                    row(
                        path: file.path,
                        detail: file.text
                            ? Text(verbatim: ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                            : Text("\(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)) · Can't be shown"),
                        action: file.text ? { open = OpenFile(path: file.path) } as (() -> Void)? : nil
                    )
                }
            }
        }
        .sheet(item: $open) { file in
            SkillFileSheet(model: model, skillId: skill.id, path: file.path) { open = nil }
                .duetSheetChrome()
                .presentationDetents([.large])
        }
    }

    private func row(path: String, detail: Text, action: (() -> Void)?) -> some View {
        SheetRow(title: Text(verbatim: path), subtitle: detail, action: action) {
            RowSymbol(systemImage: path.hasSuffix(".md") ? "doc.text" : "doc", tint: Palette.secondaryText)
        } trailing: {
            if action != nil { RowChevron() }
        }
    }
}

/// A text file of a skill, read-only (GET /api/skills/:id/files/<path>).
struct SkillFileSheet: View {
    var model: EverythingModel
    var skillId: String
    var path: String
    var onClose: () -> Void

    @State private var content = Loadable<SkillFileContent>()
    @ScaledMetric(relativeTo: .body) private var codeSize: CGFloat = 13.5

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text(verbatim: path), leading: .close, onLeading: onClose)
            ScrollView {
                Group {
                    switch content.display {
                    case .loading:
                        MemorySkeleton()
                    case .failed(let reason):
                        InlineRetryLine(reason: reason) { Task { await load() } }
                    case .loaded(let file):
                        Text(verbatim: file.text)
                            .font(.system(size: codeSize, design: .monospaced))
                            .foregroundStyle(Palette.primaryText)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .cardSurface()
                    }
                }
                .padding(16)
            }
            .scrollIndicators(.hidden)
        }
        .task { await load() }
    }

    private func load() async {
        content.begin()
        do {
            content.finish(try await model.skillFile(skillId, path: path))
        } catch {
            if let reason = SettingsReason.line(for: error) { content.fail(reason) } else { content.loading = false }
        }
    }
}

struct SkillActionsSection: View {
    var model: EverythingModel
    var skill: Skill
    var onDeleted: () -> Void

    @State private var sharing = false
    @State private var shareFailure: String?
    @State private var exporting = false
    @State private var exportFailure: String?
    @State private var exportFile: ShareFile?
    @State private var deleting = false
    @State private var deleteFailure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardSection(dividerInset: Metrics.settingsTileInset) {
                scopeRow
                exportRow
            }
            if let reason = shareFailure ?? exportFailure {
                SettingsReasonLine(reason: reason).padding(.horizontal, 6)
            }
            deleteRow
        }
        .animation(.easeInOut(duration: 0.2), value: skill.scope == .all)
        .sheet(item: $exportFile) { file in
            ActivitySheet(items: [file.url])
                .presentationDetents([.medium, .large])
                .onDisappear { try? FileManager.default.removeItem(at: file.url) }
        }
    }

    private var shareAction: (() -> Void)? {
        sharing ? nil : { share() }
    }

    private var exportAction: (() -> Void)? {
        exporting ? nil : { export() }
    }

    @ViewBuilder private var scopeRow: some View {
        if skill.scope == .channels {
            let count = skill.channelIds.count
            SheetRow(
                title: Text("Share with all channels"),
                subtitle: Text(ScopeLabel.text(scope: .channels, channelCount: count)),
                action: shareAction,
                leading: { RowSymbol(systemImage: "square.stack.3d.up", tint: Palette.secondaryText) },
                trailing: { BusySpinner(busy: sharing) }
            )
        } else {
            SheetRow(
                title: Text("On in all channels"),
                subtitle: Text("A channel can still turn it off in its OpenDuet sheet."),
                action: nil,
                leading: { RowSymbol(systemImage: "square.stack.3d.up", tint: Palette.secondaryText) },
                trailing: { EmptyView() }
            )
        }
    }

    private var exportRow: some View {
        SheetRow(
            title: Text("Export"),
            subtitle: Text("The folder as a zip"),
            action: exportAction,
            leading: { RowSymbol(systemImage: "square.and.arrow.up", tint: Palette.secondaryText) },
            trailing: { BusySpinner(busy: exporting) }
        )
    }

    private var deleteRow: some View {
        InlineConfirm(
            title: Text("Delete skill"),
            question: Text("Delete /\(skill.name)? OpenDuet can't use it in any channel after this."),
            confirmTitle: Text("Delete"),
            busy: deleting,
            failure: deleteFailure,
            onConfirm: { delete() }
        )
        .cardSurface()
    }

    private func share() {
        sharing = true
        shareFailure = nil
        Task {
            do { try await model.shareSkillWithAll(skill.id) } catch { shareFailure = SettingsReason.line(for: error) }
            sharing = false
        }
    }

    private func export() {
        exporting = true
        exportFailure = nil
        Task {
            do {
                if let file = try await model.exportSkill(skill) {
                    exportFile = file
                } else {
                    exportFailure = String(localized: "Couldn't save the zip on this iPhone.")
                }
            } catch {
                exportFailure = SettingsReason.line(for: error)
            }
            exporting = false
        }
    }

    private func delete() {
        deleting = true
        deleteFailure = nil
        Task {
            do {
                try await model.deleteSkill(skill.id)
                onDeleted()
            } catch {
                deleteFailure = SettingsReason.line(for: error)
            }
            deleting = false
        }
    }
}
