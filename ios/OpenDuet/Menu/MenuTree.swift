// The side menu's tree (prompt L123): the channels hang under "Everything" with grey connector
// lines, in the server's order, and "+ New channel" is the last branch. Which row wears the
// grey selection pill, and where each branch row draws its lines. Pure Foundation (host-tested).
import Foundation

enum MenuTree {
    enum Node: Hashable, Sendable {
        case channel(id: String)
        case newChannel
    }

    /// How a branch joins the trunk: ├ (the trunk goes on below it) or └ (the last branch).
    enum Connector: Hashable, Sendable { case tee, elbow }

    struct Branch: Hashable, Sendable, Identifiable {
        var node: Node
        var connector: Connector
        var id: Node { node }
    }

    /// The branches under Everything: every channel, then "+ New channel" closing the tree.
    static func branches(channelIds: [String]) -> [Branch] {
        let nodes = channelIds.map { Node.channel(id: $0) } + [.newChannel]
        return nodes.enumerated().map { index, node in
            Branch(node: node, connector: index == nodes.count - 1 ? .elbow : .tee)
        }
    }

    /// Everything wears the pill when no channel is selected, or when the selected one is no
    /// longer listed (archived elsewhere) until the store moves back to the main thread.
    static func everythingSelected(selectedChannelId: String?, channelIds: [String]) -> Bool {
        guard let selectedChannelId else { return true }
        return !channelIds.contains(selectedChannelId)
    }

    /// The grey lines of one branch row: the trunk at `trunkX` from the row's top down to the
    /// branch (├ carries on to the bottom), then across at mid-height to `branchToX`.
    struct Lines: Hashable, Sendable {
        var trunkX: Double
        var trunkFromY: Double
        var trunkToY: Double
        var branchY: Double
        var branchToX: Double
        /// The └ rounds its corner by this much; ├ meets at a right angle.
        var cornerRadius: Double
    }

    static func lines(_ connector: Connector, height: Double, trunkX: Double, branchToX: Double, corner: Double = 6) -> Lines {
        let mid = height / 2
        return Lines(
            trunkX: trunkX,
            trunkFromY: 0,
            trunkToY: connector == .tee ? height : mid,
            branchY: mid,
            branchToX: branchToX,
            cornerRadius: connector == .elbow ? min(corner, mid, max(branchToX - trunkX, 0)) : 0
        )
    }
}
