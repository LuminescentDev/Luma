import Foundation
import UIKit

/*
 * Native menu bridge, sibling to LumaTabBar.swift. A UIMenu presented over the
 * webview renders in real Liquid Glass on iOS 26 — with the system's own
 * material, checkmarks, symbol layout and dismissal behaviour — none of which
 * web content can reproduce.
 *
 * A UIMenu has no public "present at a point" API, so this uses the supported
 * route: a zero-alpha UIButton parked at the anchor rect with the menu attached
 * as its primary action, triggered with performPrimaryAction(). That call is
 * iOS 17.4+; below it the bridge declines and the frontend keeps its web sheet.
 *
 * Selection is reported one-way, like a real menu: dismissing without choosing
 * simply reports nothing, so there is no result to wait on and nothing to leak.
 */

/// Declared by the Rust side (src/commands/menu.rs) and linked in from libapp.a.
@_silgen_name("luma_menu_did_select")
func luma_menu_did_select(_ id: UnsafePointer<CChar>?)

private struct LumaMenuItem: Decodable {
  let id: String
  let title: String
  let sfSymbol: String?
  let selected: Bool
}

private struct LumaMenuAnchor: Decodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

private struct LumaMenuConfig: Decodable {
  let items: [LumaMenuItem]
  let anchor: LumaMenuAnchor
  let appearance: String
}

/// Present the menu anchored to the given viewport rect. Returns false when no
/// native menu could be shown, which Rust reports as an error so the frontend
/// falls back to its web sheet.
@_cdecl("luma_menu_present")
func lumaMenuPresent(_ json: UnsafePointer<CChar>?) -> Bool {
  guard let json else { return false }
  let payload = Data(String(cString: json).utf8)
  guard let config = try? JSONDecoder().decode(LumaMenuConfig.self, from: payload) else {
    return false
  }
  guard #available(iOS 17.4, *) else { return false }
  if Thread.isMainThread {
    return LumaMenuController.shared.present(config)
  }
  return DispatchQueue.main.sync {
    LumaMenuController.shared.present(config)
  }
}

/// Anchor for the menu. Interaction stays enabled so UIKit's menu machinery
/// works, but every hit test passes through: the visible control is the React
/// button in the webview underneath, which must keep receiving taps.
private final class LumaMenuAnchorButton: UIButton {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    nil
  }
}

@available(iOS 17.4, *)
private final class LumaMenuController {
  static let shared = LumaMenuController()

  /// The invisible button the menu hangs off. Kept between presentations and
  /// repositioned, so re-opening cannot leave orphaned anchors behind.
  private var anchorButton: LumaMenuAnchorButton?

  func present(_ config: LumaMenuConfig) -> Bool {
    guard let host = LumaMenuController.hostView() else { return false }

    let button: LumaMenuAnchorButton
    if let existing = anchorButton, existing.superview === host {
      button = existing
    } else {
      anchorButton?.removeFromSuperview()
      button = LumaMenuAnchorButton(type: .custom)
      button.alpha = 0
      host.addSubview(button)
      anchorButton = button
    }

    host.bringSubviewToFront(button)
    let style: UIUserInterfaceStyle = config.appearance == "light" ? .light : .dark
    host.overrideUserInterfaceStyle = style
    button.overrideUserInterfaceStyle = style
    button.frame = CGRect(
      x: config.anchor.x, y: config.anchor.y,
      width: max(config.anchor.width, 1), height: max(config.anchor.height, 1))

    button.menu = UIMenu(
      children: config.items.map { item in
        UIAction(
          title: item.title,
          image: item.sfSymbol.flatMap { UIImage(systemName: $0) },
          state: item.selected ? .on : .off
        ) { _ in
          item.id.withCString { luma_menu_did_select($0) }
        }
      })
    button.showsMenuAsPrimaryAction = true
    button.performPrimaryAction()
    return true
  }

  private static func hostView() -> UIView? {
    let scenes = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
    let window =
      scenes.flatMap({ $0.windows }).first(where: { $0.isKeyWindow })
      ?? scenes.flatMap({ $0.windows }).first
    return window?.rootViewController?.view ?? window
  }
}
