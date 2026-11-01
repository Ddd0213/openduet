// M11: import skills into Everything. The preview lists every folder with a SKILL.md and saves
// nothing: pick some, then Import. Warnings show as quiet lines.
// M25 (W2): two modes, both under Settings › Skills › Add skill. `.github` is the GitHub link page
// (paste, then Preview; the old zip half went, Upload a skill replaces it). `.upload(url)` is
// Upload a skill: the file picked on the skills page is read off the main thread (at most 20 MB,
// a SKILL.md at most 1 MB) and sent to POST /api/skills/upload/preview under its own name; the
// same preview -> Import follows, 400 / 413 show inline, and "Choose another file" picks again.
import SwiftUI
import UniformTypeIdentifiers

struct SkillImportPage: View {
    enum Mode: Hashable, Sendable {
        case github
        /// a file picked in Files (security-scoped; read when the page opens)
        case upload(URL)
    }

    var model: EverythingModel
    var mode: Mode = .github
    var onBack: () -> Void
    var onImported: ([Skill]) -> Void

    private struct Loaded: Hashable {
        var preview: SkillImportPreview
        var selection: SkillImportSelection
    }

    /// The upload page's file: its name and, once read, its size.
    private struct PickedFile: Hashable {
        var url: URL
        var size: Int?
        var name: String { url.lastPathComponent }
    }

    @State private var link = ""
    @State private var previewing = false
    @State private var previewFailure: String?
    @State private var loaded: Loaded?
    @State private var file: PickedFile?
    @State private var choosingFile = false
    @State private var importing = false
    @State private var importFailure: String?

    private var githubURL: String? { SkillRules.githubURL(link) }
    private var busy: Bool { previewing || importing }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: title, leading: .back, onLeading: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 10) {
                        switch mode {
                        case .github: githubSource
                        case .upload: uploadSource
                        }
                        if let previewFailure {
                            SettingsReasonLine(reason: previewFailure)
                                .padding(.horizontal, 6)
                                .transition(.opacity)
                        }
                    }
                    .animation(.easeInOut(duration: 0.2), value: previewFailure)
                    .sensoryFeedback(.warning, trigger: previewFailure) { _, new in new != nil }
                    if let loaded {
                        SkillImportResults(
                            preview: loaded.preview, selection: loaded.selection,
                            importing: importing, failure: importFailure,
                            onToggle: { self.loaded?.selection.toggle($0) },
                            onImport: { importPicked() }
                        )
                        .transition(.opacity)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
                .animation(.easeInOut(duration: 0.2), value: loaded?.preview.importId)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: SkillUpload.contentTypes) { result in
            switch result {
            case .success(let url): readAndPreview(url)
            case .failure(let error): previewFailure = error.localizedDescription
            }
        }
        // The file picked on the skills page, once (not again when the page comes back).
        .task {
            if case .upload(let url) = mode, file == nil { readAndPreview(url) }
        }
    }

    private var title: Text {
        switch mode {
        case .github: Text("Import from GitHub")
        case .upload: Text("Upload a skill")
        }
    }

    private var githubSource: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardSection {
                SettingsField(
                    label: Text("GitHub link"), text: $link, prompt: Text(verbatim: "https://github.com/owner/repo"),
                    plain: true, keyboard: .URL, problem: linkProblem,
                    footnote: Text("A public repository, or a folder in one. Every folder with a SKILL.md is a skill.")
                )
            }
            .disabled(busy)
            HStack {
                Spacer(minLength: 0)
                CapsuleButton(title: Text("Preview"), busy: previewing, fullWidth: false) { previewGitHub() }
                    .disabled(githubURL == nil || busy)
            }
            .padding(.horizontal, 6)
        }
    }

    /// The picked file (name, size once read, a spinner while it is read and previewed), then
    /// "Choose another file".
    private var uploadSource: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardSection(dividerInset: Metrics.settingsTileInset) {
                SheetRow(
                    title: Text(verbatim: file?.name ?? ""),
                    subtitle: file?.size.map { Text(verbatim: ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file)) },
                    leading: { RowSymbol(systemImage: fileSymbol, tint: Palette.secondaryText) },
                    trailing: { BusySpinner(busy: previewing) }
                )
            }
            HStack {
                Spacer(minLength: 0)
                CapsuleButton(title: Text("Choose another file"), style: .outline, fullWidth: false) { choosingFile = true }
                    .disabled(busy)
            }
            .padding(.horizontal, 6)
        }
    }

    private var fileSymbol: String {
        switch file.flatMap({ SkillUpload.kind(forFileName: $0.name) }) {
        case .archive?: "doc.zipper"
        case .markdown?: "doc.text"
        case nil: "doc"
        }
    }

    private var linkProblem: Text? {
        let typed = link.trimmingCharacters(in: .whitespacesAndNewlines)
        return !typed.isEmpty && githubURL == nil ? Text("Paste a link to github.com.") : nil
    }

    private func previewGitHub() {
        guard let url = githubURL else { return }
        load(kind: nil) { try await model.previewGitHub(url) }
    }

    /// Upload a skill: the extension first (the picker also shows other files, so a `.skill` can
    /// be picked), then the bytes off the main thread, then the server's preview.
    private func readAndPreview(_ url: URL) {
        file = PickedFile(url: url)
        loaded = nil
        importFailure = nil
        guard let kind = SkillUpload.kind(forFileName: url.lastPathComponent) else {
            previewFailure = SkillUpload.wrongTypeLine
            return
        }
        previewing = true
        previewFailure = nil
        Task {
            let read = await Task.detached(priority: .userInitiated) { PickedUpload.read(url, kind: kind) }.value
            guard file?.url == url else { return }
            switch read {
            case .success(let upload):
                file?.size = upload.data.count
                load(kind: kind) { try await model.previewUpload(name: upload.name, mime: SkillUpload.mime(kind), data: upload.data) }
            case .failure(let problem):
                switch problem {
                case .tooLarge: previewFailure = SkillUpload.tooLargeLine(kind)
                case .empty: previewFailure = String(localized: "The file is empty.")
                case .unreadable: previewFailure = String(localized: "Couldn't read that file.")
                }
                previewing = false
            }
        }
    }

    /// `kind` nil = GitHub.
    private func load(kind: SkillUpload.Kind?, _ fetch: @escaping @MainActor () async throws -> SkillImportPreview) {
        previewing = true
        previewFailure = nil
        importFailure = nil
        Task {
            do {
                let preview = try await fetch()
                loaded = Loaded(preview: preview, selection: SkillImportSelection(preview))
            } catch {
                if mode == .github {
                    if case APIError.tooLarge = error {
                        previewFailure = String(localized: "That repository is over 20 MB.")
                    } else {
                        previewFailure = SettingsReason.line(for: error)
                    }
                } else {
                    previewFailure = SkillUpload.failureLine(for: error, kind: kind)
                }
            }
            previewing = false
        }
    }

    private func importPicked() {
        guard let loaded, let body = loaded.selection.request(importId: loaded.preview.importId, channelId: nil) else { return }
        importing = true
        importFailure = nil
        Task {
            do {
                let skills = try await model.importSkills(body)
                importing = false
                onImported(skills)
            } catch APIError.notFound {
                importFailure = String(localized: "This preview expired. Preview the skills again.")
                importing = false
            } catch {
                importFailure = SettingsReason.line(for: error)
                importing = false
            }
        }
    }
}

/// A file picked in Files for Upload a skill, read off the main thread (security-scoped while it's
/// read): a .zip / .skill up to 20 MB, a SKILL.md up to 1 MB.
struct PickedUpload: Sendable {
    enum Problem: Error, Hashable { case tooLarge, empty, unreadable }

    var name: String
    var data: Data

    static func read(_ url: URL, kind: SkillUpload.Kind) -> Result<PickedUpload, Problem> {
        let limit = SkillUpload.limit(kind)
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > limit {
            return .failure(.tooLarge)
        }
        guard let data = try? Data(contentsOf: url) else { return .failure(.unreadable) }
        guard !data.isEmpty else { return .failure(.empty) }
        guard data.count <= limit else { return .failure(.tooLarge) }
        return .success(PickedUpload(name: url.lastPathComponent, data: data))
    }
}
