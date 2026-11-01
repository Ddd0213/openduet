// M11: a custom connector's page: its status (Connected, or the failure) with "Check again", its
// tools grouped Read / Write with Ask / Always ("All tools" on top), where it's on (All channels /
// Only some), "Edit connection" (a new URL, headers, domain or key) and Delete (asks in place).
// M17: a server that signs in shows "Sign-in needed" with "Sign in to <name>" instead of the
// status while it waits; signed in, "Signed in · N tools" and "Sign out" (asks in place) next to
// "Check again". Connectors without sign-in (and older servers) look as before.
import SwiftUI

struct CustomConnectorPage: View {
    var model: EverythingModel
    var connectorId: String
    var onBack: () -> Void

    /// kept while the page pops after Delete (the connector is gone from the list by then)
    @State private var last: CustomConnector?
    @State private var checking = false
    @State private var checkFailure: String?
    @State private var scopeBusy = false
    @State private var scopeFailure: String?
    @State private var deleting = false
    @State private var deleteFailure: String?
    @State private var signIn: SignInPhase = .idle
    @State private var signingOut = false
    @State private var signOutFailure: String?
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    private var connector: CustomConnector? { model.connector(connectorId) ?? last }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: connector.map { Text(verbatim: $0.name) }, leading: .back, onLeading: onBack)
            ScrollView {
                if let connector {
                    VStack(alignment: .leading, spacing: 22) {
                        if connector.needsSignIn {
                            ConnectorSignInCard(connector: connector, phase: signIn, onSignIn: startSignIn)
                                .transition(.opacity)
                        } else {
                            status(connector)
                                .transition(.opacity)
                        }
                        if !connector.tools.isEmpty {
                            CustomConnectorTools(model: model, connector: connector)
                        }
                        scope(connector)
                        CustomConnectorEditSection(model: model, connector: connector)
                        delete(connector)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 32)
                    .animation(.easeInOut(duration: 0.25), value: connector.needsSignIn)
                } else {
                    MemorySkeleton().padding(16)
                }
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .onChange(of: model.connector(connectorId), initial: true) { _, connector in
            if let connector { last = connector }
        }
    }

    // MARK: - Status

    private func status(_ connector: CustomConnector) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            CardSection(dividerInset: Metrics.settingsTileInset) {
                SheetRow(
                    title: connector.status == .active ? Text("Connected") : Text("Connection failed"),
                    subtitle: statusLine(connector),
                    action: nil,
                    leading: { RowSymbol(systemImage: CustomConnectorRow.symbol(connector.kind), tint: Palette.secondaryText) },
                    trailing: {
                        if connector.status == .failed {
                            DuetIcon(glyph: .warning, size: 17, tint: Palette.failure).accessibilityHidden(true)
                        }
                    }
                )
                SheetRow(
                    title: Text("Check again"),
                    subtitle: connector.kind == .mcp ? Text("Connects and refreshes its tools") : Text("Looks up the domain again"),
                    action: checking ? nil : { check() },
                    leading: { RowSymbol(systemImage: "arrow.clockwise", tint: Palette.secondaryText) },
                    trailing: { BusySpinner(busy: checking) }
                )
                if connector.isSignedIn {
                    InlineConfirm(
                        title: Text("Sign out"),
                        question: Text("Sign out of \(connector.name)? The saved sign-in is removed; its tools and settings stay."),
                        confirmTitle: Text("Sign out"),
                        busy: signingOut,
                        failure: signOutFailure,
                        onConfirm: { signOut() }
                    )
                }
            }
            if let checkFailure {
                SettingsReasonLine(reason: checkFailure).padding(.horizontal, 6)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: connector.status == .active)
        .sensoryFeedback(.warning, trigger: checkFailure) { _, new in new != nil }
    }

    private func statusLine(_ connector: CustomConnector) -> Text {
        if connector.status == .failed {
            let reason = connector.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !reason.isEmpty { return Text(verbatim: reason) }
        }
        if connector.isSignedIn {
            return Text(verbatim: ConnectorCopy.signedInLine(connector))
        }
        let parts = [String(localized: ConnectorCopy.kindLabel(connector.kind)), ConnectorCopy.address(connector)]
        return Text(verbatim: parts.compactMap { $0 }.joined(separator: " · "))
    }

    private func check() {
        checking = true
        checkFailure = nil
        Task {
            do { try await model.testConnector(connectorId) } catch { checkFailure = SettingsReason.line(for: error) }
            checking = false
        }
    }

    // MARK: - Sign-in (M17)

    private func startSignIn() {
        guard !signIn.isRunning else { return }
        signIn = .running
        Task {
            let outcome = await ConnectorSignIn.run(connectorId, model: model, session: webAuthenticationSession)
            signIn = SignInPhase.after(outcome)
        }
    }

    private func signOut() {
        signingOut = true
        signOutFailure = nil
        Task {
            do {
                try await model.signOutConnector(connectorId)
                signIn = .idle
            } catch {
                signOutFailure = M17Reason.line(for: error)
            }
            signingOut = false
        }
    }

    // MARK: - Where it's on

    private func scope(_ connector: CustomConnector) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SheetSectionTitle(text: Text("Where OpenDuet can use it"))
            SettingsSegmented(
                options: [(AccessScope.all, Text("All channels")), (.channels, Text("Only some channels"))],
                selection: connector.scope, disabled: scopeBusy,
                onSelect: { setScope($0) }
            )
            SettingsNote(text: scopeNote(connector))
            if let scopeFailure {
                SettingsReasonLine(reason: scopeFailure).padding(.horizontal, 6)
            }
        }
    }

    private func scopeNote(_ connector: CustomConnector) -> Text {
        if connector.scope == .all {
            return Text("On everywhere. A channel can still turn it off in its OpenDuet sheet.")
        }
        let here = Text(ScopeLabel.text(scope: .channels, channelCount: connector.channelIds.count))
        return Text("Off in a channel until you turn it on in its OpenDuet sheet; Everything can always use it. Now: \(here)")
    }

    private func setScope(_ scope: AccessScope) {
        scopeBusy = true
        scopeFailure = nil
        Task {
            do { try await model.setConnectorScope(connectorId, scope: scope) } catch { scopeFailure = SettingsReason.line(for: error) }
            scopeBusy = false
        }
    }

    // MARK: - Delete

    private func delete(_ connector: CustomConnector) -> some View {
        InlineConfirm(
            title: Text("Delete connector"),
            question: Text("Delete \(connector.name)? Its saved secrets are removed and OpenDuet can't use it anywhere."),
            confirmTitle: Text("Delete"),
            busy: deleting,
            failure: deleteFailure,
            onConfirm: { remove() }
        )
        .cardSurface()
    }

    private func remove() {
        deleting = true
        deleteFailure = nil
        Task {
            do {
                try await model.deleteConnector(connectorId)
                onBack()
            } catch {
                deleteFailure = SettingsReason.line(for: error)
            }
            deleting = false
        }
    }
}
