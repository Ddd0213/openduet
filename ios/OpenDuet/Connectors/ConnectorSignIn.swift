// M17: signing in to a remote MCP server (docs/API.md "Sign-in"). POST .../oauth/start, then the
// system's web sign-in sheet (SwiftUI's webAuthenticationSession, callback scheme "duet", the
// shared browser session so a site the user is signed in to in Safari doesn't ask again), then
// the callback's query to POST .../oauth/finish. Closing the sheet calls nothing (the server's
// state simply runs out). Also the "Sign-in needed" card of a connector page.
import AuthenticationServices
import SwiftUI

enum ConnectorSignIn {
    /// The whole flow for one connector; the model's list has the answer when it signs in.
    @MainActor
    static func run(_ connectorId: String, model: EverythingModel, session: WebAuthenticationSession) async -> SignInOutcome {
        do {
            let start = try await model.startConnectorSignIn(connectorId)
            guard let url = URL(string: start.authorizeUrl), url.scheme?.lowercased() == "https" else {
                return .failed(reason: String(localized: "The sign-in page's address isn't valid."), expired: false)
            }
            let callback = try await session.authenticate(
                using: url,
                callbackURLScheme: OAuthCallback.scheme,
                preferredBrowserSession: .shared
            )
            guard let body = OAuthCallback.finishRequest(from: callback) else {
                return .failed(reason: String(localized: "Sign-in didn't finish. Try again."), expired: false)
            }
            return .signedIn(try await model.finishConnectorSignIn(connectorId, body))
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return .cancelled
        } catch is CancellationError {
            return .cancelled
        } catch is ASWebAuthenticationSessionError {
            return .failed(reason: String(localized: "The sign-in page couldn't open. Try again."), expired: false)
        } catch {
            if M17Reason.isExpired(error) {
                return .failed(reason: String(localized: "This sign-in expired. Try again."), expired: true)
            }
            guard let reason = M17Reason.line(for: error) else { return .cancelled }
            return .failed(reason: reason, expired: false)
        }
    }
}

/// "Sign-in needed" on a connector page: why, the "Sign in to <name>" button, and a failure's
/// reason under it (an expired sign-in with its own Retry).
struct ConnectorSignInCard: View {
    var connector: CustomConnector
    var phase: SignInPhase
    var onSignIn: () -> Void

    @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = 16

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CardSection(dividerInset: Metrics.settingsTileInset) {
                SheetRow(
                    title: Text("Sign-in needed"),
                    subtitle: Text("Sign in to \(connector.name) so OpenDuet can use its tools"),
                    action: nil,
                    leading: { RowSymbol(systemImage: "exclamationmark", tint: Palette.failure) },
                    trailing: { EmptyView() }
                )
                Button(action: onSignIn) {
                    ZStack {
                        Text("Sign in to \(connector.name)")
                            .font(.system(size: buttonSize, weight: .semibold))
                            .foregroundStyle(Palette.primaryText)
                            .multilineTextAlignment(.center)
                            .opacity(phase.isRunning ? 0 : 1)
                        if phase.isRunning {
                            ProgressView().controlSize(.small).accessibilityLabel(Text("Signing in"))
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: Metrics.sheetRowMinHeight)
                    .padding(.horizontal, 16)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
                .disabled(phase.isRunning)
            }
            if let reason = phase.failure {
                Group {
                    if phase.expired {
                        InlineFailure(reason: reason, onRetry: onSignIn)
                    } else {
                        SettingsReasonLine(reason: reason)
                    }
                }
                .padding(.horizontal, 6)
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: phase)
        .sensoryFeedback(.warning, trigger: phase.failure) { _, new in new != nil }
    }
}
