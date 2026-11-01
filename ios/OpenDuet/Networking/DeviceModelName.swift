// M28 (docs/API.md "M28 sessions"): the device's model name for X-Device-Name ("iPhone 16 Pro",
// "iPad Air"), from a table keyed by the hardware identifier (utsname.machine, "iPhone17,1"); in the
// simulator, the simulated device's identifier (SIMULATOR_MODEL_IDENTIFIER). An identifier the table
// doesn't know reads "iPhone" / "iPad" (by its prefix, else by the interface idiom). Never
// UIDevice.current.name: that is the user's own name for the phone. Foundation only (host tests);
// the idiom is read in the app alone.
import Foundation
#if canImport(UIKit)
import UIKit
#endif

enum DeviceModelName {
    /// This device's model name, read once (the hardware doesn't change while the app runs).
    static let current: String = name(
        machine: machine(),
        simulatorModel: ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"],
        idiomIsPad: idiomIsPad()
    )

    /// The rule: the table's name for the identifier, else "iPad" / "iPhone" by the identifier's
    /// prefix, else by the idiom.
    static func name(machine: String?, simulatorModel: String?, idiomIsPad: Bool) -> String {
        let id = identifier(machine: machine, simulatorModel: simulatorModel)
        if let id, let known = table[id] { return known }
        if let id, id.hasPrefix("iPad") { return "iPad" }
        if let id, id.hasPrefix("iPhone") { return "iPhone" }
        return idiomIsPad ? "iPad" : "iPhone"
    }

    /// The model identifier: `machine`, or the simulated device's when `machine` is the Mac's CPU
    /// ("arm64" / "x86_64": the simulator); nil when there is none.
    static func identifier(machine: String?, simulatorModel: String?) -> String? {
        let machine = machine?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if machine == "arm64" || machine == "x86_64" || machine == "i386" {
            let simulated = simulatorModel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return simulated.isEmpty ? nil : simulated
        }
        return machine.isEmpty ? nil : machine
    }

    /// An iPad's model name ("This iPad", the row's tile).
    static func isIPad(_ name: String?) -> Bool {
        name?.hasPrefix("iPad") == true
    }

    /// Identifier -> name: every iPhone from the XS on, and the iPads iPadOS 18 runs on by family
    /// (the app runs on an iPad as an iPhone app). A newer model reads "iPhone" / "iPad" until it is
    /// added here. Every name is printable ASCII (the X-Device-Name rule).
    static let table: [String: String] = {
        var table: [String: String] = [:]
        for (name, ids) in groups {
            for id in ids { table[id] = name }
        }
        return table
    }()

    private static let groups: [(String, [String])] = [
        ("iPhone XS", ["iPhone11,2"]),
        ("iPhone XS Max", ["iPhone11,4", "iPhone11,6"]),
        ("iPhone XR", ["iPhone11,8"]),
        ("iPhone 11", ["iPhone12,1"]),
        ("iPhone 11 Pro", ["iPhone12,3"]),
        ("iPhone 11 Pro Max", ["iPhone12,5"]),
        ("iPhone SE (2nd generation)", ["iPhone12,8"]),
        ("iPhone 12 mini", ["iPhone13,1"]),
        ("iPhone 12", ["iPhone13,2"]),
        ("iPhone 12 Pro", ["iPhone13,3"]),
        ("iPhone 12 Pro Max", ["iPhone13,4"]),
        ("iPhone 13 Pro", ["iPhone14,2"]),
        ("iPhone 13 Pro Max", ["iPhone14,3"]),
        ("iPhone 13 mini", ["iPhone14,4"]),
        ("iPhone 13", ["iPhone14,5"]),
        ("iPhone SE (3rd generation)", ["iPhone14,6"]),
        ("iPhone 14", ["iPhone14,7"]),
        ("iPhone 14 Plus", ["iPhone14,8"]),
        ("iPhone 14 Pro", ["iPhone15,2"]),
        ("iPhone 14 Pro Max", ["iPhone15,3"]),
        ("iPhone 15", ["iPhone15,4"]),
        ("iPhone 15 Plus", ["iPhone15,5"]),
        ("iPhone 15 Pro", ["iPhone16,1"]),
        ("iPhone 15 Pro Max", ["iPhone16,2"]),
        ("iPhone 16 Pro", ["iPhone17,1"]),
        ("iPhone 16 Pro Max", ["iPhone17,2"]),
        ("iPhone 16", ["iPhone17,3"]),
        ("iPhone 16 Plus", ["iPhone17,4"]),
        ("iPhone 16e", ["iPhone17,5"]),
        ("iPhone 17 Pro", ["iPhone18,1"]),
        ("iPhone 17 Pro Max", ["iPhone18,2"]),
        ("iPhone 17", ["iPhone18,3"]),
        ("iPhone Air", ["iPhone18,4"]),
        ("iPad", [
            "iPad7,11", "iPad7,12", "iPad11,6", "iPad11,7", "iPad12,1", "iPad12,2",
            "iPad13,18", "iPad13,19", "iPad15,7", "iPad15,8",
        ]),
        ("iPad mini", ["iPad11,1", "iPad11,2", "iPad14,1", "iPad14,2", "iPad16,1", "iPad16,2"]),
        ("iPad Air", [
            "iPad11,3", "iPad11,4", "iPad13,1", "iPad13,2", "iPad13,16", "iPad13,17",
            "iPad14,8", "iPad14,9", "iPad14,10", "iPad14,11", "iPad15,3", "iPad15,4", "iPad15,5", "iPad15,6",
        ]),
        ("iPad Pro", [
            "iPad8,1", "iPad8,2", "iPad8,3", "iPad8,4", "iPad8,5", "iPad8,6", "iPad8,7", "iPad8,8",
            "iPad8,9", "iPad8,10", "iPad8,11", "iPad8,12",
            "iPad13,4", "iPad13,5", "iPad13,6", "iPad13,7", "iPad13,8", "iPad13,9", "iPad13,10", "iPad13,11",
            "iPad14,3", "iPad14,4", "iPad14,5", "iPad14,6",
            "iPad16,3", "iPad16,4", "iPad16,5", "iPad16,6",
        ]),
    ]

    /// utsname.machine: "iPhone17,1" on a device, the Mac's CPU in the simulator and on the Mac.
    private static func machine() -> String? {
        var info = utsname()
        guard uname(&info) == 0 else { return nil }
        return withUnsafeBytes(of: info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    /// The interface idiom, only for an identifier that names neither an iPhone nor an iPad; read on
    /// the main thread only (off it: not an iPad).
    private static func idiomIsPad() -> Bool {
        #if canImport(UIKit)
        guard Thread.isMainThread else { return false }
        return MainActor.assumeIsolated { UIDevice.current.userInterfaceIdiom == .pad }
        #else
        return false
        #endif
    }
}
