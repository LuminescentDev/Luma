import ActivityKit
import Foundation
import UIKit

/*
 * Live Activity bridge. The Rust static library is linked into this app binary, so
 * the `live_activity_sync` Tauri command reaches ActivityKit by calling these
 * @_cdecl symbols directly (see src/commands/live_activity.rs) rather than through
 * a Tauri mobile plugin.
 *
 * ActivityKit is iOS 16.1+ while the app deploys to 14.0, so the framework is
 * weak-linked (OTHER_LDFLAGS in project.yml) and every entry point is availability
 * guarded.
 */

@_cdecl("luma_live_activity_sync")
func lumaLiveActivitySync(_ json: UnsafePointer<CChar>?) {
  guard let json else { return }
  let payload = Data(String(cString: json).utf8)
  guard #available(iOS 16.2, *) else { return }
  guard
    let state = try? JSONDecoder().decode(
      LumaActivityAttributes.ContentState.self, from: payload)
  else { return }
  DispatchQueue.main.async {
    LumaLiveActivityController.shared.apply(state)
  }
}

@_cdecl("luma_live_activity_end")
func lumaLiveActivityEnd() {
  guard #available(iOS 16.2, *) else { return }
  DispatchQueue.main.async {
    LumaLiveActivityController.shared.end()
  }
}

@available(iOS 16.2, *)
final class LumaLiveActivityController {
  static let shared = LumaLiveActivityController()

  /// iOS suspends the app in the background, which stalls the SSH connections the
  /// card describes. Past this point the system dims the activity so it stops
  /// asserting a connection state Luma can no longer observe.
  private static let staleAfter: TimeInterval = 120

  private var activity: Activity<LumaActivityAttributes>?
  private var observingTermination = false

  func apply(_ state: LumaActivityAttributes.ContentState) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    observeTermination()

    let content = ActivityContent(
      state: state, staleDate: Date().addingTimeInterval(Self.staleAfter))

    // An activity can outlive the process that started it, so adopt a running one
    // instead of requesting a second card for the same sessions.
    if let existing = activity ?? Activity<LumaActivityAttributes>.activities.first {
      activity = existing
      Task { await existing.update(content) }
      return
    }

    do {
      activity = try Activity<LumaActivityAttributes>.request(
        attributes: LumaActivityAttributes(), content: content, pushType: nil)
    } catch {
      NSLog("luma: could not start live activity: \(error.localizedDescription)")
    }
  }

  func end() {
    let running = Activity<LumaActivityAttributes>.activities
    activity = nil
    Task {
      for activity in running {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
  }

  /// Best effort only: iOS frequently terminates a suspended app without posting
  /// this, and `end` is async while the notification's run loop is ending. The
  /// stale date above is what actually bounds a card the app can no longer update.
  private func observeTermination() {
    guard !observingTermination else { return }
    observingTermination = true
    NotificationCenter.default.addObserver(
      forName: UIApplication.willTerminateNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.end()
    }
  }
}
