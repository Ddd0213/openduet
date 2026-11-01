// The New channel sheet (prompt L124): Cancel | "New channel" | Create (disabled until named, a
// spinner while creating); a big tinted icon preview with "Change icon" revealing the 3×8 icon grid
// and the 9 swatches that re-tint everything live; Name ("Q4 planning") and Purpose ("What should
// OpenDuet know about this channel?"). On success the store selects the new channel (its thread
// then shows the assistant's hello) and clears the request; the sheet then closes. M9: the same sheet
// edits a channel (long-press Edit): prefilled, "Edit channel" | Save, Save off until something
// changes.
// M11: a new channel has a second step, "What can OpenDuet use here?" (NewChannelAccessStep): Next
// instead of Create, then Back | Create over the user's skills, custom connectors and connected
// apps (GET /api/channels/<main thread>/access, loaded through the environment's APIClient while
// the first step is filled in). Create sends the picks as `access` with greet on.
import SwiftUI

struct NewChannelSheet: View {
    /// cardRequests[RequestKey.createChannel]
    var request: CardRequest?
    var onCreate: (_ name: String, _ purpose: String, _ icon: ChannelIcon, _ color: ChannelColor) -> Void
    var onCancel: () -> Void
    /// The channel was created: close the sheet and the menu.
    var onCreated: () -> Void
    /// M9: long-press Edit: the sheet opens prefilled with this channel, says "Edit channel" and
    /// Save (PATCH through `onCreate`, request = cardRequests[RequestKey.updateChannel(id)]).
    var editing: Channel? = nil
    /// M11: the main thread (its access list names everything the user has). With it and
    /// `onCreateWithAccess`, a new channel gets the "What can OpenDuet use here?" step.
    var mainChannelId: String? = nil
    var onCreateWithAccess: ((_ name: String, _ purpose: String, _ icon: ChannelIcon, _ color: ChannelColor, _ access: [AccessRef]) -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.apiClient) private var api
    private enum Step: Hashable { case details, access }
    @State private var step: Step = .details
    @State private var access = NewChannelAccess()
    @State private var accessLoad: NewChannelAccessLoad = .loading
    @State private var accessAttempt = 0
    @State private var name = ""
    @State private var purpose = ""
    @State private var icon: ChannelIcon = .checkbox
    @State private var color: ChannelColor = .orange
    @State private var pickingIcon = false
    @State private var submitted = false
    @State private var created = false
    @State private var prefilled = false
    @FocusState private var focus: Field?
    @ScaledMetric(relativeTo: .body) private var fieldSize: CGFloat = 17
    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var chipSize: CGFloat = 15

    private enum Field: Hashable { case name, purpose }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedPurpose: String { purpose.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var busy: Bool { request == .inFlight }
    /// Edit mode with nothing changed yet: Save stays off.
    private var unchanged: Bool {
        guard let editing else { return false }
        return trimmedName == editing.name && trimmedPurpose == editing.purpose
            && icon == editing.icon && color == editing.colorHex
    }
    private var canSubmit: Bool { !trimmedName.isEmpty && !busy && !unchanged }
    /// M11: a new channel (not an edit) asks what the assistant can use there.
    private var asksAccess: Bool { editing == nil && mainChannelId != nil && onCreateWithAccess != nil }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ZStack {
                if step == .details {
                    detailsPage.transition(pageTransition(leading: true))
                } else {
                    accessPage.transition(pageTransition(leading: false))
                }
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.86), value: pickingIcon)
        .animation(.easeInOut(duration: 0.2), value: request)
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.42, dampingFraction: 0.9), value: step)
        // Loaded while the first step is filled in, so the second one is ready when it opens.
        .task(id: accessAttempt) { await loadAccess() }
        .onChange(of: request) { _, new in
            // A failed Create (an item went away meanwhile) refreshes the list it was picked from.
            if asksAccess, step == .access, case .failed = new { accessAttempt += 1 }
        }
        .onAppear {
            if let editing, !prefilled {
                prefilled = true
                name = editing.name
                purpose = editing.purpose
                icon = editing.icon
                color = editing.colorHex
            } else if editing == nil {
                focus = .name
            }
        }
        .onChange(of: request) { old, new in
            guard submitted, old == .inFlight, new == nil else { return }
            created = true
            Task {
                try? await Task.sleep(for: .milliseconds(250))
                onCreated()
            }
        }
        .sensoryFeedback(.success, trigger: created) { _, new in new }
        .sensoryFeedback(.warning, trigger: request) { _, new in if case .failed = new { true } else { false } }
        .interactiveDismissDisabled(busy)
    }

    private var detailsPage: some View {
        ScrollView {
            VStack(spacing: 18) {
                preview
                if pickingIcon {
                    ChannelIconPicker(icon: $icon, color: $color)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
                }
                fields
                // With the access step, a failed Create shows on that step instead.
                if !asksAccess, case .failed(let reason) = request {
                    InlineFailure(reason: reason, onRetry: create)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// M11: "What can OpenDuet use here?"
    private var accessPage: some View {
        ScrollView {
            NewChannelAccessStep(
                access: access, load: accessLoad, request: request,
                onToggle: { item in if !busy { access.toggle(item) } },
                onRetryLoad: { accessAttempt += 1 },
                onRetryCreate: create
            )
            .disabled(busy)
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 32)
        }
    }

    private func pageTransition(leading: Bool) -> AnyTransition {
        guard !reduceMotion else { return .opacity }
        return .asymmetric(
            insertion: .move(edge: leading ? .leading : .trailing).combined(with: .opacity),
            removal: .move(edge: leading ? .leading : .trailing).combined(with: .opacity)
        )
    }

    private var topBar: some View {
        ZStack {
            Group {
                if editing == nil { Text("New channel") } else { Text("Edit channel") }
            }
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, 96)
                .accessibilityAddTraits(.isHeader)
            HStack {
                Button(action: leading) {
                    Group {
                        // M11: the access step goes back to the name and icon.
                        if step == .access { Text("Back") } else { Text("Cancel") }
                    }
                        .font(.system(size: 17))
                        .foregroundStyle(Palette.primaryText)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.95))
                .disabled(busy)
                Spacer()
                Button(action: trailing) {
                    ZStack {
                        Group {
                            if editing != nil { Text("Save") } else if asksAccess && step == .details { Text("Next") } else { Text("Create") }
                        }
                        .opacity(busy ? 0 : 1)
                        if busy { ProgressView().controlSize(.small) }
                    }
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(trimmedName.isEmpty || unchanged ? Palette.secondaryText : Palette.accent)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.95))
                .disabled(!canSubmit)
                .accessibilityValue(busy ? Text("In progress") : Text(verbatim: ""))
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    private var preview: some View {
        VStack(spacing: 12) {
            ChannelGlyph(icon: icon, color: color, size: 84)
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: icon)
                .animation(.easeInOut(duration: 0.25), value: color)
            Button { pickingIcon.toggle() } label: {
                HStack(spacing: 6) {
                    Text("Change icon")
                    Image(systemName: "chevron.down")
                        .font(.system(size: chipSize - 4, weight: .semibold))
                        .rotationEffect(.degrees(pickingIcon ? 180 : 0))
                        .accessibilityHidden(true)
                }
                .font(.system(size: chipSize, weight: .medium))
                .foregroundStyle(color.glyph(in: colorScheme))
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(Capsule().fill(color.color.opacity(0.14)))
            }
            .buttonStyle(PressableButtonStyle(scale: 0.95))
            .accessibilityValue(pickingIcon ? Text("Expanded") : Text("Collapsed"))
        }
        .padding(.top, 10)
    }

    private var fields: some View {
        CardSection {
            VStack(alignment: .leading, spacing: 4) {
                Text("Channel name")
                    .font(.system(size: labelSize, weight: .medium))
                    .foregroundStyle(Palette.secondaryText)
                TextField(text: $name) { Text("Q4 planning") }
                    .font(.system(size: fieldSize))
                    .focused($focus, equals: .name)
                    .submitLabel(.next)
                    .onSubmit { focus = .purpose }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            VStack(alignment: .leading, spacing: 4) {
                Text("Purpose")
                    .font(.system(size: labelSize, weight: .medium))
                    .foregroundStyle(Palette.secondaryText)
                TextField(text: $purpose, axis: .vertical) { Text("What should OpenDuet know about this channel?") }
                    .font(.system(size: fieldSize))
                    .lineLimit(2...6)
                    .focused($focus, equals: .purpose)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .disabled(busy)
    }

    private func create() {
        guard canSubmit else { return }
        focus = nil
        submitted = true
        if asksAccess, let onCreateWithAccess {
            onCreateWithAccess(trimmedName, trimmedPurpose, icon, color, access.access)
        } else {
            onCreate(trimmedName, trimmedPurpose, icon, color)
        }
    }

    /// Cancel, or (M11) Back from the access step.
    private func leading() {
        if step == .access { step = .details } else { onCancel() }
    }

    /// Create / Save, or (M11) Next to "What can OpenDuet use here?".
    private func trailing() {
        if asksAccess && step == .details {
            guard canSubmit else { return }
            focus = nil
            pickingIcon = false
            step = .access
        } else {
            create()
        }
    }

    /// M11: the main thread's access list = everything the user has (each with its own scope).
    private func loadAccess() async {
        guard asksAccess, let api, let mainChannelId else { return }
        if access.isEmpty { accessLoad = .loading }
        do {
            let list = try await api.channelAccess(channelId: mainChannelId)
            access.load(list.items)
            accessLoad = .loaded
        } catch is CancellationError {
            return
        } catch {
            // Already shown: a failed refresh keeps the list (and its picks).
            if accessLoad != .loaded { accessLoad = .failed(reason: TaskBoard.reason(for: error)) }
        }
    }
}
