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
 * The selection-move animation comes in several styles (LumaTabMoveStyle) so
 * the design can be compared side by side in the lab screen (LumaTabBarLab.swift)
 * and a winner picked on a real device instead of guessed at.
 */

/// Declared by the Rust side (src/commands/tab_bar.rs) and linked in from
/// libapp.a. Called on the main thread when a tab is tapped.
@_silgen_name("luma_tab_bar_did_select")
func luma_tab_bar_did_select(_ id: UnsafePointer<CChar>?)

struct LumaTabItem: Decodable {
  let id: String
  let label: String
  let sfSymbol: String
  let badge: Int
}

private struct LumaTabBarConfig: Decodable {
  let tabs: [LumaTabItem]
  let selected: String
}

/// How the selection moves between tabs. Numbered to match the lab screen so
/// "somewhere between 2 and 4" is meaningful feedback.
enum LumaTabMoveStyle: Int, CaseIterable {
  /// 1 — Calm slide: the highlighted pill glides over, well damped, no frills.
  case calm = 1
  /// 2 — Bouncy slide: the pill stays highlighted, inflates slightly mid-move,
  /// and lands with a springy overshoot. The chosen shipping style.
  case bounce = 2
  /// 3 — Lens droplet: a clear-glass droplet detaches, swells over the icons it
  /// crosses, and dissolves into the highlight as it lands.
  case lens = 3
  /// 4 — Surge droplet: like 3 but bigger, slower, and it overshoots the target
  /// before snapping back.
  case surge = 4
  /// 5 — Gooey stretch: the highlighted pill stretches until it spans both
  /// tabs, then contracts onto the destination.
  case stretch = 5
  /// 6 — Bouncy lens: the clear-glass droplet of 3, driven with the motion of
  /// 2 — modest swell, a springy overshoot into the tab — a touch slower than
  /// either.
  case bouncyLens = 6
}

/// The three knobs of a droplet flight. The lab exposes these as live sliders
/// so tuning happens on the device with no rebuild; once numbers are settled
/// they become the defaults in `moveSelection`.
struct LumaDropletTuning {
  /// Spring damping: lower bounces harder. 0.3–1.0.
  var damping: CGFloat
  /// Flight duration in seconds.
  var flight: TimeInterval
  /// How much larger than the pill the droplet is born, in points.
  var inflate: CGFloat
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
/// per tab and a pill behind the selected one. Internal (not private) so the
/// lab screen can instantiate variants of it.
final class LumaTabBarView: UIView {
  /// On iOS 26 this carries a UIGlassContainerEffect, which combines every
  /// nested glass element into ONE render — the pill and the bar body merge
  /// like one body of liquid within `spacing` of each other.
  private let background = UIVisualEffectView(effect: nil)
  /// The bar's own glass body, nested inside the container on iOS 26.
  private let barGlass = UIVisualEffectView(effect: nil)
  private let stack = UIStackView()
  /// The resting highlight. Lives BEHIND the buttons so the selected icon stays
  /// crisp; positioned by frame (layoutSubviews), not constraints, so every
  /// move style can animate it freely.
  private let selectionPill = UIVisualEffectView(effect: nil)
  /// Clear-glass blob that rides ABOVE the bar during droplet-style moves,
  /// lensing whatever it passes over. Glass only refracts what is behind it, so
  /// only a view stacked over the buttons can visibly distort them.
  private let droplet = UIVisualEffectView(effect: nil)
  private let onSelect: (String) -> Void
  private var buttons: [String: LumaTabButton] = [:]
  private var selectedId: String?
  /// True while a move animation owns the pill's frame; layoutSubviews keeps
  /// its hands off until the move ends.
  private var isMoving = false
  /// Destination of the in-flight move. Re-asserting it (the webview echoing an
  /// optimistic tap, a badge refresh) must not restart or cut the animation.
  private var movingTo: String?
  /// Every animator of the current move, held so a new move can stop them as a
  /// set — including stages still waiting out a start delay.
  private var moveAnimators: [UIViewPropertyAnimator] = []

  /// Which animation the selection uses. The lab sets this per bar; the real
  /// bar ships the winner: bouncy slide (chosen on device from the lab).
  var moveStyle: LumaTabMoveStyle = .bounce
  /// Live override for the droplet styles' spring parameters. Nil uses each
  /// style's defaults; the lab wires sliders to this for rebuild-free tuning.
  var tuning: LumaDropletTuning?

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

      selectionPill.effect = restingGlass()
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
      selectionPill.backgroundColor = UIColor.white.withAlphaComponent(0.12)
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

    droplet.isUserInteractionEnabled = false
    droplet.isHidden = true
    if #available(iOS 26.0, *) {
      droplet.cornerConfiguration = .capsule()
    }
    addSubview(droplet)

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
    // The pill tracks the selected button whenever no move animation owns it
    // (first layout, rotation, size changes).
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

    for tab in tabs {
      buttons[tab.id]?.update(item: tab, selected: tab.id == selected)
    }
    // Badge-only updates re-apply the same selection; animating a zero-distance
    // move would flash the droplet in place.
    moveSelection(to: selected, animated: selectedId != nil && selectedId != selected)
    selectedId = selected
  }

  // MARK: - Selection movement

  /// A native tap animates immediately and reports the id afterwards. Waiting
  /// for the round trip (Swift → Rust event → webview store → tab_bar_update)
  /// used to start the move only after the webview had begun re-rendering the
  /// new route — visibly late, and stuttery whenever that render was heavy. The
  /// echoed update() lands in apply() as a same-destination no-op, so native
  /// and web still converge on the store's selection.
  private func handleTap(_ id: String) {
    if id != selectedId {
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

    // Re-asserting the destination of an in-flight move (the webview echoing an
    // optimistic tap, a badge refresh) must not snap the pill there and cut the
    // animation short.
    if isMoving && movingTo == id { return }

    // Buttons need frames before anything can fly between them.
    layoutIfNeeded()
    let dest = target.convert(target.bounds, to: background.contentView)

    // Where the move visually departs from. Mid-flight the model frame already
    // sits at the previous destination (the animations are presentation-only),
    // so an interrupted move must read the presentation layer — the droplet's
    // if one is airborne, the pill's otherwise — or rapid taps teleport.
    var source = selectionPill.frame
    if isMoving {
      if !droplet.isHidden, let flying = droplet.layer.presentation() {
        source = convert(flying.frame, to: background.contentView)
      } else if let sliding = selectionPill.layer.presentation() {
        source = sliding.frame
      }
    }

    // A new move always starts from a clean slate: rapid taps must not strand a
    // half-finished droplet or a de-materialized pill on screen.
    cancelMove()
    droplet.isHidden = true
    droplet.effect = nil
    selectionPill.transform = .identity
    if #available(iOS 26.0, *) {
      selectionPill.effect = restingGlass()
    }

    guard animated else {
      selectionPill.frame = dest
      fixPillRadius()
      return
    }

    isMoving = true
    movingTo = id
    selectionPill.frame = source
    fixPillRadius()

    let finish: () -> Void = { [weak self] in
      guard let self else { return }
      self.moveAnimators.removeAll()
      self.isMoving = false
      self.movingTo = nil
      self.selectionPill.frame = dest
      self.fixPillRadius()
      self.droplet.isHidden = true
      self.droplet.effect = nil
    }

    // The droplet styles are built on clear glass; without it (pre-26) they
    // degrade to the bouncy slide rather than to nothing.
    var style = moveStyle
    if #unavailable(iOS 26.0) {
      if style == .lens || style == .surge || style == .bouncyLens { style = .bounce }
    }

    switch style {
    case .calm:
      let slide = UIViewPropertyAnimator(duration: 0.38, dampingRatio: 0.85) {
        self.selectionPill.frame = dest
      }
      slide.addCompletion { _ in finish() }
      slide.startAnimation()
      moveAnimators = [slide]

    case .bounce:
      let slide = UIViewPropertyAnimator(duration: 0.55, dampingRatio: 0.5) {
        self.selectionPill.frame = dest
      }
      slide.addCompletion { _ in finish() }
      // A concurrent inflate-deflate pulse so the pill reads as picking up
      // momentum. Small, and the pill sits behind the icons, so the scaled
      // backdrop is the bar body — no icon smearing.
      let inflate = UIViewPropertyAnimator(duration: 0.25, curve: .easeOut) {
        self.selectionPill.transform = CGAffineTransform(scaleX: 1.12, y: 1.12)
      }
      let deflate = UIViewPropertyAnimator(duration: 0.30, curve: .easeInOut) {
        self.selectionPill.transform = .identity
      }
      inflate.addCompletion { _ in deflate.startAnimation() }
      slide.startAnimation()
      inflate.startAnimation()
      moveAnimators = [slide, inflate, deflate]

    case .lens:
      let t = tuning ?? LumaDropletTuning(damping: 0.8, flight: 0.5, inflate: 4)
      flyDroplet(
        from: source, to: dest,
        damping: t.damping, flight: t.flight, inflate: t.inflate, completion: finish)

    case .surge:
      let t = tuning ?? LumaDropletTuning(damping: 0.48, flight: 0.7, inflate: 10)
      flyDroplet(
        from: source, to: dest,
        damping: t.damping, flight: t.flight, inflate: t.inflate, completion: finish)

    case .bouncyLens:
      // Bounce's motion in lens's material: born slightly inflated, an
      // underdamped spring for the springy landing, unhurried.
      let t = tuning ?? LumaDropletTuning(damping: 0.58, flight: 0.65, inflate: 6)
      flyDroplet(
        from: source, to: dest,
        damping: t.damping, flight: t.flight, inflate: t.inflate, completion: finish)

    case .stretch:
      // The pill itself goes gooey: stretches until it spans source and
      // destination, then contracts onto the destination.
      // Lab-only caveat: this animates the effect view's SIZE, which the glass
      // backdrop does not resize smoothly — on 26 it shears while deforming.
      // Kept as a shape reference; not shippable as-is.
      let expand = UIViewPropertyAnimator(duration: 0.26, curve: .easeIn) {
        self.selectionPill.frame = source.union(dest)
      }
      let contract = UIViewPropertyAnimator(duration: 0.26, curve: .easeOut) {
        self.selectionPill.frame = dest
      }
      expand.addCompletion { _ in contract.startAnimation() }
      contract.addCompletion { _ in finish() }
      expand.startAnimation()
      moveAnimators = [expand, contract]
    }
  }

  /// Stop every animator of the current move, including stages still waiting
  /// out their start delay — their animation blocks then never run at all.
  /// This is why the stages are UIViewPropertyAnimators rather than
  /// UIView.animate calls: removeAllAnimations() cannot un-schedule a delayed
  /// effect crossfade, and one firing late restored the pill's glass mid-move.
  /// Chained stages (deflate, contract) that were never started stay .inactive
  /// and are simply dropped; stopping runs only on .active animators.
  private func cancelMove() {
    for animator in moveAnimators where animator.state == .active {
      animator.stopAnimation(true)
    }
    moveAnimators.removeAll()
    isMoving = false
    movingTo = nil
  }

  /// The droplet flight shared by the droplet styles: a clear-glass blob rises
  /// off the old tab, springs across the bar (lensing the icons beneath it),
  /// and dissolves into the resting highlight as it lands.
  ///
  /// Built ONLY from what UIVisualEffectView animates correctly:
  ///  - position, via a single spring (the underdamped spring IS the bounce);
  ///  - the `effect` property, whose animation is the supported way to fade
  ///    glass in and out.
  /// Never alpha (opacity below 1 on an effect view renders the material
  /// broken) and never bounds (the backdrop snaps and smears instead of
  /// re-rendering) — both were tried, and both looked exactly that bad on a
  /// device. The droplet keeps ONE size for the whole flight: born slightly
  /// inflated, it reads as swelling relative to the pill it replaces without a
  /// single frame of resize.
  private func flyDroplet(
    from source: CGRect, to dest: CGRect,
    damping: CGFloat, flight: TimeInterval, inflate: CGFloat,
    completion: @escaping () -> Void
  ) {
    guard #available(iOS 26.0, *) else {
      completion()
      return
    }

    let clear = UIGlassEffect(style: .clear)
    clear.isInteractive = true

    let inflated = dest.insetBy(dx: -inflate, dy: -inflate * 0.6)
    let sourceInSelf = background.contentView.convert(source, to: self)
    let destInSelf = background.contentView.convert(dest, to: self)

    droplet.effect = nil
    droplet.bounds = CGRect(origin: .zero, size: inflated.size)
    droplet.center = CGPoint(x: sourceInSelf.midX, y: sourceInSelf.midY)
    droplet.isHidden = false

    // Park the pill at the destination stripped of its material; it returns by
    // regaining its effect, never by alpha.
    selectionPill.frame = dest
    fixPillRadius()
    selectionPill.effect = nil

    // Materialize the droplet over the old tab...
    let materialize = UIViewPropertyAnimator(duration: 0.12, curve: .easeIn) {
      self.droplet.effect = clear
    }
    // ...fly it on one spring — no waypoints, no phases; the overshoot and
    // settle all come from the spring itself...
    let fly = UIViewPropertyAnimator(duration: flight, dampingRatio: damping) {
      self.droplet.center = CGPoint(x: destInSelf.midX, y: destInSelf.midY)
    }
    // ...and while it is still settling, dissolve it as the highlight rises
    // beneath it. Two overlapping effect crossfades: no hard swap anywhere.
    let dissolve = UIViewPropertyAnimator(duration: flight * 0.45, curve: .easeInOut) {
      self.droplet.effect = nil
    }
    let land = UIViewPropertyAnimator(duration: flight * 0.5, curve: .easeOut) {
      self.selectionPill.effect = self.restingGlass()
    }
    // `land` finishes last (delay 0.55·flight + 0.5·flight > every other
    // stage), so it carries the move's completion. An interrupted move stops
    // all four without completions; cancelMove's caller does the cleanup.
    land.addCompletion { _ in completion() }

    materialize.startAnimation()
    fly.startAnimation()
    dissolve.startAnimation(afterDelay: flight * 0.5)
    land.startAnimation(afterDelay: flight * 0.55)
    moveAnimators = [materialize, fly, dissolve, land]
  }

  /// Pre-26 the pill is a plain view whose capsule radius is maintained by
  /// hand; on 26 the cornerConfiguration owns the shape and writing to
  /// layer.cornerRadius would fight it.
  private func fixPillRadius() {
    if #unavailable(iOS 26.0) {
      selectionPill.layer.cornerRadius = selectionPill.bounds.height / 2
    }
  }

  /// The pill's at-rest material. Tinted so the merged glass-on-glass stays
  /// legible against the bar body it is fused to.
  @available(iOS 26.0, *)
  private func restingGlass() -> UIGlassEffect {
    let resting = UIGlassEffect(style: .regular)
    resting.isInteractive = true
    resting.tintColor = UIColor.white.withAlphaComponent(0.18)
    return resting
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
  /// pill's flight rather than the webview's echo.
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
