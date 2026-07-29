import UIKit

/*
 * Tab-bar animation lab: a native full-screen page showing one bar per
 * LumaTabMoveStyle, each independently tappable, over deliberately colourful
 * content — glass only shows its character when there is something behind it to
 * refract, so judging the styles over a flat dark background would be
 * misleading. Opened from Profile > About via the `tab_bar_lab` command; a
 * design aid, not part of the shipping UI.
 */

@_cdecl("luma_tab_bar_lab_present")
func lumaTabBarLabPresent() -> Bool {
  if Thread.isMainThread { return LumaTabBarLab.present() }
  return DispatchQueue.main.sync { LumaTabBarLab.present() }
}

enum LumaTabBarLab {
  static func present() -> Bool {
    guard let top = topViewController() else { return false }
    // Already up (double tap on the button): don't stack a second one.
    if top is LumaTabBarLabViewController { return true }
    let lab = LumaTabBarLabViewController()
    lab.modalPresentationStyle = .fullScreen
    top.present(lab, animated: true)
    return true
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
    let window =
      scenes.flatMap({ $0.windows }).first(where: { $0.isKeyWindow })
      ?? scenes.flatMap({ $0.windows }).first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

private final class LumaTabBarLabViewController: UIViewController {
  private static let tabs = [
    LumaTabItem(id: "vaults", label: "Vaults", sfSymbol: "lock.square.stack", badge: 0),
    LumaTabItem(id: "connections", label: "Connections", sfSymbol: "terminal", badge: 0),
    LumaTabItem(id: "profile", label: "Profile", sfSymbol: "person.crop.circle", badge: 0),
  ]

  private static let variants: [(LumaTabMoveStyle, String)] = [
    (.calm, "1 · Calm slide"),
    (.bounce, "2 · Bouncy slide — the pick"),
    (.lens, "3 · Clear lens droplet"),
    (.surge, "4 · Surge — bigger, overshoots"),
    (.stretch, "5 · Gooey stretch"),
    (.bouncyLens, "6 · Bouncy lens"),
  ]

  private let gradient = CAGradientLayer()
  /// Each bar drives only itself; this keeps them alive and independent.
  private var bars: [LumaTabBarView] = []
  /// Row 6, whose spring the sliders tune live.
  private var tunableBar: LumaTabBarView?
  private let dampingSlider = UISlider()
  private let flightSlider = UISlider()
  private let inflateSlider = UISlider()
  private let tuningReadout = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(red: 0.06, green: 0.06, blue: 0.09, alpha: 1)

    // A vivid backdrop for the glass to refract: gradient wash plus scattered
    // colour blobs roughly where the bars sit.
    gradient.colors = [
      UIColor(red: 0.35, green: 0.20, blue: 0.65, alpha: 1).cgColor,
      UIColor(red: 0.10, green: 0.12, blue: 0.30, alpha: 1).cgColor,
      UIColor(red: 0.60, green: 0.20, blue: 0.45, alpha: 1).cgColor,
    ]
    gradient.startPoint = CGPoint(x: 0, y: 0)
    gradient.endPoint = CGPoint(x: 1, y: 1)
    view.layer.addSublayer(gradient)

    let blobColors: [UIColor] = [
      .systemPink, .systemTeal, .systemOrange, .systemIndigo, .systemGreen, .systemYellow,
    ]
    // Deterministic scatter — this is a comparison page, it should look the
    // same on every open.
    let positions: [(CGFloat, CGFloat, CGFloat)] = [
      (0.12, 0.16, 70), (0.78, 0.10, 90), (0.30, 0.34, 56), (0.85, 0.42, 70),
      (0.10, 0.58, 84), (0.65, 0.66, 60), (0.25, 0.82, 90), (0.80, 0.88, 64),
    ]
    for (index, position) in positions.enumerated() {
      let blob = UIView()
      blob.backgroundColor = blobColors[index % blobColors.count].withAlphaComponent(0.55)
      blob.translatesAutoresizingMaskIntoConstraints = false
      blob.layer.cornerRadius = position.2 / 2
      view.addSubview(blob)
      NSLayoutConstraint.activate([
        blob.widthAnchor.constraint(equalToConstant: position.2),
        blob.heightAnchor.constraint(equalToConstant: position.2),
        // Multiplier-based centering keeps the scatter proportional on any
        // screen size.
        NSLayoutConstraint(
          item: blob, attribute: .centerX, relatedBy: .equal,
          toItem: view, attribute: .trailing, multiplier: position.0, constant: 0),
        NSLayoutConstraint(
          item: blob, attribute: .centerY, relatedBy: .equal,
          toItem: view, attribute: .bottom, multiplier: position.1, constant: 0),
      ])
    }

    let title = UILabel()
    title.text = "Tab bar lab — tap tabs to compare"
    title.font = .systemFont(ofSize: 15, weight: .semibold)
    title.textColor = .white
    title.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(title)

    let close = UIButton(type: .system)
    close.setTitle("Close", for: .normal)
    close.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
    close.tintColor = .white
    close.backgroundColor = UIColor.white.withAlphaComponent(0.15)
    close.layer.cornerRadius = 16
    close.contentEdgeInsets = UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14)
    close.translatesAutoresizingMaskIntoConstraints = false
    close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
    view.addSubview(close)

    let rows = UIStackView()
    rows.axis = .vertical
    rows.alignment = .center
    rows.spacing = 10
    rows.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(rows)

    for (style, name) in Self.variants {
      let label = UILabel()
      label.text = name
      label.font = .systemFont(ofSize: 12, weight: .medium)
      label.textColor = UIColor.white.withAlphaComponent(0.85)

      // The closure needs the bar it belongs to; a one-slot box breaks the
      // chicken-and-egg between creating the bar and referencing it.
      final class Slot { var bar: LumaTabBarView? }
      let slot = Slot()
      let bar = LumaTabBarView(height: 64) { id in
        slot.bar?.apply(tabs: LumaTabBarLabViewController.tabs, selected: id)
      }
      slot.bar = bar
      bar.moveStyle = style
      bar.apply(tabs: Self.tabs, selected: "vaults")
      bars.append(bar)
      if style == .bouncyLens { tunableBar = bar }

      let row = UIStackView(arrangedSubviews: [label, bar])
      row.axis = .vertical
      row.alignment = .center
      row.spacing = 6
      bar.heightAnchor.constraint(equalToConstant: 64).isActive = true
      rows.addArrangedSubview(row)
    }

    // Live tuning for row 6: adjust, tap its tabs, feel it — no rebuild. Read
    // the numbers off the readout when settled; they become the defaults.
    let panel = UIStackView()
    panel.axis = .vertical
    panel.spacing = 4
    tuningReadout.font = .monospacedSystemFont(ofSize: 12, weight: .medium)
    tuningReadout.textColor = .white
    tuningReadout.textAlignment = .center
    panel.addArrangedSubview(tuningReadout)
    let sliders: [(String, UISlider, Float, Float, Float)] = [
      ("bounce", dampingSlider, 0.30, 1.00, 0.58),
      ("speed", flightSlider, 0.30, 1.20, 0.65),
      ("size", inflateSlider, 0.00, 16.0, 6.0),
    ]
    for (name, slider, minValue, maxValue, value) in sliders {
      let caption = UILabel()
      caption.text = name
      caption.font = .systemFont(ofSize: 11, weight: .medium)
      caption.textColor = UIColor.white.withAlphaComponent(0.7)
      caption.widthAnchor.constraint(equalToConstant: 52).isActive = true
      slider.minimumValue = minValue
      slider.maximumValue = maxValue
      slider.value = value
      slider.addTarget(self, action: #selector(tuningChanged), for: .valueChanged)
      let sliderRow = UIStackView(arrangedSubviews: [caption, slider])
      sliderRow.axis = .horizontal
      sliderRow.spacing = 10
      sliderRow.alignment = .center
      panel.addArrangedSubview(sliderRow)
    }
    panel.widthAnchor.constraint(equalToConstant: 300).isActive = true
    rows.addArrangedSubview(panel)
    tuningChanged()

    NSLayoutConstraint.activate([
      title.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 10),
      title.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
      close.centerYAnchor.constraint(equalTo: title.centerYAnchor),
      close.trailingAnchor.constraint(
        equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
      rows.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      rows.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 12),
    ])
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    gradient.frame = view.bounds
  }

  @objc private func tuningChanged() {
    let damping = CGFloat(dampingSlider.value)
    let flight = TimeInterval(flightSlider.value)
    let inflate = CGFloat(inflateSlider.value)
    tuningReadout.text = String(
      format: "row 6 · damping %.2f · flight %.2fs · inflate %.0fpt",
      damping, flight, inflate)
    tunableBar?.tuning = LumaDropletTuning(
      damping: damping, flight: flight, inflate: inflate)
  }

  @objc private func closeTapped() {
    dismiss(animated: true)
  }
}
