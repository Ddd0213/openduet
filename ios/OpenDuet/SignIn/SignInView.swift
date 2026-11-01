// SIGN-IN (prompt L131): the mascot with its line swooping in, the serif welcome, the server
// address / username / password capsules where the original had its Google, Apple and email
// rows, the black "Sign in" capsule and the self-hosting footer. Light and dark follow the
// system (DESIGN SYSTEM); text scales with Dynamic Type and the page scrolls when it must.
import SwiftUI

struct SignInView: View {
    let session: SessionStore

    @State private var model: SignInModel
    @FocusState private var focus: Field?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .title) private var titleSize: CGFloat = 26

    private enum Field: Hashable { case server, username, password }

    init(session: SessionStore) {
        self.session = session
        _model = State(initialValue: SignInModel(server: session.savedServer))
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 40)
                    hero
                    Spacer(minLength: 32)
                    form
                    Spacer(minLength: 28)
                    footer
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                // Taps on empty space (behind the fields, never on them) close the keyboard.
                .background {
                    Color.clear.contentShape(Rectangle()).onTapGesture { focus = nil }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Palette.background.ignoresSafeArea())
        .task(id: model.server) { await model.checkServer() }
        .sensoryFeedback(.warning, trigger: model.failures)
    }

    private var hero: some View {
        VStack(spacing: 14) {
            MascotSwoop(size: 64)
                .padding(.bottom, 10)
            Text("Welcome to OpenDuet")
                .font(Typography.serifTitle(titleSize))
                .tracking(-0.2)
                .foregroundStyle(Palette.primaryText)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text("Always-on assistance for life and work. Text OpenDuet your task, and it will come back to you for next steps.")
                .font(.body)
                .foregroundStyle(Palette.primaryText.opacity(0.8))
                .multilineTextAlignment(.center)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
            Text("Sign in to your OpenDuet server")
                .font(.footnote)
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
        }
    }

    private var form: some View {
        VStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                TextField("Server address", text: $model.server, prompt: Text("Server address").foregroundStyle(Palette.secondaryText))
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: .server)
                    .onSubmit { focus = .username }
                    .capsuleField()
                    .accessibilityHint(Text("For example https://duet.example.com or http://192.168.1.10:3000"))
                if let hint = model.serverHint {
                    hintLine(hint)
                        .padding(.horizontal, 20)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                }
            }
            TextField("Username", text: $model.username, prompt: Text("Username").foregroundStyle(Palette.secondaryText))
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .focused($focus, equals: .username)
                .onSubmit { focus = .password }
                .capsuleField()
            SecureField("Password", text: $model.password, prompt: Text("Password").foregroundStyle(Palette.secondaryText))
                .textContentType(.password)
                .submitLabel(.go)
                .focused($focus, equals: .password)
                .onSubmit(submit)
                .capsuleField()
            if let error = model.error {
                hintLine(error)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
                    .padding(.top, 2)
                    .transition(.opacity)
            }
            SignInButton(working: model.signingIn, enabled: model.canSubmit, action: submit)
                .padding(.top, 6)
        }
        .animation(.easeInOut(duration: 0.25), value: model.serverHint)
        .animation(.easeInOut(duration: 0.25), value: model.error)
    }

    private func hintLine(_ text: String) -> some View {
        // Already localized by SignInModel (String(localized:)), so no second catalog lookup.
        Text(text)
            .font(.footnote)
            .foregroundStyle(Palette.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var footer: some View {
        Text("OpenDuet runs on your own server. It only talks to the model and apps you set up.")
            .font(.footnote)
            .foregroundStyle(Palette.secondaryText)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func submit() {
        guard model.canSubmit, !model.signingIn else { return }
        focus = nil
        Task { await model.submit(with: session) }
    }
}

#Preview {
    SignInView(session: SessionStore())
}
