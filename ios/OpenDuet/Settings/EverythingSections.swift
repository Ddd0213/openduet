// M11: the Everything sheet's root sections: Who OpenDuet is and About you, the channels (from
// GET /api/memory/overview: purpose, the latest line, how many facts) and, at the end, the line
// that points to the settings. A channel opens its memory read-only (ChannelMemoryReadPage).
// M16: the skills library moved to the settings (the profile sheet): its row, its page and the
// library section live here too. M22: the settings' Setup, Language and Appearance rows.
import SwiftUI
import UIKit

struct EverythingAboutSection: View {
    var model: EverythingModel
    var onOpen: (EverythingSheet.Page) -> Void

    var body: some View {
        CardSection(dividerInset: Metrics.settingsTileInset) {
            SheetRow(title: Text("Who OpenDuet is"), subtitle: soulLine, action: { onOpen(.soul) }) {
                RowSymbol(systemImage: "sparkle", tint: Palette.secondaryText)
            } trailing: {
                RowChevron()
            }
            SheetRow(title: Text("About you"), subtitle: aboutLine, action: { onOpen(.aboutYou) }) {
                RowSymbol(systemImage: "book.closed", tint: Palette.secondaryText)
            } trailing: {
                RowChevron()
            }
        }
    }

    private var soulLine: Text? {
        guard let soul = model.soul.value else { return nil }
        return SoulDraft.summary(soul).map { Text(verbatim: $0) } ?? Text("Not set yet")
    }

    private var aboutLine: Text? {
        guard let memory = model.aboutYou.state.value else { return nil }
        switch memory.facts.count {
        case 0: return memory.document.isEmpty ? Text("Nothing saved yet") : Text("Notes, no facts yet")
        case 1: return Text("1 fact")
        case let count: return Text("\(count) facts")
        }
    }
}

struct EverythingChannelsSection: View {
    var model: EverythingModel
    var onOpen: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Channels"))
            switch model.overview.display {
            case .loading:
                SettingsRowsSkeleton(rows: 2)
            case .failed(let reason):
                InlineRetryLine(reason: reason) { Task { await model.loadOverview() } }
                    .cardSurface()
            case .loaded(let rows) where rows.isEmpty:
                SettingsNote(text: Text("No channels yet. Each channel keeps its own memory; you'll see them here."))
            case .loaded(let rows):
                CardSection(dividerInset: Metrics.settingsTileInset) {
                    ForEach(rows) { row in
                        EverythingChannelRow(row: row) { onOpen(row.id) }
                    }
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.overview.value?.map(\.id))
    }
}

struct EverythingChannelRow: View {
    var row: ChannelOverviewRow
    var onOpen: () -> Void

    @ScaledMetric(relativeTo: .body) private var glyphSize: CGFloat = 22

    var body: some View {
        SheetRow(title: Text(verbatim: "#" + row.summary.name), subtitle: subtitle, action: onOpen) {
            Group {
                if let channel = row.channel {
                    ChannelGlyph(icon: channel.icon, color: channel.colorHex, size: glyphSize)
                } else {
                    RowSymbol(systemImage: "bubble.left", tint: Palette.secondaryText)
                }
            }
            .frame(width: 32, height: 32)
            .accessibilityHidden(true)
        } trailing: {
            HStack(spacing: 8) {
                factCount
                RowChevron()
            }
        }
        // M21: the subtitle (purpose, then the latest line) takes at most 3 lines, so a long server
        // text can't widen or stretch the OpenDuet sheet (the name has the same cap).
        .lineLimit(3)
    }

    /// The purpose, then the assistant's latest line there (cut by the server to 160 characters).
    private var subtitle: Text? {
        let parts = [row.summary.purpose, row.summary.recent ?? ""]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : Text(verbatim: parts.joined(separator: "\n"))
    }

    @ViewBuilder private var factCount: some View {
        let count = row.summary.factCount
        if count > 0 {
            (count == 1 ? Text("1 fact") : Text("\(count) facts"))
                .font(.footnote.monospacedDigit())
                .foregroundStyle(Palette.secondaryText)
        }
    }
}

/// M16: the settings' "Skills" row: how many skills the library has.
struct SettingsSkillsRow: View {
    var model: EverythingModel
    var onOpen: () -> Void

    var body: some View {
        SheetRow(title: Text("Skills"), subtitle: line, action: onOpen) {
            RowSymbol(systemImage: "sparkles")
        } trailing: {
            RowChevron()
        }
    }

    private var line: Text? {
        guard let count = model.skills.value?.count, count > 0 else { return nil }
        return count == 1 ? Text("1 skill") : Text("\(count) skills")
    }
}

/// M22 (#47): the settings' "Setup" row: what this iPhone and the server have set up.
struct SettingsSetupRow: View {
    var onOpen: () -> Void

    var body: some View {
        SheetRow(title: Text("Setup"), action: onOpen) {
            RowSymbol(systemImage: DuetGlyph.notSetUp.symbol)
        } trailing: {
            RowChevron()
        }
    }
}

/// M22: "Language": the app's language in its own name; a tap opens iOS's page for the app,
/// where its Language is picked (prompt L87; iOS restarts the app). No language table here.
struct SettingsLanguageRow: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        let name = AppLanguageRow.name(AppLanguageRow.current(Bundle.main.preferredLocalizations))
        SheetRow(title: Text("Language"), subtitle: Text(verbatim: name), action: open) {
            RowSymbol(systemImage: "globe")
        } trailing: {
            Image(systemName: DuetGlyph.update.symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.secondaryText)
                .accessibilityHidden(true)
        }
        .accessibilityHint(Text("Opens iOS Settings"))
    }

    private func open() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}

/// M22: "Appearance": System (default) / Light / Dark, stored with @AppStorage; the app's window
/// follows it (App/OpenDuetApp.swift). The choices open in place under the row, like the
/// other choice rows (never a menu).
struct SettingsAppearanceRow: View {
    @AppStorage(AppearanceChoice.storageKey) private var stored = AppearanceChoice.system.rawValue
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var open = false
    @ScaledMetric(relativeTo: .body) private var valueSize: CGFloat = 15
    @ScaledMetric(relativeTo: .body) private var optionSize: CGFloat = 15.5

    private var choice: AppearanceChoice { AppearanceChoice(stored: stored) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetRow(title: Text("Appearance"), action: { open.toggle() }) {
                RowSymbol(systemImage: "paintbrush")
            } trailing: {
                HStack(spacing: 8) {
                    Text(choice.label)
                        .font(.system(size: valueSize))
                        .foregroundStyle(Palette.secondaryText)
                    RowChevron().rotationEffect(.degrees(open ? 90 : 0))
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityValue(Text(choice.label))
            .accessibilityHint(open ? Text("Hides the choices") : Text("Shows the choices"))
            if open {
                VStack(spacing: 0) {
                    ForEach(AppearanceChoice.allCases, id: \.self) { option in
                        optionRow(option)
                    }
                }
                .padding(.bottom, 6)
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.86), value: open)
        .sensoryFeedback(.selection, trigger: stored)
    }

    private func optionRow(_ option: AppearanceChoice) -> some View {
        let picked = option == choice
        return Button {
            open = false
            if !picked { stored = option.rawValue }
        } label: {
            HStack(spacing: 12) {
                Text(option.label)
                    .font(.system(size: optionSize, weight: picked ? .semibold : .regular))
                    .foregroundStyle(Palette.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if picked {
                    DuetIcon(glyph: .check, size: 17, tint: Palette.accent)
                }
            }
            .padding(.leading, Metrics.settingsTileInset)
            .padding(.trailing, 16)
            .padding(.vertical, 9)
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
    }
}

/// M16: Settings › Skills. M25 (W2): a capsule "+ Add skill" on top (a system Menu: Create with
/// the assistant, Upload a skill, Import from GitHub), then the user's skills; a tap still opens the
/// detail page. Upload a skill opens Files at once; the picked file goes to the upload page.
struct SkillsPage: View {
    var model: EverythingModel
    var onOpen: (String) -> Void
    var onCreateWithAssistant: () -> Void
    var onUpload: (URL) -> Void
    var onGitHub: () -> Void
    var onBack: () -> Void

    @State private var choosingFile = false
    @State private var pickFailure: String?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Skills"), leading: .back, onLeading: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    SkillAddMenu(onPick: pick)
                    if let pickFailure {
                        SettingsReasonLine(reason: pickFailure)
                            .padding(.horizontal, 6)
                            .transition(.opacity)
                    }
                    SkillLibrarySection(model: model, onOpen: onOpen)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
                .animation(.easeInOut(duration: 0.2), value: pickFailure)
            }
            .scrollIndicators(.hidden)
            .refreshable { await model.loadSkills() }
        }
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: SkillUpload.contentTypes) { result in
            switch result {
            case .success(let url): onUpload(url)
            case .failure(let error): pickFailure = error.localizedDescription
            }
        }
    }

    private func pick(_ entry: SkillAddEntry) {
        pickFailure = nil
        switch entry {
        case .createWithAssistant: onCreateWithAssistant()
        case .upload: choosingFile = true
        case .github: onGitHub()
        }
    }
}

/// "+ Add skill": an outline capsule that opens the system Menu of SkillAddEntry.
struct SkillAddMenu: View {
    var onPick: (SkillAddEntry) -> Void

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 16

    var body: some View {
        Menu {
            ForEach(SkillAddEntry.allCases, id: \.self) { entry in
                Button { onPick(entry) } label: {
                    Label { Text(entry.title) } icon: { Image(systemName: entry.symbol) }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus").font(.system(size: fontSize - 1, weight: .semibold))
                Text("Add skill").font(.system(size: fontSize, weight: .semibold)).lineLimit(1)
            }
            .foregroundStyle(Palette.primaryText)
            .padding(.horizontal, 18)
            .frame(minHeight: 44)
            .background { Capsule().strokeBorder(Palette.outline, lineWidth: 1) }
            .contentShape(Capsule())
        }
        .menuOrder(.fixed)
        .accessibilityLabel(Text("Add skill"))
    }
}

/// The user's skills; with none, the puzzle piece and "No skills yet".
struct SkillLibrarySection: View {
    var model: EverythingModel
    var onOpen: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch model.skills.display {
            case .loading:
                SettingsRowsSkeleton(rows: 2)
            case .failed(let reason):
                InlineRetryLine(reason: reason) { Task { await model.loadSkills() } }
                    .cardSurface()
            case .loaded(let skills) where skills.isEmpty:
                EmptyStateView(systemImage: "puzzlepiece.extension", message: "No skills yet")
                    .padding(.top, 56)
                    .transition(.opacity)
            case .loaded(let skills):
                CardSection(dividerInset: Metrics.settingsTileInset) {
                    ForEach(skills) { skill in
                        SkillLibraryRow(skill: skill) { onOpen(skill.id) }
                    }
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.skills.value?.map(\.id))
    }
}

/// A channel's own memory seen from Everything: read-only, with "Open channel" (its facts link to
/// the channel's thread). Holds its model so a redraw of the sheet doesn't reload it.
struct ChannelMemoryReadPage: View {
    var row: ChannelOverviewRow?
    var channelId: String
    var onOpen: (URL) -> Void
    var onBack: () -> Void

    @State private var model: MemoryLayerModel

    init(row: ChannelOverviewRow?, channelId: String, onOpen: @escaping (URL) -> Void, onBack: @escaping () -> Void) {
        self.row = row
        self.channelId = channelId
        self.onOpen = onOpen
        self.onBack = onBack
        _model = State(initialValue: MemoryLayerModel(layer: .channel(channelId)))
    }

    var body: some View {
        MemoryPage(
            model: model,
            title: row.map { Text(verbatim: "#" + $0.summary.name) } ?? Text("Memory"),
            intro: intro,
            readOnly: true,
            linkChannelId: channelId,
            onOpenChannel: onOpen,
            onBack: onBack
        )
    }

    private var intro: Text {
        if row?.summary.useSharedMemory == false {
            return Text("This channel's own memory. It doesn't use About you. Change it in the channel's OpenDuet sheet.")
        }
        return Text("This channel's own memory, next to About you. Change it in the channel's OpenDuet sheet.")
    }
}

/// M16: the OpenDuet sheet's last line: models, voice, apps and skills are set up in the settings
/// (the profile sheet); a tap opens them.
struct SettingsHintLine: View {
    var onOpen: () -> Void

    @ScaledMetric(relativeTo: .footnote) private var size: CGFloat = 13.5

    var body: some View {
        Button(action: onOpen) {
            (Text("Models, voice, apps and skills are in your profile.").foregroundStyle(Palette.secondaryText)
                + Text(verbatim: " ")
                + Text("Open profile").foregroundStyle(Palette.accent).fontWeight(.semibold))
                .font(.system(size: size))
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
