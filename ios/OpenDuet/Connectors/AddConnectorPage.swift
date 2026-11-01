// M17 "Add connector" (Settings › Apps and connectors): the MCP Registry's templates first, a
// search field ("Search MCP servers", ~300 ms debounce, ?query=), "Featured" in the server's order,
// then "Add your own" (Add manually: the M11 form; Paste a config) and the registry footnote, then
// the rest of the registry, read on with nextCursor as the list scrolls. Add: a template without
// required inputs installs at once, one with inputs opens a small sheet; an install that asks for
// sign-in opens the system's web sign-in right away. "Added" rows open their connector. The
// registry down: the reason in grey with Retry; a search with no hits: "No servers match".
import SwiftUI

struct AddConnectorPage: View {
    var model: EverythingModel
    var onBack: () -> Void
    /// installed (and signed in when it signs in): success haptic, then its page
    var onAdded: (CustomConnector) -> Void
    /// a connector page without the haptic ("Added" rows, a sign-in the user closed)
    var onOpen: (String) -> Void = { _ in }
    var onAddManually: () -> Void = {}
    var onPasteConfig: () -> Void = {}

    @State private var gallery = TemplateGallery()
    @State private var query = ""
    @State private var reloads = 0
    /// the last (query, reloads) a first page was asked for: typing debounces, Retry doesn't
    @State private var lastKey: LoadKey?
    @State private var installing: String?
    @State private var rowFailures: [String: String] = [:]
    @State private var form: ConnectorTemplate?
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    private struct LoadKey: Hashable {
        var query: String
        var reloads: Int
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Add connector"), leading: .back, onLeading: onBack)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    TemplateSearchField(query: $query, busy: gallery.searching)
                    if gallery.query.isEmpty {
                        browsing
                    } else {
                        searching
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
                .animation(.easeInOut(duration: 0.2), value: gallery.phase)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .task(id: LoadKey(query: TemplateGallery.cleanQuery(query), reloads: reloads)) {
            await loadFirst(LoadKey(query: TemplateGallery.cleanQuery(query), reloads: reloads))
        }
        .sheet(item: $form) { template in
            TemplateInstallSheet(template: template, model: model) { response in
                form = nil
                installedFromSheet(template, response)
            }
            .presentationDetents([.medium, .large])
            .duetSheetChrome()
        }
    }

    // MARK: - Sections

    /// No query: Featured, Add your own and the footnote, then the rest of the registry.
    @ViewBuilder private var browsing: some View {
        switch gallery.phase {
        case .loading:
            section(Text("Featured")) { SettingsRowsSkeleton(rows: 4) }
        case .failed(let reason):
            registryDown(reason)
        case .loaded:
            if !gallery.featured.isEmpty {
                section(Text("Featured")) { templateCard(gallery.featured, paged: false) }
            }
        }
        addYourOwn
        if gallery.phase == .loaded, !gallery.rest.isEmpty {
            section(Text("More servers")) { templateCard(gallery.rest, paged: true) }
        }
    }

    /// A query: its results (read on as it scrolls), then Add your own and the footnote.
    @ViewBuilder private var searching: some View {
        switch gallery.phase {
        case .loading:
            SettingsRowsSkeleton(rows: 3)
        case .failed(let reason):
            registryDown(reason)
        case .loaded:
            if gallery.isEmptySearch {
                Text("No servers match")
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                    .transition(.opacity)
            } else {
                templateCard(gallery.templates, paged: true)
            }
        }
        addYourOwn
    }

    private func section<Content: View>(_ title: Text, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: title)
            content()
        }
    }

    private func registryDown(_ reason: String) -> some View {
        InlineRetryLine(reason: reason) { reloads += 1 }
            .cardSurface()
            .transition(.opacity)
    }

    /// The rows in one card; `paged`: the last row reads the next page as it comes on screen.
    private func templateCard(_ templates: [ConnectorTemplate], paged: Bool) -> some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(templates.enumerated()), id: \.element.id) { index, template in
                if index > 0 {
                    Divider().overlay(Palette.cardBorder).padding(.leading, Metrics.settingsTileInset)
                }
                TemplateRow(
                    template: template,
                    state: TemplateRowState.of(template, connectors: model.connectors.value, installing: installing),
                    failure: rowFailures[template.name],
                    onAdd: { add(template) },
                    onOpen: { open(template) }
                )
                .onAppear {
                    if paged, index == templates.count - 1 { loadMore() }
                }
            }
            if paged {
                more
            }
        }
        .frame(maxWidth: .infinity)
        .cardSurface()
    }

    /// The end of a paged list: a spinner while the next page loads, or its failure with Retry.
    @ViewBuilder private var more: some View {
        if gallery.loadingMore {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityLabel(Text("Loading more"))
        } else if let reason = gallery.moreFailure {
            Divider().overlay(Palette.cardBorder)
            InlineFailure(reason: reason) { loadMore() }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
    }

    private var addYourOwn: some View {
        VStack(alignment: .leading, spacing: 10) {
            section(Text("Add your own")) {
                CardSection(dividerInset: Metrics.settingsTileInset) {
                    SheetRow(
                        title: Text("Add manually"),
                        subtitle: Text("An MCP server address, or an API key for one website"),
                        action: onAddManually,
                        leading: { RowSymbol(systemImage: "plus", tint: Palette.secondaryText) },
                        trailing: { RowChevron() }
                    )
                    SheetRow(
                        title: Text("Paste a config"),
                        subtitle: Text("mcpServers from Claude, Cursor or VS Code"),
                        action: onPasteConfig,
                        leading: { RowSymbol(systemImage: "curlybraces", tint: Palette.secondaryText) },
                        trailing: { RowChevron() }
                    )
                }
            }
            Text("Templates come from the official MCP Registry. Only remote servers are listed.")
                .font(.system(size: 12.5))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 10)
        }
    }

    // MARK: - Loading

    private func loadFirst(_ key: LoadKey) async {
        let typed = lastKey != nil && lastKey?.reloads == key.reloads
        lastKey = key
        let generation = gallery.begin(query: key.query)
        if typed {
            try? await Task.sleep(for: .milliseconds(300))
            if Task.isCancelled { return }
        }
        do {
            let list = try await model.connectorTemplates(query: key.query, cursor: nil)
            gallery.received(list, generation: generation)
        } catch {
            if error is CancellationError || Task.isCancelled { return }
            guard let reason = M17Reason.line(for: error) else { return }
            gallery.failed(reason, generation: generation)
        }
    }

    private func loadMore() {
        guard let next = gallery.beginMore() else { return }
        let query = gallery.query
        Task {
            do {
                let list = try await model.connectorTemplates(query: query, cursor: next.cursor)
                gallery.receivedMore(list, generation: next.generation)
            } catch {
                gallery.failedMore(M17Reason.line(for: error) ?? String(localized: "Something went wrong."), generation: next.generation)
            }
        }
    }

    // MARK: - Installing

    private func add(_ template: ConnectorTemplate) {
        guard installing == nil else { return }
        rowFailures[template.name] = nil
        if TemplateInputRules.isOneTap(template) {
            install(template, InstallTemplateRequest(name: template.name))
        } else {
            form = template
        }
    }

    /// An "Added" row: its connector's page (asking the server for it when the list doesn't know it).
    private func open(_ template: ConnectorTemplate) {
        if case .added(let id?) = TemplateRowState.of(template, connectors: model.connectors.value, installing: installing) {
            onOpen(id)
            return
        }
        guard installing == nil else { return }
        installing = template.name
        Task {
            do {
                let response = try await model.installTemplate(InstallTemplateRequest(name: template.name))
                onOpen(response.connector.id)
            } catch {
                rowFailures[template.name] = M17Reason.line(for: error)
            }
            installing = nil
        }
    }

    private func install(_ template: ConnectorTemplate, _ body: InstallTemplateRequest) {
        installing = template.name
        Task {
            do {
                let response = try await model.installTemplate(body)
                await finish(template, response)
            } catch {
                rowFailures[template.name] = M17Reason.line(for: error)
            }
            installing = nil
        }
    }

    private func installedFromSheet(_ template: ConnectorTemplate, _ response: InstallTemplateResponse) {
        installing = template.name
        Task {
            // The sheet slides away first: the web sign-in sheet can't present over a closing one.
            try? await Task.sleep(for: .milliseconds(450))
            await finish(template, response)
            installing = nil
        }
    }

    /// After an install: sign in right away when it asks for it, then its page. A failed sign-in
    /// keeps the row ("Added") with the reason under it; its page has "Sign in" for a retry.
    private func finish(_ template: ConnectorTemplate, _ response: InstallTemplateResponse) async {
        gallery.learned(template.name, needsSignIn: response.needsSignIn)
        guard response.needsSignIn else {
            onAdded(response.connector)
            return
        }
        switch await ConnectorSignIn.run(response.connector.id, model: model, session: webAuthenticationSession) {
        case .signedIn(let connector):
            onAdded(connector)
        case .cancelled:
            onOpen(response.connector.id)
        case .failed(let reason, _):
            rowFailures[template.name] = reason
        }
    }
}

/// "Search MCP servers" over the gallery, with a spinner while a new search runs.
struct TemplateSearchField: View {
    @Binding var query: String
    var busy: Bool

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 16

    var body: some View {
        HStack(spacing: 8) {
            DuetIcon(glyph: .search, size: fontSize + 2, tint: Palette.secondaryText)
                .accessibilityHidden(true)
            TextField(text: $query, prompt: Text("Search MCP servers")) { Text("Search MCP servers") }
                .font(.system(size: fontSize))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if busy {
                ProgressView().controlSize(.small).accessibilityLabel(Text("Searching"))
            } else if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Palette.secondaryText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Clear"))
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .cardSurface()
    }
}
