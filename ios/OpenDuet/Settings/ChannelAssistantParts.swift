// M11: parts of a channel's OpenDuet sheet. Its activity (the channel's runs: RunsActivitySection
// only lists all of them, so the same rows on RunScope.channel here) and what it can use: skills,
// custom connectors and apps grouped by kind, each with a switch (optimistic, rolled back with
// the reason); an item on for all channels says so under its name.
import SwiftUI

struct ChannelActivitySection: View {
    var channelId: String
    var onOpenRun: (String) -> Void
    var onSeeAll: () -> Void

    @Environment(\.runs) private var runs

    private var scope: RunScope { .channel(channelId) }
    private var list: RunListState { runs.state.list(scope) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Activity"))
            switch TaskRunsChoice(list) {
            case .loading:
                RunRowsSkeleton(rows: 2)
            case .failed(let reason):
                InlineRetryLine(reason: reason) { runs.actions.loadList(scope) }
                    .cardSurface()
            case .empty:
                SettingsNote(text: Text("Nothing here yet. What OpenDuet does in this channel shows here."))
            case .single, .list:
                CardSection(dividerInset: Metrics.settingsTileInset) {
                    ForEach(list.runs.prefix(RunsActivitySection.limit)) { run in
                        RunRow(run: run) { onOpenRun(run.id) }
                    }
                    SheetRow(
                        title: Text("See all"), subtitle: nil, action: onSeeAll,
                        leading: { RowSymbol(systemImage: DuetGlyph.contents.symbol, tint: Palette.secondaryText) },
                        trailing: { RowChevron() }
                    )
                }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: list.phase)
        .onAppear { runs.actions.loadList(scope) }
    }
}

/// "Skills and connectors here": the channel's switches, one card per kind.
struct ChannelAccessSections: View {
    var model: ChannelSettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch model.access.display {
            case .loading:
                VStack(alignment: .leading, spacing: 0) {
                    SheetSectionTitle(text: Text("Skills"))
                    SettingsRowsSkeleton(rows: 3)
                }
            case .failed(let reason):
                InlineRetryLine(reason: reason) { Task { await model.loadAccess() } }
                    .cardSurface()
            case .loaded(let toggles) where toggles.items.isEmpty:
                SettingsNote(text: Text("No skills, connectors or apps yet. Add them in Everything's OpenDuet sheet; then you can turn each one on or off here."))
            case .loaded(let toggles):
                ForEach(toggles.sections, id: \.kind) { section in
                    VStack(alignment: .leading, spacing: 0) {
                        SheetSectionTitle(text: Text(section.kind.sectionTitle))
                        CardSection(dividerInset: Metrics.settingsTileInset) {
                            ForEach(section.items) { item in
                                ChannelAccessRow(item: item, toggles: toggles) { model.toggle(item, on: $0) }
                            }
                        }
                    }
                }
            }
        }
    }
}

struct ChannelAccessRow: View {
    var item: ChannelAccess.Item
    var toggles: AccessToggles
    var onChange: (Bool) -> Void

    var body: some View {
        SettingsToggleRow(
            title: item.kind == .skill ? Text(verbatim: "/" + item.name) : Text(verbatim: item.name),
            subtitle: subtitle,
            on: toggles.isOn(item),
            busy: toggles.isBusy(item),
            failure: toggles.failure(item),
            onChange: onChange
        ) {
            leading
        }
    }

    @ViewBuilder private var leading: some View {
        switch item.kind {
        case .skill: DuetIconTile(glyph: .skill, size: 32)
        case .connector: RowSymbol(systemImage: "cylinder.split.1x2", tint: Palette.secondaryText)
        case .app: IconTile(app: item.id, systemImage: "square.grid.2x2", size: 32)
        }
    }

    /// "All channels" for an item on everywhere by default; otherwise its description's first line.
    private var subtitle: Text? {
        if item.scope == .all { return Text("All channels") }
        let line = item.description.split(whereSeparator: \.isNewline).first.map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? ""
        return line.isEmpty ? nil : Text(verbatim: line)
    }
}
