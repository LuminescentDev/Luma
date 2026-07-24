import Foundation
import Darwin

/// Returns Luma's provisioned ubiquitous-container URL. Rust takes ownership
/// of the strdup allocation and releases it with libc::free.
@_cdecl("luma_icloud_container_path")
public func lumaICloudContainerPath() -> UnsafeMutablePointer<CChar>? {
    guard FileManager.default.ubiquityIdentityToken != nil,
          let url = FileManager.default.url(
              forUbiquityContainerIdentifier: "iCloud.dev.bwmp.luma"
          ) else {
        return nil
    }
    return strdup(url.path)
}
