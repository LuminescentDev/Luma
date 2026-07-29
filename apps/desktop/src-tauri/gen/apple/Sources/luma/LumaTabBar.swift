import Foundation
import UIKit

/*
 * Native tab bar bridge. WebKit exposes no CSS primitive for the iOS 26 Liquid
 * Glass material, so the bar cannot be drawn inside the webview at any fidelity —
 * it has to be a real UIKit view pinned over it. The Rust static library is
 * linked into this app binary, so the tab_bar_* Tauri commands reach these
 * @_cdecl symbols directly (see src/commands/tab_bar.rs), following the same
 * pattern as the Live Activity bridge rather than a Tauri mobile plugin.
 *
 * The bar is deliberately NOT a UITabBarController: all three tabs are the same
 * webview showing different React routes, so this only renders chrome and
 * reports taps back through `luma_tab_bar_did_select`.
 *
 * Liquid Glass (UIGlassEffect) is iOS 26+; the app deploys to 14.0, so every
 * glass path is availability guarded and falls back to a
 * .systemUltraThinMaterial blur, which is the closest pre-26 material.
 */

/// Declared by the Rust side (src/commands/tab_bar.rs) and linked in from
/// libapp.a. Called on the main thread when a tab is tapped.
@_silgen_name("luma_tab_bar_did_select")
func luma_tab_bar_did_select(_ id: UnsafePointer<CChar>?)

private struct LumaTabItem: Decodable {
  let id: String
  let label: String
  let sfSymbol: String
  let badge: Int
}

private struct LumaTabBarConfig: Decodable {
  let tabs: [LumaTabItem]
  let selected: String
}

/// Attach the bar over the webview and return the height it occupies in points
/// (which equal CSS pixels for the webview's layout viewport). Returns 0 when
/// the bar could not be attached, which Rust reports as an error so the
/// frontend keeps its own web capsule.
@_cdecl("luma_tab_bar_attach")
func lumaTabBarAttach(_ json: UnsafePointer<CChar>?) -> Double {
  guard let json else { return 0 }
  let payload = Data(String(cString: json).utf8)
  guard let config = try? JSONDecoder().decode(LumaTabBarConfig.self, from: payload) else {
    return 0
  }
  // UIKit is main-thread only, and this has to return the measured height
  // synchronously. Tauri may dispatch a sync command on either the main thread
  // or a worker, and DispatchQueue.main.sync from the main thread deadlocks —
  // so only hop when we are not already there.
  if Thread.isMainThread {
    return LumaTabBarController.shared.attach(config)
  }
  return DispatchQueue.main.sync {
    LumaTabBarController.shared.attach(config)
  }
}

@_cdecl("luma_tab_bar_update")
func lumaTabBarUpdate(_ json: UnsafePointer<CChar>?) {
  guard let json else { return }
  let payload = Data(String(cString: json).utf8)
  guard let config = try? JSONDecoder().decode(LumaTabBarConfig.self, from: payload) else {
    return
  }
  DispatchQueue.main.async {
    LumaTabBarController.shared.update(config)
  }
}

@_cdecl("luma_tab_bar_set_visible")
func lumaTabBarSetVisible(_ visible: Bool) {
  DispatchQueue.main.async {
    LumaTabBarController.shared.setVisible(visible)
  }
}

/// Owns the floating bar view and its lifetime. Single instance: there is one
/// webview and one bar.
private final class LumaTabBarController {
  static let shared = LumaTabBarController()

  private var barView: LumaTabBarView?
  /// Hidden by the app (full-screen terminal) as opposed to hidden by the
  /// keyboard. Tracked separately so dismissing the keyboard does not reveal a
  /// bar the app asked to hide.
  private var hiddenByApp = false
  private var keyboardVisible = false

  private static let barHeight: CGFloat = 64
  private static let bottomInset: CGFloat = 8

  /// Total height the bar occupies above the safe-area inset.
  private var occupiedHeight: CGFloat { Self.barHeight + Self.bottomInset }

  func attach(_ config: LumaTabBarConfig) -> Double {
    guard let host = Self.hostView() else { return 0 }

    if barView == nil {
      let view = LumaTabBarView(height: Self.barHeight) { id in
        // Back into Rust, which re-emits as a Tauri event for the frontend.
        id.withCString { luma_tab_bar_did_select($0) }
      }
      view.translatesAutoresizingMaskIntoConstraints = false
      host.addSubview(view)
      NSLayoutConstraint.activate([
        view.centerXAnchor.constraint(equalTo: host.safeAreaLayoutGuide.centerXAnchor),
        view.bottomAnchor.constraint(
          equalTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -Self.bottomInset),
        view.heightAnchor.constraint(equalToConstant: Self.barHeight),
        // Stay inside the screen on small devices without stretching edge to
        // edge on large ones: the capsule hugs its content up to a cap.
        view.leadingAnchor.constraint(
          greaterThanOrEqualTo: host.safeAreaLayoutGuide.leadingAnchor, constant: 16),
        view.trailingAnchor.constraint(
          lessThanOrEqualTo: host.safeAreaLayoutGuide.trailingAnchor, constant: -16),
      ])
      barView = view
      observeKeyboard()
    }

    update(config)
    return Double(occupiedHeight)
  }

  func update(_ config: LumaTabBarConfig) {
    barView?.apply(tabs: config.tabs, selected: config.selected)
  }

  func setVisible(_ visible: Bool) {
    hiddenByApp = !visible
    applyVisibility(animated: true)
  }

  private func applyVisibility(animated: Bool) {
    guard let barView else { return }
    let shouldHide = hiddenByApp || keyboardVisible
    let apply = {
      barView.alpha = shouldHide ? 0 : 1
      // Slide down as it fades so it reads as leaving the screen rather than
      // dissolving in place.
      barView.transform =
        shouldHide
        ? CGAffineTransform(translationX: 0, y: self.occupiedHeight + 24) : .identity
    }
    guard animated else {
      apply()
      barView.isUserInteractionEnabled = !shouldHide
      return
    }
    barView.isUserInteractionEnabled = !shouldHide
    UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut]) { apply() }
  }

  /// The keyboard covers the bottom of the screen, and in a terminal app it is
  /// up often. Hide the bar while it is, so it never floats over the keyboard.
  private func observeKeyboard() {
    let center = NotificationCenter.default
    center.addObserver(
      forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.keyboardVisible = true
      self?.applyVisibility(animated: true)
    }
    center.addObserver(
      forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.keyboardVisible = false
      self?.applyVisibility(animated: true)
    }
  }

  /// The view the bar is pinned into: the key window's root view, which is what
  /// hosts Tauri's WKWebView.
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

/// The floating capsule itself: a glass (or blurred) background with one button
/// per tab and a pill behind the selected one.
private final class LumaTabBarView: UIView {
  private let background = UIVisualEffectView(effect: nil)
  private let stack = UIStackView()
  private let selectionPill = UIVisualEffectView(effect: nil)
  private let onSelect: (String) -> Void
  private var buttons: [String: LumaTabButton] = [:]
  private var selectedId: String?

  init(height: CGFloat, onSelect: @escaping (String) -> Void) {
    self.onSelect = onSelect
    super.init(frame: .zero)

    background.translatesAutoresizingMaskIntoConstraints = false

    if #available(iOS 26.0, *) {
      // The real thing: Liquid Glass, which refracts and specularly highlights
      // the content scrolling underneath. Interactive so it responds to touch.
      let glass = UIGlassEffect(style: .regular)
      glass.isInteractive = true
      background.effect = glass
      // Shape glass with cornerConfiguration, NEVER clipsToBounds + a manual
      // cornerRadius: the material draws its lensing and specular edge along
      // (and slightly beyond) its own boundary, and clipping shears exactly
      // that away, flattening it into what looks like a plain blur.
      background.cornerConfiguration = .capsule()
    } else {
      background.effect = UIBlurEffect(style: .systemUltraThinMaterial)
      background.clipsToBounds = true
      background.layer.cornerRadius = height / 2
      background.layer.cornerCurve = .continuous
      // A hairline highlight and drop shadow stand in for the lit edge and
      // grounding that the real material renders for itself.
      background.layer.borderWidth = 0.5
      background.layer.borderColor = UIColor.white.withAlphaComponent(0.12).cgColor
      layer.shadowColor = UIColor.black.cgColor
      layer.shadowOpacity = 0.25
      layer.shadowRadius = 12
      layer.shadowOffset = CGSize(width: 0, height: 4)
    }
    addSubview(background)

    selectionPill.translatesAutoresizingMaskIntoConstraints = false
    selectionPill.isUserInteractionEnabled = false
    if #available(iOS 26.0, *) {
      // Glass nested on glass: the selected tab reads as a raised bubble that
      // lenses the bar beneath it, rather than a flat rectangle sliding around.
      selectionPill.effect = UIGlassEffect(style: .regular)
      selectionPill.cornerConfiguration = .capsule()
    } else {
      selectionPill.backgroundColor = UIColor.white.withAlphaComponent(0.12)
      selectionPill.layer.cornerCurve = .continuous
    }
    background.contentView.addSubview(selectionPill)

    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.axis = .horizontal
    stack.distribution = .fillEqually
    stack.spacing = 4
    background.contentView.addSubview(stack)

    NSLayoutConstraint.activate([
      background.topAnchor.constraint(equalTo: topAnchor),
      background.bottomAnchor.constraint(equalTo: bottomAnchor),
      background.leadingAnchor.constraint(equalTo: leadingAnchor),
      background.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.topAnchor.constraint(equalTo: background.contentView.topAnchor, constant: 6),
      stack.bottomAnchor.constraint(equalTo: background.contentView.bottomAnchor, constant: -6),
      stack.leadingAnchor.constraint(equalTo: background.contentView.leadingAnchor, constant: 6),
      stack.trailingAnchor.constraint(equalTo: background.contentView.trailingAnchor, constant: -6),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func apply(tabs: [LumaTabItem], selected: String) {
    // Rebuild only when the tab set itself changed; a selection or badge change
    // reuses the existing buttons so the pill can animate between them.
    let existing = stack.arrangedSubviews.compactMap { ($0 as? LumaTabButton)?.id }
    if existing != tabs.map(\.id) {
      stack.arrangedSubviews.forEach {
        stack.removeArrangedSubview($0)
        $0.removeFromSuperview()
      }
      buttons.removeAll()
      for tab in tabs {
        let button = LumaTabButton(item: tab) { [weak self] id in self?.onSelect(id) }
        buttons[tab.id] = button
        stack.addArrangedSubview(button)
      }
    }

    for tab in tabs {
      buttons[tab.id]?.update(item: tab, selected: tab.id == selected)
    }
    moveSelection(to: selected, animated: selectedId != nil)
    selectedId = selected
  }

  private var pillConstraints: [NSLayoutConstraint] = []

  private func moveSelection(to id: String, animated: Bool) {
    guard let target = buttons[id] else {
      selectionPill.isHidden = true
      return
    }
    selectionPill.isHidden = false
    NSLayoutConstraint.deactivate(pillConstraints)
    pillConstraints = [
      selectionPill.leadingAnchor.constraint(equalTo: target.leadingAnchor),
      selectionPill.trailingAnchor.constraint(equalTo: target.trailingAnchor),
      selectionPill.topAnchor.constraint(equalTo: target.topAnchor),
      selectionPill.bottomAnchor.constraint(equalTo: target.bottomAnchor),
    ]
    NSLayoutConstraint.activate(pillConstraints)

    let settle = {
      self.layoutIfNeeded()
      // Pre-26 the pill is a plain view, so its radius is maintained by hand.
      // On 26 the capsule cornerConfiguration owns the shape and writing to
      // layer.cornerRadius would fight it.
      if #unavailable(iOS 26.0) {
        self.selectionPill.layer.cornerRadius = self.selectionPill.bounds.height / 2
      }
    }
    guard animated else {
      settle()
      return
    }
    UIView.animate(
      withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0,
      options: [.curveEaseOut]
    ) { settle() }
  }
}

/// One tab: SF Symbol over a caption, with an optional badge.
private final class LumaTabButton: UIControl {
  let id: String
  private let icon = UIImageView()
  private let caption = UILabel()
  private let badge = UILabel()
  private let onSelect: (String) -> Void

  init(item: LumaTabItem, onSelect: @escaping (String) -> Void) {
    self.id = item.id
    self.onSelect = onSelect
    super.init(frame: .zero)

    icon.translatesAutoresizingMaskIntoConstraints = false
    icon.contentMode = .scaleAspectFit
    icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
      pointSize: 19, weight: .regular)

    caption.translatesAutoresizingMaskIntoConstraints = false
    caption.font = .systemFont(ofSize: 11, weight: .medium)
    caption.textAlignment = .center

    badge.translatesAutoresizingMaskIntoConstraints = false
    badge.font = .systemFont(ofSize: 10, weight: .semibold)
    badge.textAlignment = .center
    badge.textColor = .white
    badge.backgroundColor = .systemRed
    badge.clipsToBounds = true
    badge.layer.cornerRadius = 8
    badge.isHidden = true

    addSubview(icon)
    addSubview(caption)
    addSubview(badge)

    NSLayoutConstraint.activate([
      // >=44pt of touch target in a 64pt bar, per the HIG minimum.
      widthAnchor.constraint(greaterThanOrEqualToConstant: 76),
      icon.topAnchor.constraint(equalTo: topAnchor, constant: 8),
      icon.centerXAnchor.constraint(equalTo: centerXAnchor),
      icon.heightAnchor.constraint(equalToConstant: 22),
      caption.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 2),
      caption.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
      caption.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
      badge.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: -4),
      badge.centerYAnchor.constraint(equalTo: icon.topAnchor, constant: 2),
      badge.heightAnchor.constraint(equalToConstant: 16),
      badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 16),
    ])

    addTarget(self, action: #selector(handleTap), for: .touchUpInside)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func update(item: LumaTabItem, selected: Bool) {
    icon.image = UIImage(systemName: item.sfSymbol)
    caption.text = item.label
    accessibilityLabel = item.label
    accessibilityTraits = selected ? [.button, .selected] : .button

    let tint: UIColor = selected ? .label : .secondaryLabel
    icon.tintColor = tint
    caption.textColor = tint

    badge.isHidden = item.badge <= 0
    badge.text = item.badge > 99 ? "99+" : String(item.badge)
  }

  @objc private func handleTap() {
    // Selection state is owned by the frontend store: report the tap and let it
    // come back through update(), so native and web never disagree.
    onSelect(id)
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }
}
