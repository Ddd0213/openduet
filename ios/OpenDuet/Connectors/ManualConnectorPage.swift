// M11 "Add connector" form, M17 "Add manually" (pushed from Add connector's "Add your own"): an MCP
// server (name, https URL, request headers) or an API key bound to one domain (name, domain,
// header, prefix, key in a SecureField). The server checks it before saving (up to ~15 s:
// "Checking the connection…"); a refusal keeps the form filled in except the secrets (sent once,
// never kept) and shows its reason inline. M17: an MCP server that asks for sign-in is saved
// waiting for it (`allowSignIn`) and the sign-in starts at once; its page shows the rest.
import SwiftUI

struct ManualConnectorPage: View {
    var model: EverythingModel
    var onBack: () -> Void
    var onAdded: (CustomConnector) -> Void

    @State private var draft = ConnectorDraft()
    @State private var saving = false
    @State private var signingIn = false
    @State private var failure: String?
    /// a refused save dropped what was typed into secret fields
    @State private var secretsDropped = false
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    private var busy: Bool { saving || signingIn }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Add manually"), leading: .back, onLeading: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    SettingsSegmented(
                        options: [(CustomConnector.Kind.mcp, Text("MCP server")), (.apiKey, Text("API key"))],
                        selection: draft.kind, disabled: busy,
                        onSelect: { draft.kind = $0; failure = nil }
                    )
                    SettingsNote(text: draft.kind == .mcp
                        ? Text("A remote MCP server over https. OpenDuet gets its tools; you choose which ask first.")
                        : Text("A key for one web API. OpenDuet can call that domain with it and nothing else."))
                    CardSection {
                        SettingsField(
                            label: Text("Connector name"), text: $draft.name, prompt: Text("Required"),
                            limit: ConnectorFormRules.nameLimit,
                            problem: draft.problems.contains(.name) ? Text("Up to 80 characters.") : nil
                        )
                        SettingsField(
                            label: Text("Description"), text: $draft.description,
                            prompt: Text("Optional"), lines: 1...4
                        )
                    }
                    .disabled(busy)
                    if draft.kind == .mcp { mcpFields } else { apiKeyFields }
                    SettingsSaveRow(
                        title: Text("Add"), busy: busy, enabled: draft.canSave, saved: false,
                        failure: failure, status: status, onSave: save
                    )
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
                .animation(.easeInOut(duration: 0.2), value: draft.kind)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var mcpFields: some View {
        VStack(alignment: .leading, spacing: 18) {
            CardSection {
                SettingsField(
                    label: Text("Server URL"), text: $draft.url, prompt: Text(verbatim: "https://mcp.example.com/mcp"),
                    plain: true, keyboard: .URL,
                    problem: draft.problems.contains(.url) ? Text("Use an https address.") : nil
                )
            }
            .disabled(busy)
            ConnectorHeaderFields(headers: $draft.headers, disabled: busy)
        }
    }

    private var apiKeyFields: some View {
        CardSection {
            SettingsField(
                label: Text("Domain"), text: $draft.domain, prompt: Text(verbatim: "api.example.com"),
                plain: true, keyboard: .URL,
                problem: draft.problems.contains(.domain) ? Text("Use a public domain name like api.example.com") : nil,
                footnote: Text("OpenDuet can only send this key to this domain and its subdomains.")
            )
            SettingsField(
                label: Text("Header"), text: $draft.headerName, prompt: Text(verbatim: "Authorization"), plain: true,
                problem: draft.problems.contains(.headerName) ? Text("Letters, digits and dashes only.") : nil
            )
            SettingsField(
                label: Text("Prefix"), text: $draft.valuePrefix, prompt: Text(verbatim: "Bearer "), plain: true,
                problem: draft.problems.contains(.prefix) ? Text("Up to 20 characters.") : nil,
                footnote: Text("Goes before the key in the header. Leave it empty if the API wants the key alone.")
            )
            SettingsSecretField(
                label: Text("Key"), text: $draft.key, prompt: Text("Paste the key"),
                footnote: Text("Goes straight to your server's vault. OpenDuet never sees it.")
            )
        }
        .disabled(busy)
    }

    private var status: Text? {
        if signingIn { return Text("Signing in…") }
        if saving { return Text("Checking the connection…") }
        if secretsDropped, failure != nil { return Text("Paste the secrets again to retry.") }
        return nil
    }

    private func save() {
        guard let body = draft.request else { return }
        // Sent once: what was typed into secret fields leaves this page's state now.
        draft.dropSecrets()
        saving = true
        failure = nil
        secretsDropped = false
        Task {
            do {
                let connector = try await model.createConnectorAllowingSignIn(body)
                saving = false
                if connector.needsSignIn {
                    // Saved, waiting for sign-in: the web sheet now; its page has "Sign in" for a retry.
                    signingIn = true
                    _ = await ConnectorSignIn.run(connector.id, model: model, session: webAuthenticationSession)
                    signingIn = false
                }
                onAdded(model.connector(connector.id) ?? connector)
            } catch {
                failure = M17Reason.line(for: error)
                secretsDropped = true
                saving = false
            }
        }
    }
}
