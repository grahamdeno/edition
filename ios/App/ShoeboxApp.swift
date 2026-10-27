import SwiftUI
import UserNotifications

/// Shoebox for iPhone. The app is the Shoebox web app (always the latest
/// version, from GitHub Pages) in a native shell that adds what a web app
/// can't do on iPhone: the share sheet, a home-screen widget, and
/// notifications scheduled on the phone itself.
@main
struct ShoeboxApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ShoeboxView()
                .ignoresSafeArea()
                .onOpenURL { Bridge.shared.open($0) }
        }
        .onChange(of: phase) { _, now in
            if now == .active { Bridge.shared.becameActive() }
        }
    }
}

struct ShoeboxView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController { Bridge.shared.controller }
    func updateUIViewController(_ controller: WebViewController, context: Context) {}
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Show reminders even while Shoebox is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    /// A tapped reminder opens its post.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if let id = response.notification.request.content.userInfo["id"] as? String {
            await MainActor.run { Bridge.shared.openItem(id) }
        }
    }
}

/// The one web view, and the way in for links, widgets and notifications.
@MainActor
final class Bridge {
    static let shared = Bridge()
    let controller = WebViewController()

    func becameActive() { controller.takeInShares(); controller.run("window.shoeboxActive && window.shoeboxActive()") }

    /// shoebox://open?id=… (from the widget)
    func open(_ url: URL) {
        guard url.scheme == "shoebox" else { return }
        let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "id" }?.value
        if let id { openItem(id) }
    }

    func openItem(_ id: String) {
        let safe = id.replacingOccurrences(of: "'", with: "")
        controller.run("window.shoeboxOpen && window.shoeboxOpen('\(safe)')")
    }
}
