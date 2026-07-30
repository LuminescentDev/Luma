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
 * reports taps back through `luma_tab_bar_did_select`. Taps animate
 * optimistically — the move starts the instant the finger lifts, and the
 * webview's echoed tab_bar_update merely confirms it — because waiting for the
 * round trip started the animation mid route-render, late and janky.
 *
 * Liquid Glass (UIGlassEffect) is iOS 26+; the app deploys to 14.0, so every
 * glass path is availability guarded and falls back to a
 * .systemUltraThinMaterial blur, which is the closest pre-26 material.
 *
 * The selection glide is a live spring simulation stepped by a CADisplayLink,
 * NOT a UIViewPropertyAnimator, and the pill's material is set once and never
 * animated. Both choices are load-bearing for rapid back-and-forth tapping,
 * which several animator-based designs could not survive:
 *  - a UIView spring cannot be retargeted, so every interrupting tap had to
 *    stop one spring and launch another from zero velocity, which halted the
 *    pill dead mid-flight on each tap;
 *  - freezing a mid-flight `effect` crossfade snaps the glass (there is no
 *    representable half-faded state), which flashed the highlight at the tab
 *    that was just abandoned.
 * Here a tap only moves the simulation's target: position and velocity carry
 * over untouched and there is no material transition to catch halfway.
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
  let appearance: String
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
    let style: UIUserInterfaceStyle = config.appearance == "light" ? .light : .dark
    // Apply at the host as well as the bar so UIKit-owned surfaces launched
    // from the webview (keyboard, edit menus, status-bar contrast) inherit the
    // same resolved appearance.
    Self.hostView()?.overrideUserInterfaceStyle = style
    barView?.overrideUserInterfaceStyle = style
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
  /// On iOS 26 this carries a UIGlassContainerEffect, which combines every
  /// nested glass element into ONE render — the pill and the bar body merge
  /// like one body of liquid within `spacing` of each other.
  private let background = UIVisualEffectView(effect: nil)
  /// The bar's own glass body, nested inside the container on iOS 26.
  private let barGlass = UIVisualEffectView(effect: nil)
  private let stack = UIStackView()
  /// The selection highlight. Lives BEHIND the buttons so the selected icon
  /// stays crisp, and is positioned by frame (layoutSubviews / the glide), not
  /// by constraints, so it can be moved a frame at a time. Its material is
  /// assigned once in init and never animated — see the file header.
  private let selectionPill = UIVisualEffectView(effect: nil)
  private let onSelect: (String) -> Void
  private var buttons: [String: LumaTabButton] = [:]
  private var selectedId: String?
  /// Selection as last reported by the webview store. Distinguishes a stale
  /// echo (the store still catching up to optimistic taps) from the web
  /// genuinely changing tabs on its own, which must win.
  private var webSelected: String?
  /// Taps reported to the webview whose echo has not come back yet, in tap
  /// order. While any are outstanding, an update carrying an older selection
  /// is history being replayed, not an instruction to move.
  private var pendingTaps: [String] = []
  /// True while a glide owns the pill's frame; layoutSubviews keeps its hands
  /// off until it ends.
  private var isMoving = false
  /// Destination of the in-flight glide. Re-asserting it (the webview echoing
  /// an optimistic tap, a badge refresh) must not restart the animation.
  private var movingTo: String?

  // The glide: one spring simulation per run of taps. Position and velocity are
  // plain state stepped by the display link, so a retarget is just a new
  // target — nothing is ever interrupted.
  private var glideLink: CADisplayLink?
  private var glidePos = CGPoint.zero
  private var glideVel = CGVector.zero
  private var glideTarget = CGPoint.zero
  private var glideDest = CGRect.zero

  /// Angular frequency in rad/s and damping ratio of the glide spring. A damped
  /// spring settles in roughly 4/(damping·omega) seconds — about 0.32s here.
  /// Damping just under 1 keeps it from overshooting the tab.
  private static let glideOmega: CGFloat = 14
  private static let glideDamping: CGFloat = 0.9

  /// Pre-26 stand-in for the pill's clear-glass material.
  private static let restingPillColor = UIColor.white.withAlphaComponent(0.12)

  init(height: CGFloat, onSelect: @escaping (String) -> Void) {
    self.onSelect = onSelect
    super.init(frame: .zero)

    background.translatesAutoresizingMaskIntoConstraints = false
    barGlass.translatesAutoresizingMaskIntoConstraints = false
    selectionPill.isUserInteractionEnabled = false

    if #available(iOS 26.0, *) {
      let container = UIGlassContainerEffect()
      // Generous enough that the pill stays fused to the bar body as it
      // travels, so the selection reads as liquid moving inside the bar.
      container.spacing = 24
      background.effect = container

      // Shape glass with cornerConfiguration, NEVER clipsToBounds + a manual
      // cornerRadius: the material draws its lensing and specular edge along
      // (and slightly beyond) its own boundary, and clipping shears exactly
      // that away, flattening it into what looks like a plain blur.
      let body = UIGlassEffect(style: .regular)
      // Interactive glass flexes and highlights under touch — a large part of
      // what reads as "liquid" rather than "frosted".
      body.isInteractive = true
      barGlass.effect = body
      barGlass.cornerConfiguration = .capsule()

      // Clear and untinted, so the selection reads as a lens over the tab
      // rather than a white-tinted plate with a lit outline.
      let resting = UIGlassEffect(style: .clear)
      resting.isInteractive = true
      selectionPill.effect = resting
      selectionPill.cornerConfiguration = .capsule()
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
      selectionPill.backgroundColor = Self.restingPillColor
      selectionPill.layer.cornerCurve = .continuous
    }
    addSubview(background)

    // Nested glass elements live in the container's contentView; the container
    // hoists them into its combined render behind that same contentView, so the
    // buttons added afterwards still draw on top.
    if #available(iOS 26.0, *) {
      background.contentView.addSubview(barGlass)
      NSLayoutConstraint.activate([
        barGlass.topAnchor.constraint(equalTo: background.contentView.topAnchor),
        barGlass.bottomAnchor.constraint(equalTo: background.contentView.bottomAnchor),
        barGlass.leadingAnchor.constraint(equalTo: background.contentView.leadingAnchor),
        barGlass.trailingAnchor.constraint(equalTo: background.contentView.trailingAnchor),
      ])
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

  override func layoutSubviews() {
    super.layoutSubviews()
    // A glide owns the pill, but it aims at a frame captured when the move
    // started: re-aim at the destination's current geometry or a rotation
    // mid-flight would land the pill where the tab used to be.
    if glideLink != nil, let id = movingTo, let target = buttons[id] {
      glideDest = target.convert(target.bounds, to: background.contentView)
      glideTarget = CGPoint(x: glideDest.midX, y: glideDest.midY)
      return
    }
    // Otherwise the pill simply tracks the selected button (first layout,
    // rotation, size changes).
    guard !isMoving, let id = selectedId, let target = buttons[id] else { return }
    selectionPill.frame = target.convert(target.bounds, to: background.contentView)
    fixPillRadius()
  }

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
        let button = LumaTabButton(item: tab) { [weak self] id in self?.handleTap(id) }
        buttons[tab.id] = button
        stack.addArrangedSubview(button)
      }
    }

    // The webview echoes optimistic taps back one store change at a time, so
    // under rapid tapping every update but the last carries a selection the bar
    // has already moved past. Replaying those echoes dragged the pill back
    // through each abandoned tab — visible as jumps. Stale echoes are consumed
    // instead; only the web changing selection on its own (an id neither
    // pending nor last confirmed) overrides the bar.
    var effective = selected
    if !pendingTaps.isEmpty {
      if let echoed = pendingTaps.firstIndex(of: selected) {
        pendingTaps.removeSubrange(...echoed)
        effective = selectedId ?? selected
      } else if selected == webSelected {
        // A badge refresh emitted before the store processed the outstanding
        // taps: it carries the pre-tap selection, not a decision to go back.
        effective = selectedId ?? selected
      } else {
        pendingTaps.removeAll()
      }
    }
    webSelected = selected

    for tab in tabs {
      buttons[tab.id]?.update(item: tab, selected: tab.id == effective)
    }
    // Badge-only updates re-apply the same selection; animating a zero-distance
    // move would restart the spring for nothing.
    moveSelection(to: effective, animated: selectedId != nil && selectedId != effective)
    selectedId = effective
  }

  // MARK: - Selection movement

  /// A native tap animates immediately and reports the id afterwards. Waiting
  /// for the round trip (Swift → Rust event → webview store → tab_bar_update)
  /// used to start the move only after the webview had begun re-rendering the
  /// new route — visibly late, and stuttery whenever that render was heavy. The
  /// echoed update() lands in apply() as a stale echo, so native and web still
  /// converge on the store's selection.
  private func handleTap(_ id: String) {
    if id != selectedId {
      pendingTaps.append(id)
      for (buttonId, button) in buttons {
        button.setSelected(buttonId == id, animated: true)
      }
      moveSelection(to: id, animated: true)
      selectedId = id
    }
    onSelect(id)
  }

  private func moveSelection(to id: String, animated: Bool) {
    guard let target = buttons[id] else {
      selectionPill.isHidden = true
      return
    }
    selectionPill.isHidden = false

    // Re-asserting the destination of an in-flight glide (the webview echoing
    // an optimistic tap, a badge refresh) must not restart it.
    if isMoving && movingTo == id { return }

    // Nothing can be positioned before the bar has a width, and forcing the
    // layout below at the engine's temporary zero width is worse than useless:
    // the stack's 6pt insets and the buttons' 4pt spacing cannot fit in 0pt, so
    // UIKit breaks the button width constraints and every button frame that
    // comes back is garbage — which is what `dest` would then be computed from.
    // layoutSubviews places the pill as soon as a real width arrives.
    guard bounds.width > 0 else { return }

    // Buttons need frames before anything can move between them.
    layoutIfNeeded()
    let dest = target.convert(target.bounds, to: background.contentView)

    guard animated else {
      stopGlide()
      isMoving = false
      movingTo = nil
      selectionPill.frame = dest
      fixPillRadius()
      return
    }

    // Retarget: an already-running glide keeps its position and velocity and
    // simply springs toward the new tab, which is what makes hammering smooth.
    glideDest = dest
    glideTarget = CGPoint(x: dest.midX, y: dest.midY)
    isMoving = true
    movingTo = id
    guard glideLink == nil else { return }

    glidePos = CGPoint(x: selectionPill.frame.midX, y: selectionPill.frame.midY)
    glideVel = .zero
    let link = CADisplayLink(target: self, selector: #selector(glideTick(_:)))
    link.add(to: .main, forMode: .common)
    glideLink = link
  }

  @objc private func glideTick(_ link: CADisplayLink) {
    guard window != nil else {
      // The link retains self; the bar leaving the screen mid-glide is where
      // the loop is broken.
      stopGlide()
      isMoving = false
      movingTo = nil
      return
    }

    // Semi-implicit Euler on a damped spring. dt is clamped so one hitched
    // frame cannot kick the integration unstable.
    let dt = CGFloat(min(link.targetTimestamp - link.timestamp, 1.0 / 30.0))
    let omega = Self.glideOmega
    let zeta = Self.glideDamping
    glideVel.dx +=
      (-omega * omega * (glidePos.x - glideTarget.x) - 2 * zeta * omega * glideVel.dx) * dt
    glideVel.dy +=
      (-omega * omega * (glidePos.y - glideTarget.y) - 2 * zeta * omega * glideVel.dy) * dt
    glidePos.x += glideVel.dx * dt
    glidePos.y += glideVel.dy * dt
    selectionPill.center = glidePos

    let distance = hypot(glidePos.x - glideTarget.x, glidePos.y - glideTarget.y)
    let speed = hypot(glideVel.dx, glideVel.dy)
    guard distance < 0.4 && speed < 4 else { return }

    // Landed: take the exact frame rather than leaving the sub-point remainder
    // of the simulation on screen.
    stopGlide()
    UIView.performWithoutAnimation {
      selectionPill.frame = glideDest
      fixPillRadius()
    }
    isMoving = false
    movingTo = nil
  }

  private func stopGlide() {
    glideLink?.invalidate()
    glideLink = nil
  }

  /// Pre-26 the pill is a plain view whose capsule radius is maintained by
  /// hand; on 26 the cornerConfiguration owns the shape and writing to
  /// layer.cornerRadius would fight it.
  private func fixPillRadius() {
    if #unavailable(iOS 26.0) {
      selectionPill.layer.cornerRadius = selectionPill.bounds.height / 2
    }
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
    caption.font = .systemFont(ofSize: 10, weight: .medium)
    caption.textAlignment = .center
    // The caption dictates the button's width rather than truncating: just
    // below required so the bar's outer screen margins still win on devices
    // too narrow for everything.
    caption.setContentCompressionResistancePriority(UILayoutPriority(999), for: .horizontal)

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

    // Well past the HIG 44pt touch minimum, and roomy enough that the longest
    // caption ("Connections") fits with air instead of hugging the pill's
    // edges. fillEqually spreads the widest tab's width to all. Just below
    // required, like the caption's compression resistance: the bar's outer
    // screen margins still win on devices too narrow for everything, and a
    // layout pass at a temporary zero width drops it silently instead of
    // logging an unsatisfiable-constraint break.
    let minWidth = widthAnchor.constraint(greaterThanOrEqualToConstant: 92)
    minWidth.priority = UILayoutPriority(999)

    // The caption is inset from the button's edges, not clamped to them: at
    // required priority these two fought the same zero-width pass (and would
    // fight any width too narrow for the label) instead of letting the label
    // compress.
    let captionLeading = caption.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4)
    let captionTrailing = caption.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4)
    captionLeading.priority = UILayoutPriority(999)
    captionTrailing.priority = UILayoutPriority(999)

    NSLayoutConstraint.activate([
      minWidth,
      icon.topAnchor.constraint(equalTo: topAnchor, constant: 8),
      icon.centerXAnchor.constraint(equalTo: centerXAnchor),
      icon.heightAnchor.constraint(equalToConstant: 22),
      caption.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 2),
      captionLeading,
      captionTrailing,
      badge.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: -4),
      badge.centerYAnchor.constraint(equalTo: icon.topAnchor, constant: 2),
      badge.heightAnchor.constraint(equalToConstant: 16),
      badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 16),
    ])

    addTarget(self, action: #selector(handleTap), for: .touchUpInside)
    addTarget(self, action: #selector(handlePressDown), for: [.touchDown, .touchDragEnter])
    addTarget(
      self, action: #selector(handlePressUp),
      for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  @objc private func handlePressDown() {
    UIViewPropertyAnimator(duration: 0.16, dampingRatio: 0.7) {
      self.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
    }.startAnimation()
  }

  @objc private func handlePressUp() {
    // Underdamped on the way back so the icon overshoots slightly and rebounds.
    UIViewPropertyAnimator(duration: 0.42, dampingRatio: 0.45) {
      self.transform = .identity
    }.startAnimation()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func update(item: LumaTabItem, selected: Bool) {
    icon.image = UIImage(systemName: item.sfSymbol)
    caption.text = item.label
    accessibilityLabel = item.label
    setSelected(selected, animated: false)

    badge.isHidden = item.badge <= 0
    badge.text = item.badge > 99 ? "99+" : String(item.badge)
  }

  /// Tint flip split out of update() so an optimistic tap can restyle the
  /// buttons immediately, without a LumaTabItem in hand and in step with the
  /// pill's glide rather than the webview's echo.
  func setSelected(_ selected: Bool, animated: Bool) {
    accessibilityTraits = selected ? [.button, .selected] : .button
    let tint: UIColor = selected ? .label : .secondaryLabel
    guard animated else {
      icon.tintColor = tint
      caption.textColor = tint
      return
    }
    // tintColor is not animatable directly; the crossfade transition is the
    // supported way. Per subview, so it never snapshots the press-down scale
    // transform that is usually still animating on this same control.
    UIView.transition(
      with: icon, duration: 0.22,
      options: [.transitionCrossDissolve, .allowUserInteraction]
    ) { self.icon.tintColor = tint }
    UIView.transition(
      with: caption, duration: 0.22,
      options: [.transitionCrossDissolve, .allowUserInteraction]
    ) { self.caption.textColor = tint }
  }

  @objc private func handleTap() {
    // Selection state is owned by the frontend store: report the tap and let it
    // come back through update(), so native and web never disagree.
    onSelect(id)
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }
}
