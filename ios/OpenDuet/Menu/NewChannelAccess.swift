// M11: the New channel sheet's "What can OpenDuet use here?" step (pure Foundation, host-tested).
// The list is GET /api/channels/<main thread>/access, where everything is enabled; what matters is
// each item's own scope. Scope `all` is on in every channel: shown on and locked. Scope `channels`
// starts off and can be picked. Only the picks go into CreateChannelRequest.access (the server
// turns everything with scope all on by itself).
import Foundation

struct NewChannelAccess: Hashable, Sendable {
    struct Section: Hashable, Sendable, Identifiable {
        var kind: AccessKind
        var items: [ChannelAccess.Item]
        var id: AccessKind { kind }
    }

    private(set) var items: [ChannelAccess.Item] = []
    /// picked refs (scope channels only)
    private(set) var picked: Set<AccessRef> = []

    init(items: [ChannelAccess.Item] = []) {
        self.items = items
    }

    /// A new list from the server: picks that are still pickable stay.
    mutating func load(_ list: [ChannelAccess.Item]) {
        items = list
        let pickable = Set(list.filter { $0.scope == .channels }.map(\.ref))
        picked.formIntersection(pickable)
    }

    /// On for every channel: shown on, can't be turned off here.
    func isLocked(_ item: ChannelAccess.Item) -> Bool { item.scope == .all }

    func isOn(_ item: ChannelAccess.Item) -> Bool { isLocked(item) || picked.contains(item.ref) }

    /// A tap on a row: a pickable item turns on / off; a locked one stays on.
    mutating func toggle(_ item: ChannelAccess.Item) {
        guard !isLocked(item), items.contains(where: { $0.ref == item.ref }) else { return }
        if picked.contains(item.ref) { picked.remove(item.ref) } else { picked.insert(item.ref) }
    }

    /// Skills, then custom connectors, then apps (the server sorts by name within each kind);
    /// empty kinds are left out.
    var sections: [Section] {
        [AccessKind.skill, .connector, .app].compactMap { kind in
            let list = items.filter { $0.kind == kind }
            return list.isEmpty ? nil : Section(kind: kind, items: list)
        }
    }

    /// CreateChannelRequest.access: the picks, in the list's order.
    var access: [AccessRef] {
        items.filter { $0.scope == .channels && picked.contains($0.ref) }.map(\.ref)
    }

    var isEmpty: Bool { items.isEmpty }
}
