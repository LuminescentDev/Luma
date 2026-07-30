import ActivityKit

/*
 * Compiled into BOTH the app target (which starts and updates the activity) and
 * the LumaLiveActivityExtension target (which renders it). ActivityKit matches an
 * activity to its widget by attribute type identity, so the two targets must build
 * this exact file — not two copies that happen to look alike.
 *
 * Display strings are formatted on the frontend and passed through verbatim; this
 * type carries no formatting logic so the widget and the in-app UI cannot drift.
 */
@available(iOS 16.2, *)
struct LumaActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    struct Transfer: Codable, Hashable {
      var uploading: Bool
      /// Nil when the job's total size is unknown, in which case no bar is drawn —
      /// a widget cannot animate, so an indeterminate spinner would sit frozen.
      var fraction: Double?
      var detail: String
    }

    /// Resolved in-app appearance. The lock-screen card follows this while
    /// Dynamic Island keeps its system-owned contrast.
    var appearance: String?
    /// Largest line: the host label, or the file name while a transfer runs.
    var primary: String
    /// Connection count ("One connection", "3 connections"), or "File transfer"
    /// when a transfer is running with no terminal sessions open.
    var headline: String
    /// Sub-line beside the headline: connection target, reconnect progress, or
    /// empty. Rendered as "headline · detail" when present.
    var detail: String
    var connected: Int
    var reconnecting: Int
    var failed: Int
    var transfer: Transfer?
  }
}
