import ActivityKit
import SwiftUI
import WidgetKit

/*
 * Lock screen, Dynamic Island, and minimal presentations for Luma's session
 * activity. The app never renders these views; it only pushes content states
 * through LumaActivityAttributes (see Shared/, compiled into both targets).
 */

private enum LumaTheme {
  static let accent = Color(red: 0.486, green: 0.424, blue: 0.949)  // #7c6cf2
  static let warning = Color(red: 0.984, green: 0.749, blue: 0.141)  // #fbbf24
  static let danger = Color(red: 0.973, green: 0.443, blue: 0.443)  // #f87171
}

/// Worst state across the sessions, so the collapsed presentations can say
/// something useful in one glyph. Icon and colour both change: the Dynamic
/// Island's minimal view is often the only thing visible, and colour alone
/// would carry the whole meaning.
private enum SessionStatus {
  case connected
  case reconnecting
  case failed

  init(_ state: LumaActivityAttributes.ContentState) {
    if state.failed > 0 {
      self = .failed
    } else if state.reconnecting > 0 {
      self = .reconnecting
    } else {
      self = .connected
    }
  }

  var symbol: String {
    switch self {
    case .connected: return "terminal.fill"
    case .reconnecting: return "arrow.triangle.2.circlepath"
    case .failed: return "exclamationmark.triangle.fill"
    }
  }

  var tint: Color {
    switch self {
    case .connected: return LumaTheme.accent
    case .reconnecting: return LumaTheme.warning
    case .failed: return LumaTheme.danger
    }
  }
}

struct LumaLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LumaActivityAttributes.self) { context in
      LockScreenView(state: context.state)
        .activitySystemActionForegroundColor(LumaTheme.accent)
    } dynamicIsland: { context in
      let status = SessionStatus(context.state)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: status.symbol)
            .font(.title3)
            .foregroundStyle(status.tint)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.state.headline)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            Text(context.state.primary)
              .font(.headline)
              .lineLimit(1)
            if !context.state.detail.isEmpty {
              Text(context.state.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            if let transfer = context.state.transfer {
              TransferRow(transfer: transfer)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Image(systemName: status.symbol)
          .foregroundStyle(status.tint)
      } compactTrailing: {
        CompactTrailing(state: context.state)
      } minimal: {
        Image(systemName: status.symbol)
          .foregroundStyle(status.tint)
      }
    }
  }
}

private struct LockScreenView: View {
  let state: LumaActivityAttributes.ContentState

  var body: some View {
    let status = SessionStatus(state)
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: status.symbol)
        .font(.title3)
        .foregroundStyle(status.tint)
        .frame(width: 22)

      VStack(alignment: .leading, spacing: 3) {
        Text(state.primary)
          .font(.headline)
          .lineLimit(1)
        Text(subtitle)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        if let transfer = state.transfer {
          TransferRow(transfer: transfer)
            .padding(.top, 4)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(16)
  }

  private var subtitle: String {
    state.detail.isEmpty ? state.headline : "\(state.headline) · \(state.detail)"
  }
}

private struct TransferRow: View {
  let transfer: LumaActivityAttributes.ContentState.Transfer

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 5) {
        Image(systemName: transfer.uploading ? "arrow.up" : "arrow.down")
          .font(.caption2.weight(.semibold))
        Text(transfer.detail)
          .font(.caption2)
          .lineLimit(1)
      }
      .foregroundStyle(.secondary)

      if let fraction = transfer.fraction {
        ProgressView(value: min(max(fraction, 0), 1))
          .progressViewStyle(.linear)
          .tint(LumaTheme.accent)
      }
    }
  }
}

/// The Dynamic Island's trailing slot is a few points wide: percentage while a
/// transfer runs, otherwise the session count, and nothing when a single session
/// makes the count redundant.
private struct CompactTrailing: View {
  let state: LumaActivityAttributes.ContentState

  var body: some View {
    if let fraction = state.transfer?.fraction {
      Text("\(Int(min(max(fraction, 0), 1) * 100))%")
        .font(.caption2)
        .foregroundStyle(.secondary)
    } else if sessionCount > 1 {
      Text("\(sessionCount)")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(SessionStatus(state).tint)
    }
  }

  private var sessionCount: Int {
    state.connected + state.reconnecting + state.failed
  }
}
