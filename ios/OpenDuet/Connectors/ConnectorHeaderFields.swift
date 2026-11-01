// M11: an MCP connector's request headers (Add connector and Edit connection): one card per
// header with its name, its value (a SecureField while it's secret) and the secret switch;
// "Add header" up to 10. A secret goes to the server's vault and is never shown again; in the
// edit form a stored secret left blank keeps its value.
import SwiftUI

struct ConnectorHeaderFields: View {
    @Binding var headers: [HeaderDraft]
    var editing = false
    var disabled = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SheetSectionTitle(text: Text("Headers"))
                .padding(.bottom, -6)
            SettingsNote(text: Text("Sent with every request to the server, like Authorization. A secret one goes straight to your server's vault."))
            ForEach($headers) { $header in
                ConnectorHeaderCard(
                    header: $header,
                    problem: problem(header),
                    editing: editing,
                    onRemove: { headers.removeAll { $0.id == header.id } }
                )
            }
            if headers.count < ConnectorFormRules.maxHeaders {
                CapsuleButton(title: Text("Add header"), style: .outline, fullWidth: false) {
                    headers.append(HeaderDraft(name: headers.isEmpty ? "Authorization" : ""))
                }
                .padding(.horizontal, 6)
            }
        }
        .disabled(disabled)
        .animation(.easeInOut(duration: 0.2), value: headers.map(\.id))
    }

    private func problem(_ header: HeaderDraft) -> Text? {
        let name = ConnectorFormRules.clean(header.name)
        guard !name.isEmpty else { return nil }
        if !ConnectorFormRules.isHeaderName(name) { return Text("Letters, digits and dashes only.") }
        let same = headers.filter { ConnectorFormRules.clean($0.name).caseInsensitiveCompare(name) == .orderedSame }
        return same.count > 1 ? Text("Two headers have this name.") : nil
    }
}

struct ConnectorHeaderCard: View {
    @Binding var header: HeaderDraft
    var problem: Text?
    var editing: Bool
    var onRemove: () -> Void

    @ScaledMetric(relativeTo: .body) private var removeSize: CGFloat = 15

    var body: some View {
        CardSection {
            SettingsField(label: Text("Header"), text: $header.name, prompt: Text(verbatim: "Authorization"), plain: true, problem: problem)
            if header.secret {
                SettingsSecretField(
                    label: Text("Value"), text: $header.value,
                    prompt: header.stored && editing ? Text("Leave blank to keep it") : Text("Paste the value"),
                    footnote: header.stored && editing ? Text("Saved in the vault") : nil
                )
            } else {
                SettingsField(label: Text("Value"), text: $header.value, prompt: Text("The value"), plain: true)
            }
            SettingsToggleRow(
                title: Text("Secret"),
                subtitle: Text("Kept in the vault, never shown again"),
                on: header.secret,
                onChange: { on in
                    header.secret = on
                    // a stored secret's value isn't known here: a plain value has to be typed
                    if !on, header.stored { header.value = "" }
                }
            )
            Button(role: .destructive, action: onRemove) {
                Text("Remove header")
                    .font(.system(size: removeSize, weight: .medium))
                    .foregroundStyle(Palette.destructive)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
        }
    }
}
