import ExpoModulesCore
import StoreKit
import UIKit

/**
 * The App Store half of updates on an iPhone. iOS has no way for an app to download its own
 * update, so the most it can do is put its App Store page in front of the person, where one
 * tap updates it. This only reports what the install is and shows the page it's told to;
 * whether there is a newer version, and when to offer it, is decided in src/updates/appStore.ts.
 */
public final class AppStoreUpdatesModule: Module {
  // SKStoreProductViewController holds its delegate weakly.
  private var sheet: StoreSheet?

  public func definition() -> ModuleDefinition {
    Name("SattleAppStoreUpdates")

    AsyncFunction("install") { () -> [String: Any] in
      let os = ProcessInfo.processInfo.operatingSystemVersion
      return [
        "bundleId": Bundle.main.bundleIdentifier ?? "",
        "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
        "osVersion": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
        // Apple's lookup takes a storefront's two-letter code, and StoreKit names the phone's
        // storefront only in three letters. The phone's region stands in for it.
        "region": Locale.current.region?.identifier ?? "",
        // TestFlight, Xcode and the simulator have a sandbox receipt, and the App Store can't
        // update them. The receipt is deprecated, but AppTransaction can ask the person to
        // sign in to find out the same thing.
        "fromAppStore": Bundle.main.appStoreReceiptURL?.lastPathComponent == "receipt"
      ]
    }

    // Resolves once the page has loaded, or once the person closes the sheet, whichever is
    // first. Rejects if the page doesn't load, and the JS side then opens the App Store app on
    // it instead.
    AsyncFunction("show") { [weak self] (appId: Int, promise: Promise) in
      guard let self, let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_STORE_PAGE", "There is no screen to show the App Store page on")
        return
      }
      let sheet = StoreSheet(promise: promise) { [weak self] in self?.sheet = nil }
      self.sheet = sheet
      sheet.show(appId: appId, on: presenter)
    }.runOnQueue(.main)
  }
}

/**
 * One showing of the App Store page. It answers the JS side once, with whichever comes first:
 * the page loading, the page failing to load, or the person closing the sheet. Closing it while
 * the page is still loading is an answer too, so Update works again and nothing else opens.
 * Everything here runs on the main queue.
 */
private final class StoreSheet: NSObject, SKStoreProductViewControllerDelegate {
  private let promise: Promise
  private let onEnd: () -> Void
  private var settled = false
  // UIKit ignores a dismiss while the sheet is still coming up, so a load that fails before then
  // waits here for it.
  private var presented = false
  private var earlyFailure: String?

  init(promise: Promise, onEnd: @escaping () -> Void) {
    self.promise = promise
    self.onEnd = onEnd
  }

  func show(appId: Int, on presenter: UIViewController) {
    let store = SKStoreProductViewController()
    store.delegate = self
    // Up straight away, with the App Store's own spinner while the page loads.
    presenter.present(store, animated: true) {
      self.presented = true
      if let failure = self.earlyFailure { self.fail(store, failure) }
    }
    store.loadProduct(withParameters: [SKStoreProductParameterITunesItemIdentifier: NSNumber(value: appId)]) { loaded, error in
      DispatchQueue.main.async {
        if loaded { return self.settle(nil) }
        // Closed by the person before it failed: they're done with it.
        guard !self.settled else { return }
        let failure = error?.localizedDescription ?? "The App Store page didn't load"
        if self.presented { self.fail(store, failure) } else { self.earlyFailure = failure }
      }
    }
  }

  func productViewControllerDidFinish(_ viewController: SKStoreProductViewController) {
    viewController.dismiss(animated: true)
    // Closed by the person, loaded or not, so nothing else opens.
    settle(nil)
    onEnd()
  }

  private func fail(_ store: SKStoreProductViewController, _ failure: String) {
    store.dismiss(animated: true)
    settle(failure)
    onEnd()
  }

  private func settle(_ failure: String?) {
    guard !settled else { return }
    settled = true
    if let failure {
      promise.reject("ERR_STORE_PAGE", failure)
    } else {
      promise.resolve(nil)
    }
  }
}
