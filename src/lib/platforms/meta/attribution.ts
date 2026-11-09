// The conversion attribution windows that Meta's insight numbers (actions / action_values /
// cost_per_action_type, and therefore bookings/leads/CPA) are reported under. Centralized in ONE place
// so the windows the fetchers send to Meta and the label the dashboard shows users can never drift
// apart. We report 7-day click / 1-day view — Meta's current default for most objectives.

export const ACTION_ATTRIBUTION_WINDOWS_ARR = ['7d_click', '1d_view'] as const

/** The exact JSON string passed to the Graph API's `action_attribution_windows` query param. */
export const ACTION_ATTRIBUTION_WINDOWS = JSON.stringify(ACTION_ATTRIBUTION_WINDOWS_ARR)

/** Human label for an attribution window list, e.g. "7-day click / 1-day view". */
export function attributionWindowLabel(windows: readonly string[] = ACTION_ATTRIBUTION_WINDOWS_ARR): string {
  return windows
    .map((w) => {
      const m = /^(\d+)d_(click|view)$/.exec(w)
      return m ? `${m[1]}-day ${m[2]}` : w
    })
    .join(' / ')
}

/** Precomputed label for the active windows — what to show next to any Meta conversion estimate. */
export const ATTRIBUTION_WINDOW_LABEL = attributionWindowLabel()
