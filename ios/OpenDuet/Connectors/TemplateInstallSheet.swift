// M17: the small sheet a template with required inputs opens from Add connector's gallery: just
// those fields (a secret one in a SecureField; a header asks for its value only, the server puts
// it in the registry's template like "Bearer {token}"; a URL part is one segment), then "Add"
// with "Checks the connection first". A 400 that names a field shows under it, anything else
// above Add. Typed secrets are sent once and dropped from the sheet, like the manual form.
import SwiftUI

struct TemplateInstallSheet: View {
    var template: ConnectorTemplate
    var model: EverythingModel
    var onInstalled: (InstallTemplateResponse) -> Void

    @State private var values: [String: String] = [:]
    @State private var saving = false
    @State private var failure: String?
    /// input name → the server's reason for it
    @State private var fieldFailures: [String: String] = [:]
    @State private var secretsDropped = false

    @ScaledMetric(relativeTo: .title3) private var titleSize: CGFloat = 20
    @ScaledMetric(relativeTo: .footnote) private var noteSize: CGFloat = 13

    private var inputs: [ConnectorTemplateInput] { TemplateInputRules.asked(template) }
    private var request: InstallTemplateRequest? { TemplateInputRules.request(template, values: values) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Add \(template.title)")
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .accessibilityAddTraits(.isHeader)
                    if !template.description.isEmpty {
                        Text(verbatim: template.description)
                            .font(.system(size: noteSize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 6)
                CardSection {
                    ForEach(inputs) { input in field(input) }
                }
                .disabled(saving)
                if let failure {
                    SettingsReasonLine(reason: failure)
                        .padding(.horizontal, 6)
                        .transition(.opacity)
                }
                VStack(spacing: 10) {
                    CapsuleButton(title: Text("Add"), busy: saving, action: save)
                        .disabled(request == nil || saving)
                    statusLine
                        .font(.system(size: 12.5))
                        .foregroundStyle(Palette.secondaryText)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .contentTransition(.opacity)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)
            .padding(.bottom, 24)
            .animation(.easeInOut(duration: 0.2), value: failure)
            .animation(.easeInOut(duration: 0.2), value: fieldFailures)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .interactiveDismissDisabled(saving)
        .sensoryFeedback(.warning, trigger: failure ?? fieldFailures.values.sorted().first) { _, new in new != nil }
    }

    private var statusLine: Text {
        if saving { return Text("Checking the connection…") }
        if secretsDropped, failure != nil || !fieldFailures.isEmpty { return Text("Paste the secrets again to retry.") }
        return Text("Checks the connection first")
    }

    @ViewBuilder private func field(_ input: ConnectorTemplateInput) -> some View {
        let binding = Binding(
            get: { values[input.name] ?? "" },
            set: { values[input.name] = $0; fieldFailures[input.name] = nil }
        )
        let footnote = input.description.isEmpty ? nil : Text(verbatim: input.description)
        if input.secret {
            VStack(alignment: .leading, spacing: 0) {
                SettingsSecretField(label: Text(verbatim: input.name), text: binding, prompt: Text("Required"), footnote: footnote)
                if let problem = problemText(input) {
                    problem
                        .font(.system(size: 12.5))
                        .foregroundStyle(Palette.failure)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 12)
                        .padding(.top, -6)
                        .transition(.opacity)
                }
            }
        } else {
            SettingsField(
                label: Text(verbatim: input.name), text: binding, prompt: Text("Required"),
                plain: true, keyboard: input.kind == .urlVariable ? .asciiCapable : .default,
                problem: problemText(input), footnote: footnote
            )
        }
    }

    /// The server's reason for this field, else what's wrong with what's typed.
    private func problemText(_ input: ConnectorTemplateInput) -> Text? {
        if let reason = fieldFailures[input.name] { return Text(verbatim: reason) }
        switch TemplateInputRules.problem(input, values[input.name] ?? "") {
        case .segment?: return Text("Letters, digits and - . _ ~ only (no / ? # @ or spaces).")
        case .multiline?: return Text("Keep it on one line.")
        case .tooLong?: return Text("That's too long.")
        case nil: return nil
        }
    }

    private func save() {
        guard let body = request else { return }
        // Sent once: secret values leave the sheet's state now.
        let hadSecrets = inputs.contains { $0.secret }
        for input in inputs where input.secret { values[input.name] = "" }
        saving = true
        failure = nil
        fieldFailures = [:]
        secretsDropped = false
        Task {
            do {
                let response = try await model.installTemplate(body)
                saving = false
                onInstalled(response)
            } catch {
                if let name = M17Reason.inputName(error), inputs.contains(where: { $0.name == name }),
                   let reason = M17Reason.fieldLine(for: error) {
                    fieldFailures[name] = reason
                } else {
                    failure = M17Reason.line(for: error)
                }
                secretsDropped = hadSecrets
                saving = false
            }
        }
    }
}
