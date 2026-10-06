package web

import "github.com/eeimo/stardew-server-anxi-panel/backend/internal/games/installerrors"

func installRequestFailureMessage(err error, fallback string) string {
	if err != nil {
		if rule := installerrors.Match(err.Error()); rule != nil {
			return rule.Message
		}
	}
	return sanitizeErrorMsg(err, fallback)
}
