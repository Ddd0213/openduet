// M17 "Paste a config" (pushed from Add connector's "Add your own"): a monospaced editor for a
// Claude / Cursor / VS Code / Zed mcpServers config, "Import" (POST /api/custom-connectors/import;
// each remote entry is checked, which can take a while), then the results: each added connector
// (its page on tap; "Signs in" when it waits for sign-in) and each skipped entry with its plain
// reason. A 400 for the text itself ("that isn't JSON") shows under the editor. The pasted text
// may hold keys: it leaves the editor once the server has it.
import SwiftUI

struct PasteConfigPage: View {
    var model: EverythingModel
    var onBack: () -> Void
    var onOpen: (String) -> Void

    @State private var text = ""
    @State private var importing = false
    /// a 400 for the text (field json)
    @State private var textFailure: String?
    @State private var failure: String?
    @State private var result: ImportConnectorsResponse?
    @State private var imports = 0

    @ScaledMetric(relativeTo: .footnote) private var editorSize: CGFloat = 13
    @ScaledMetric(relativeTo: .caption) private var noteSize: CGFloat = 12.5

    private var over: Int { text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count - ImportCopy.jsonLimit }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Paste a config"), leading: .back, onLeading: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    SettingsNote(text: Text("Paste the mcpServers part of a Claude, Cursor, VS Code or Zed config. Remote servers are added; programs that run on a computer are skipped. Header values that look like keys go to your server's vault."))
                    editor
                    if let failure {
                        SettingsReasonLine(reason: failure)
                            .padding(.horizontal, 6)
                            .transition(.opacity)
                    }
                    VStack(spacing: 10) {
                        CapsuleButton(title: Text("Import"), busy: importing, action: submit)
                            .disabled(ImportCopy.request(text) == nil || importing)
                        if importing {
                            Text("Checking each server…")
                                .font(.system(size: noteSize))
                                .foregroundStyle(Palette.secondaryText)
                                .transition(.opacity)
                        }
                    }
                    if let result {
                        results(result)
                            .transition(.opacity)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
                .animation(.easeInOut(duration: 0.2), value: result)
                .animation(.easeInOut(duration: 0.2), value: failure)
                .animation(.easeInOut(duration: 0.2), value: textFailure)
                .animation(.easeInOut(duration: 0.2), value: importing)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .sensoryFeedback(.success, trigger: imports)
        .sensoryFeedback(.warning, trigger: failure ?? textFailure) { _, new in new != nil }
    }

    // MARK: - Editor

    private var editor: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text(verbatim: Self.placeholder)
                        .font(.system(size: editorSize, design: .monospaced))
                        .foregroundStyle(Palette.secondaryText.opacity(0.7))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 8)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                TextEditor(text: $text)
                    .font(.system(size: editorSize, design: .monospaced))
                    .foregroundStyle(Palette.primaryText)
                    .scrollContentBackground(.hidden)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .frame(minHeight: 180)
                    .disabled(importing)
                    .accessibilityLabel(Text("Config"))
                    .onChange(of: text) { _, _ in textFailure = nil }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .cardSurface()
            if let textFailure {
                Text(verbatim: textFailure)
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.failure)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 6)
                    .transition(.opacity)
            } else if over > 0 {
                Text("\(over) over the limit")
                    .font(.system(size: noteSize).monospacedDigit())
                    .foregroundStyle(Palette.failure)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, 6)
            }
        }
    }

    private static let placeholder = """
    {
      "mcpServers": {
        "linear": { "url": "https://mcp.linear.app/mcp" }
      }
    }
    """

    // MARK: - Results

    private func results(_ result: ImportConnectorsResponse) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Results"))
            if result.connectors.isEmpty && result.skipped.isEmpty {
                SettingsNote(text: Text("Nothing in that config could be added."))
            } else {
                CardSection(dividerInset: Metrics.settingsTileInset) {
                    ForEach(result.connectors) { connector in
                        SheetRow(
                            title: Text(verbatim: connector.name),
                            subtitle: Text(verbatim: ImportCopy.addedLine(model.connector(connector.id) ?? connector)),
                            action: { onOpen(connector.id) },
                            leading: { RowSymbol(systemImage: "checkmark", tint: Palette.success) },
                            trailing: { RowChevron() }
                        )
                    }
                    ForEach(Array(result.skipped.enumerated()), id: \.offset) { _, skipped in
                        SheetRow(
                            title: Text(verbatim: skipped.name),
                            subtitle: Text("Skipped: \(ImportCopy.reason(skipped))"),
                            action: nil,
                            leading: { RowSymbol(systemImage: "minus", tint: Palette.secondaryText) },
                            trailing: { EmptyView() }
                        )
                    }
                }
            }
        }
    }

    // MARK: - Import

    private func submit() {
        guard let body = ImportCopy.request(text) else { return }
        importing = true
        failure = nil
        textFailure = nil
        Task {
            do {
                let response = try await model.importConnectors(body)
                result = response
                // The server has it: pasted keys don't stay on screen.
                text = ""
                if !response.connectors.isEmpty { imports += 1 }
            } catch {
                if M17Reason.field(error) == "json" {
                    textFailure = M17Reason.fieldLine(for: error)
                } else {
                    failure = M17Reason.line(for: error)
                }
            }
            importing = false
        }
    }
}
