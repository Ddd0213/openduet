// M11: two parts of a custom connector's page. Its tools: "All tools" and each tool with Ask /
// Always (PUT /api/custom-connectors/:id/policy), showing the tapped mode while it saves and the
// reason with Retry when it fails. "Edit connection": the same fields as Add connector, a stored
// secret left blank keeps its vault value; saving checks the connection again.
import SwiftUI

struct CustomConnectorTools: View {
    var model: EverythingModel
    var connector: CustomConnector

    /// nil key = "All tools"
    @State private var pending: [String?: PolicyMode] = [:]
    @State private var requests: [String?: CardRequest] = [:]

    /// M20: with each tool's alwaysAllowed / alwaysBlocked (the rows disable Always and say why).
    private var tools: [ConnectorTool] { ApprovalAlwaysRules.tools(connector) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Tools"))
            CardSection {
                SheetRow(
                    title: Text("All tools"),
                    subtitle: shownAll == nil ? Text("Custom") : Text(ConnectorCopy.toolCount(tools.count)),
                    action: nil,
                    leading: { EmptyView() },
                    trailing: {
                        PolicyPicker(mode: shownAll) { set(nil, $0) }
                            .accessibilityLabel(Text("All tools"))
                    }
                )
            }
            if let reason = requests[nil]?.failureReason {
                InlineFailure(reason: reason) { retry(nil) }
                    .padding(.top, 8)
                    .padding(.horizontal, 6)
            }
            ForEach([ConnectorTool.Access.read, .write], id: \.self) { access in
                let group = tools.filter { $0.access == access }
                if !group.isEmpty {
                    ToolGroupHeader(access: access)
                        .padding(.top, 20)
                    CardSection {
                        ForEach(group) { tool in
                            ConnectorToolRow(
                                tool: tool, mode: shown(tool), request: requests[tool.slug],
                                onSelect: { set(tool.slug, $0) },
                                onRetry: { retry(tool.slug) }
                            )
                        }
                    }
                }
            }
        }
        .sensoryFeedback(.warning, trigger: requests[nil]) { _, new in new?.failureReason != nil }
    }

    private func shown(_ tool: ConnectorTool) -> PolicyMode {
        if requests[tool.slug] == .inFlight, let mode = pending[tool.slug] { return mode }
        if requests[nil] == .inFlight, let mode = pending[nil] { return mode }
        return tool.mode
    }

    /// The mode every tool shares; nil = Custom.
    private var shownAll: PolicyMode? {
        if requests[nil] == .inFlight, let mode = pending[nil] { return mode }
        let modes = tools.map(shown)
        guard let first = modes.first else { return nil }
        return modes.allSatisfy { $0 == first } ? first : nil
    }

    private func set(_ tool: String?, _ mode: PolicyMode) {
        pending[tool] = mode
        requests[tool] = .inFlight
        Task {
            do {
                try await model.setConnectorPolicy(connector.id, tool: tool, mode: mode)
                requests[tool] = nil
            } catch {
                if let reason = SettingsReason.line(for: error) {
                    requests[tool] = .failed(reason: reason)
                } else {
                    requests[tool] = nil
                }
            }
        }
    }

    private func retry(_ tool: String?) {
        guard let mode = pending[tool] else { return }
        set(tool, mode)
    }
}

/// "Edit connection" under the tools. The form starts from the connector as saved and resets when
/// the saved connection changes (not when a check or a policy refreshes its status or tools).
struct CustomConnectorEditSection: View {
    var model: EverythingModel
    var connector: CustomConnector

    private struct Saved: Hashable {
        var name: String
        var url: String?
        var domain: String?
        var headerName: String?
        var valuePrefix: String?
        var secret: SecretInfo?
        var headers: [ConnectorHeader]
    }

    @State private var draft: ConnectorEditDraft?
    @State private var saving = false
    @State private var failure: String?
    @State private var saved = false
    @State private var secretsDropped = false

    private var savedConnection: Saved {
        Saved(name: connector.name, url: connector.url, domain: connector.domain, headerName: connector.headerName,
              valuePrefix: connector.valuePrefix, secret: connector.secret, headers: connector.headers)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SheetSectionTitle(text: Text("Edit connection"))
                .padding(.bottom, -10)
            SettingsNote(text: Text("A new address, header or key is checked before it's saved. A saved secret left blank stays as it is."))
            if let draft {
                form(Binding(get: { draft }, set: { self.draft = $0 }))
            }
            SettingsSaveRow(
                busy: saving, enabled: draft?.request != nil, saved: saved && draft?.request == nil,
                failure: failure, status: status, onSave: save
            )
        }
        .onChange(of: savedConnection, initial: true) { _, _ in
            guard !saving else { return }
            draft = ConnectorEditDraft(connector)
        }
        .onChange(of: draft) { _, new in if new?.request != nil { saved = false } }
    }

    @ViewBuilder private func form(_ draft: Binding<ConnectorEditDraft>) -> some View {
        let problems = draft.wrappedValue.problems
        CardSection {
            SettingsField(
                label: Text("Connector name"), text: draft.name, prompt: Text("Required"), limit: ConnectorFormRules.nameLimit,
                problem: problems.contains(.name) ? Text("Up to 80 characters.") : nil
            )
            if connector.kind == .mcp {
                SettingsField(
                    label: Text("Server URL"), text: draft.url, prompt: Text(verbatim: "https://mcp.example.com/mcp"),
                    plain: true, keyboard: .URL, problem: problems.contains(.url) ? Text("Use an https address.") : nil
                )
            } else {
                SettingsField(
                    label: Text("Domain"), text: draft.domain, prompt: Text(verbatim: "api.example.com"), plain: true, keyboard: .URL,
                    problem: problems.contains(.domain) ? Text("Use a public domain name like api.example.com") : nil
                )
                SettingsField(
                    label: Text("Header"), text: draft.headerName, prompt: Text(verbatim: "Authorization"), plain: true,
                    problem: problems.contains(.headerName) ? Text("Letters, digits and dashes only.") : nil
                )
                SettingsField(
                    label: Text("Prefix"), text: draft.valuePrefix, prompt: Text(verbatim: "Bearer "), plain: true,
                    problem: problems.contains(.prefix) ? Text("Up to 20 characters.") : nil
                )
                SettingsSecretField(
                    label: Text("Key"), text: draft.key, prompt: Text("Leave blank to keep it"),
                    footnote: Text(ConnectorCopy.secretLine(connector.secret))
                )
            }
        }
        .disabled(saving)
        if connector.kind == .mcp {
            ConnectorHeaderFields(headers: draft.headers, editing: true, disabled: saving)
        }
    }

    private var status: Text? {
        if saving { return Text("Checking the connection…") }
        if secretsDropped, failure != nil { return Text("Paste the secrets again to retry.") }
        return nil
    }

    private func save() {
        guard var current = draft, let body = current.request else { return }
        let hadSecrets = body.key != nil || (body.headers ?? []).contains { $0.secret && $0.value != nil }
        // Sent once: typed secrets leave this page's state now (stored ones stay in the vault).
        current.dropSecrets()
        draft = current
        saving = true
        failure = nil
        secretsDropped = false
        Task {
            do {
                try await model.updateConnector(connector.id, body)
                if let fresh = model.connector(connector.id) { draft = ConnectorEditDraft(fresh) }
                saved = true
            } catch {
                failure = SettingsReason.line(for: error)
                secretsDropped = hadSecrets
            }
            saving = false
        }
    }
}
