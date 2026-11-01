// The session token, in the Keychain (generic password, account = the server address).
// Never in UserDefaults, logs or the user cache.
import Foundation
import Security

enum TokenStore {
    private static let service = "dev.openduet.OpenDuet.session"

    static func token(for server: ServerAddress) -> String? {
        var query = baseQuery(server)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func save(_ token: String, for server: ServerAddress) -> Bool {
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery(server) as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = baseQuery(server)
        add[kSecValueData as String] = data
        // Readable after the first unlock (background refresh), never synced or backed up elsewhere.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func delete(for server: ServerAddress) {
        SecItemDelete(baseQuery(server) as CFDictionary)
    }

    private static func baseQuery(_ server: ServerAddress) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: server.string,
        ]
    }
}
