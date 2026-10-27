import UIKit
import WebKit
import UserNotifications
import WidgetKit
import EventKit
import CoreLocation

/// Shows Shoebox and answers what it asks of the phone.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private let home = URL(string: "https://shoebox.tangomike.app/?native=1")!
    private var web: WKWebView!
    private var ready = false          // Shoebox has started and can take things in
    private var queued: [String] = []  // scripts waiting for that
    private let events = EKEventStore()
    private var locator: Locator?

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Shoebox's own address (and the video players it embeds) are this app's domains: that turns on
        // the web app's offline copy (its service worker), so Shoebox opens without a connection.
        config.limitsNavigationsToAppBoundDomains = true
        let content = WKUserContentController()
        content.add(WeakHandler(self), name: "shoebox")
        content.addUserScript(WKUserScript(source: "window.shoeboxNative = { version: 2, platform: 'ios', features: ['calendar', 'location', 'backup'] };",
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = content

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.allowsLinkPreview = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.isOpaque = false
        web.backgroundColor = UIColor { $0.userInterfaceStyle == .dark
            ? UIColor(red: 0x1B / 255, green: 0x10 / 255, blue: 0x33 / 255, alpha: 1)
            : UIColor(red: 0xFB / 255, green: 0xF8 / 255, blue: 0xFF / 255, alpha: 1) }
        web.scrollView.backgroundColor = web.backgroundColor
        if #available(iOS 16.4, *) { web.isInspectable = true }
        view = web
        web.load(URLRequest(url: home))
    }

    /// Run a script in Shoebox now, or once it has started.
    func run(_ script: String) {
        guard ready else { queued.append(script); return }
        web.evaluateJavaScript(script, completionHandler: nil)
    }

    // MARK: Things shared from other apps

    /// Hand everything waiting in the shared Inbox to Shoebox, then clear it.
    func takeInShares() {
        guard ready else { return }
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: Group.inbox, includingPropertiesForKeys: nil)) ?? []
        let notes = files.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        guard !notes.isEmpty else { return }
        var payload: [[String: Any]] = []
        for note in notes {
            guard let data = try? Data(contentsOf: note), let thing = try? JSONDecoder().decode(SharedThing.self, from: data) else {
                try? fm.removeItem(at: note); continue
            }
            var out: [String: Any] = ["kind": thing.kind]
            if let v = thing.value { out["value"] = v }
            if let t = thing.title { out["title"] = t }
            if let f = thing.file {
                let url = Group.inbox.appendingPathComponent(f)
                if let bytes = try? Data(contentsOf: url) {
                    out["name"] = f
                    out["mime"] = thing.mime ?? "application/octet-stream"
                    out["data"] = bytes.base64EncodedString()
                }
                try? fm.removeItem(at: url)
            }
            payload.append(out)
            try? fm.removeItem(at: note)
        }
        guard let json = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: json, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.shoeboxReceive && window.shoeboxReceive(\(text))", completionHandler: nil)
    }

    // MARK: Messages from Shoebox

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            queued.forEach { web.evaluateJavaScript($0, completionHandler: nil) }
            queued.removeAll()
            takeInShares()
        case "today":
            saveToday(body)
        case "remind":
            remind(body)
        case "cancel":
            if let id = body["id"] as? String {
                UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["remind-\(id)"])
            }
        case "calendar":
            calendar(body)
        case "location":
            location(body)
        case "backup":
            backup(body)
        case "haptic":
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        default:
            break
        }
    }

    /// The answer to a question Shoebox asked (calendar, location), by its id.
    private func reply(_ id: String, _ payload: [String: Any]) {
        guard id.range(of: "^[A-Za-z0-9_-]{1,40}$", options: .regularExpression) != nil,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.web.evaluateJavaScript("window.shoeboxReply && window.shoeboxReply('\(id)', \(text))", completionHandler: nil)
        }
    }

    /// Events from the iPhone's own calendars (iCloud, Google, Exchange: whatever is in the Calendar app).
    /// Asks for access only when Shoebox says the person tapped to turn it on.
    private func calendar(_ body: [String: Any]) {
        guard let id = body["id"] as? String else { return }
        let now = Date().timeIntervalSince1970 * 1000
        let from = Date(timeIntervalSince1970: (body["from"] as? Double ?? now) / 1000)
        let to = Date(timeIntervalSince1970: (body["to"] as? Double ?? now + 86_400_000) / 1000)
        let ask = body["ask"] as? Bool ?? false
        let store = events
        let read: () -> Void = { [weak self] in
            let found = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil)).map { e -> [String: Any] in
                var o: [String: Any] = [
                    "uid": e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? UUID().uuidString,
                    "title": e.title ?? "",
                    "start": e.startDate.timeIntervalSince1970 * 1000,
                    "end": e.endDate.timeIntervalSince1970 * 1000,
                    "allDay": e.isAllDay,
                    "calendar": e.calendar?.title ?? "Calendar",
                ]
                if let l = e.location, !l.isEmpty { o["location"] = l }
                if let n = e.notes, !n.isEmpty { o["notes"] = String(n.prefix(2000)) }
                if let u = e.url { o["url"] = u.absoluteString }
                return o
            }
            self?.reply(id, ["ok": true, "events": found])
        }
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess:
            DispatchQueue.global(qos: .userInitiated).async(execute: read)
        case .notDetermined where ask:
            store.requestFullAccessToEvents { [weak self] granted, _ in
                if granted { read() } else { self?.reply(id, ["ok": false, "status": "denied"]) }
            }
        case .notDetermined:
            reply(id, ["ok": false, "status": "notAsked"])
        default:
            reply(id, ["ok": false, "status": "denied"])
        }
    }

    /// Where the phone is, roughly, for the morning weather. Asks only when Shoebox says to.
    private func location(_ body: [String: Any]) {
        guard let id = body["id"] as? String else { return }
        let ask = body["ask"] as? Bool ?? false
        let finder = Locator()
        locator = finder
        finder.find(ask: ask) { [weak self] place, status in
            self?.locator = nil
            guard let place else { self?.reply(id, ["ok": false, "status": status]); return }
            CLGeocoder().reverseGeocodeLocation(place) { marks, _ in
                var out: [String: Any] = ["ok": true, "lat": place.coordinate.latitude, "lon": place.coordinate.longitude]
                if let m = marks?.first {
                    if let city = m.locality { out["name"] = city }
                    if let zip = m.postalCode { out["zip"] = zip }
                }
                self?.reply(id, out)
            }
        }
    }

    /// Today's backup, written where the Files app shows it (On My iPhone › Shoebox › Backups).
    /// The last 7 are kept; the folder is part of the iPhone's own iCloud Backup.
    private func backup(_ body: [String: Any]) {
        guard let id = body["id"] as? String else { return }
        guard let name = body["name"] as? String, name.range(of: "^[A-Za-z0-9._-]{1,80}\\.json$", options: .regularExpression) != nil,
              let text = body["data"] as? String else { reply(id, ["ok": false, "error": "bad backup"]); return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let fm = FileManager.default
            do {
                let docs = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let folder = docs.appendingPathComponent("Backups", isDirectory: true)
                try fm.createDirectory(at: folder, withIntermediateDirectories: true)
                try Data(text.utf8).write(to: folder.appendingPathComponent(name), options: .atomic)
                let old = (try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil))
                    .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent > $1.lastPathComponent }.dropFirst(7)
                old.forEach { try? fm.removeItem(at: $0) }
                self?.reply(id, ["ok": true])
            } catch {
                self?.reply(id, ["ok": false, "error": error.localizedDescription])
            }
        }
    }

    /// Today's posts, for the widget.
    private func saveToday(_ body: [String: Any]) {
        let posts = (body["posts"] as? [[String: Any]] ?? []).compactMap { p -> TodayPost? in
            guard let id = p["id"] as? String, let title = p["title"] as? String else { return nil }
            return TodayPost(id: id, title: title, why: p["why"] as? String, kind: p["kind"] as? String, done: p["done"] as? Bool)
        }
        let snap = TodaySnapshot(greeting: body["greeting"] as? String, left: body["left"] as? Int ?? posts.filter { $0.done != true }.count, posts: posts)
        if let data = try? JSONEncoder().encode(snap) {
            try? data.write(to: Group.todayFile, options: .atomic)
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// A set-aside reminder, scheduled on the phone: no server needed.
    private func remind(_ body: [String: Any]) {
        guard let id = body["id"] as? String, let at = body["at"] as? Double else { return }
        let when = Date(timeIntervalSince1970: at / 1000)
        guard when > Date() else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = body["title"] as? String ?? "Back in Shoebox"
            content.body = body["body"] as? String ?? ""
            content.sound = .default
            content.userInfo = ["id": id]
            let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: when)
            let request = UNNotificationRequest(identifier: "remind-\(id)", content: content,
                                                trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false))
            center.add(request)
        }
    }

    // MARK: Links and downloads

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == "shoebox-retry" { web.load(URLRequest(url: home)); return .cancel }
        if action.shouldPerformDownload { return .download }
        let scheme = url.scheme ?? ""
        if ["blob", "data", "about"].contains(scheme) { return .allow }
        if action.targetFrame?.isMainFrame == false { return .allow } // embedded videos
        if url.host == home.host { return .allow }
        // Everything else (articles, Apple Music, highlights) opens in its own app or Safari.
        await UIApplication.shared.open(url)
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        response.canShowMIMEType ? .allow : .download
    }

    /// target="_blank" links open outside the app.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    private var downloadURL: URL?
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(suggestedFilename)
        try? FileManager.default.removeItem(at: url)
        downloadURL = url
        return url
    }

    /// A finished download (a backup, a calendar file) goes to the share sheet: Files, Mail, Calendar.
    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadURL else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        present(sheet, animated: true)
    }

    /// No connection and no offline copy yet (the very first launch): say so plainly, with a way to try again.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let code = (error as NSError).code
        guard code != NSURLErrorCancelled, code != 102 /* frame load interrupted: a download or an outside link */ else { return }
        showOffline()
    }

    private func showOffline() {
        let dark = traitCollection.userInterfaceStyle == .dark
        let html = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;box-sizing:border-box;
        font:17px -apple-system,system-ui,sans-serif;text-align:center;background:\(dark ? "#1B1033" : "#FBF8FF");color:\(dark ? "#F3ECFF" : "#22123B")}
        h1{font:400 34px Georgia,serif;margin:0}p{margin:0;opacity:.75;max-width:320px}
        a{display:inline-block;margin-top:8px;padding:12px 22px;border-radius:999px;background:#7B3FF2;color:#fff;text-decoration:none;font-weight:600}</style></head>
        <body><h1>Shoebox</h1><p>Shoebox needs a connection the first time it opens. After that it works offline too.</p><a href="shoebox-retry://">Try again</a></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    /// If the page dies in the background, start it again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        webView.reload()
    }
}

/// One rough location fix (to the kilometre), then done.
final class Locator: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var done: ((CLLocation?, String) -> Void)?
    private var ask = false

    func find(ask: Bool, done: @escaping (CLLocation?, String) -> Void) {
        self.done = done
        self.ask = ask
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
        manager.delegate = self // answers with the current permission straight away
    }

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        switch m.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: m.requestLocation()
        case .notDetermined: if ask { ask = false; m.requestWhenInUseAuthorization() } else { finish(nil, "notAsked") }
        default: finish(nil, "denied")
        }
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations list: [CLLocation]) { finish(list.last, "ok") }
    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) { finish(nil, "failed") }

    private func finish(_ place: CLLocation?, _ status: String) {
        guard let d = done else { return }
        done = nil
        d(place, status)
    }
}

/// Keeps the message handler from holding the controller forever.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}
