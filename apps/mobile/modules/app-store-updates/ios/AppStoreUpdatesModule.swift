import ExpoModulesCore
import StoreKit

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

    // Resolves once the page has loaded. Rejects if it doesn't load, and the JS side then
    // opens the App Store app on it instead.
    AsyncFunction("show") { (appId: Int, promise: Promise) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_STORE_PAGE", "There is no screen to show the App Store page on")
        return
      }
      let store = SKStoreProductViewController()
      let sheet = StoreSheet { [weak self] in self?.sheet = nil }
      store.delegate = sheet
      self.sheet = sheet
      // Up straight away, with the App Store's own spinner while the page loads.
      presenter.present(store, animated: true)
      store.loadProduct(withParameters: [SKStoreProductParameterITunesItemIdentifier: NSNumber(value: appId)]) { loaded, error in
        DispatchQueue.main.async {
          if loaded {
            promise.resolve(nil)
            return
          }
          store.dismiss(animated: true)
          promise.reject("ERR_STORE_PAGE", error?.localizedDescription ?? "The App Store page didn't load")
        }
      }
    }.runOnQueue(.main)
  }
}

private final class StoreSheet: NSObject, SKStoreProductViewControllerDelegate {
  private let onClose: () -> Void

  init(onClose: @escaping () -> Void) {
    self.onClose = onClose
  }

  func productViewControllerDidFinish(_ viewController: SKStoreProductViewController) {
    viewController.dismiss(animated: true)
    onClose()
  }
}
