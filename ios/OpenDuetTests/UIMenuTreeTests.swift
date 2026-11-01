// The side menu's tree (Menu/MenuTree.swift, prompt L123): channels hang under Everything in the
// server's order with ├ connectors, "+ New channel" closes the tree with └, where the selection
// pill goes, and the line geometry each row draws.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Menu tree")
struct UIMenuTreeTests {
    @Test func channelsTeeAndNewChannelCloses() {
        let branches = MenuTree.branches(channelIds: ["q4", "hiring", "home"])
        #expect(branches.map(\.node) == [.channel(id: "q4"), .channel(id: "hiring"), .channel(id: "home"), .newChannel])
        #expect(branches.map(\.connector) == [.tee, .tee, .tee, .elbow])
    }

    @Test func noChannelsLeavesOnlyNewChannel() {
        let branches = MenuTree.branches(channelIds: [])
        #expect(branches.map(\.node) == [.newChannel])
        #expect(branches.map(\.connector) == [.elbow])
    }

    @Test func everythingIsSelectedWithoutAListedChannel() {
        #expect(MenuTree.everythingSelected(selectedChannelId: nil, channelIds: ["a"]))
        #expect(!MenuTree.everythingSelected(selectedChannelId: "a", channelIds: ["a", "b"]))
        // The selected channel was archived elsewhere: Everything holds the pill until the store moves.
        #expect(MenuTree.everythingSelected(selectedChannelId: "gone", channelIds: ["a"]))
    }

    @Test func teeRunsThroughAndElbowStopsAtTheBranch() {
        let tee = MenuTree.lines(.tee, height: 48, trunkX: 23, branchToX: 40)
        #expect(tee.trunkFromY == 0)
        #expect(tee.trunkToY == 48)
        #expect(tee.branchY == 24)
        #expect(tee.branchToX == 40)
        #expect(tee.cornerRadius == 0)

        let elbow = MenuTree.lines(.elbow, height: 48, trunkX: 23, branchToX: 40)
        #expect(elbow.trunkToY == 24)
        #expect(elbow.cornerRadius == 6)
    }

    @Test func elbowCornerNeverOvershootsAShortRow() {
        #expect(MenuTree.lines(.elbow, height: 8, trunkX: 23, branchToX: 40).cornerRadius == 4)
        #expect(MenuTree.lines(.elbow, height: 48, trunkX: 23, branchToX: 26).cornerRadius == 3)
    }
}
