import Foundation

/// The folder the app, the share extension and the widget all see.
enum Group {
    static let id = "group.com.grahamdeno.shoebox"

    static var container: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
            ?? FileManager.default.temporaryDirectory
    }

    /// Things shared from other apps, waiting for Shoebox to take them in.
    static var inbox: URL {
        let url = container.appendingPathComponent("Inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// What the widget shows: today's posts, written by the app.
    static var todayFile: URL { container.appendingPathComponent("today.json") }
}

/// One thing shared into Shoebox.
struct SharedThing: Codable {
    var kind: String        // "url", "text" or "file"
    var value: String?      // the link or the text
    var file: String?       // a file name inside Inbox
    var mime: String?
    var title: String?
    var at: Date = Date()
}

/// A post on the widget.
struct TodayPost: Codable, Hashable {
    var id: String
    var title: String
    var why: String?
    var kind: String?
    var done: Bool?
}

struct TodaySnapshot: Codable {
    var greeting: String?
    var left: Int
    var posts: [TodayPost]
    var at: Date = Date()
}
