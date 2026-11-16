import Foundation

/// The small slice of the latest brainstorm that the home-screen widget shows.
/// The app writes it to the shared App Group; the widget only reads it.
struct WidgetSnapshot: Codable, Equatable {
    var title: String
    var date: Date
    var highlights: [String]

    static let appGroup = "group.com.loomspar.ramble"
    private static let key = "latestSnapshot"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    static func load() -> WidgetSnapshot? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }

    /// Stores the snapshot (or clears it when `nil`). Returns true if anything changed.
    @discardableResult
    static func store(_ snapshot: WidgetSnapshot?) -> Bool {
        guard load() != snapshot else { return false }
        if let snapshot, let data = try? JSONEncoder().encode(snapshot) {
            defaults?.set(data, forKey: key)
        } else {
            defaults?.removeObject(forKey: key)
        }
        return true
    }
}
