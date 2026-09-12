import ExpoModulesCore
import Dispatch
import Foundation
import MeeshogiSekireiCore

private let modelName = "c-leaf-wrm-seed42.bin"

public final class SekireiModule: Module {
  private let initializationQueue = DispatchQueue(label: "com.meeshogi.sekirei.initialize", qos: .utility)
  private let searchQueue = DispatchQueue(label: "com.meeshogi.sekirei.search", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("MeeshogiSekirei")

    AsyncFunction("initializeAsync") {
      try self.initializeModel()
    }.runOnQueue(initializationQueue)

    Function("prepareRequest") {
      Int(meeshogi_sekirei_prepare_request())
    }

    AsyncFunction("analyzeAsync") { (sfen: String, nodes: Int, multiPV: Int, requestId: Int) throws -> String in
      guard nodes > 0, nodes <= Int(UInt32.max) else {
        throw NSError(domain: "MeeshogiSekirei", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid node limit"])
      }
      guard let sfenPointer = sfen.cString(using: .utf8) else {
        throw NSError(domain: "MeeshogiSekirei", code: 2, userInfo: [NSLocalizedDescriptionKey: "SFEN is not UTF-8"])
      }
      let resultPointer = meeshogi_sekirei_analyze(
        sfenPointer,
        UInt64(nodes),
        UInt32(max(0, multiPV)),
        UInt64(max(0, requestId))
      )
      guard let resultPointer else {
        throw NSError(domain: "MeeshogiSekirei", code: 3, userInfo: [NSLocalizedDescriptionKey: "Sekirei returned no analysis"])
      }
      defer { meeshogi_sekirei_free_string(resultPointer) }
      return String(cString: resultPointer)
    }.runOnQueue(searchQueue)

    // The Rust cancellation path is one atomic store. Keep it synchronous so
    // it cannot queue behind the serial search worker that it is meant to stop.
    Function("cancelAsync") { (requestId: Int) in
      meeshogi_sekirei_cancel(UInt64(max(0, requestId)))
    }
  }

  private func initializeModel() throws {
    guard let modelURL = bundledModelURL() else {
      throw NSError(domain: "MeeshogiSekirei", code: 4, userInfo: [NSLocalizedDescriptionKey: "Bundled Sekirei model was not found"])
    }
    let path = modelURL.path.cString(using: .utf8)
    guard let path else {
      throw NSError(domain: "MeeshogiSekirei", code: 5, userInfo: [NSLocalizedDescriptionKey: "Model path is not UTF-8"])
    }
    guard meeshogi_sekirei_init(path) == 0 else {
      throw NSError(domain: "MeeshogiSekirei", code: 6, userInfo: [NSLocalizedDescriptionKey: "Sekirei model validation failed"])
    }
  }

  private func bundledModelURL() -> URL? {
    let bundles = [Bundle.main, Bundle(for: type(of: self))]
    for bundle in bundles {
      if let direct = bundle.url(forResource: modelName, withExtension: nil) {
        return direct
      }
      if let resourceBundleURL = bundle.url(forResource: "MeeshogiSekireiAssets", withExtension: "bundle"),
         let resourceBundle = Bundle(url: resourceBundleURL),
         let nested = resourceBundle.url(forResource: modelName, withExtension: nil) {
        return nested
      }
    }
    return nil
  }
}
