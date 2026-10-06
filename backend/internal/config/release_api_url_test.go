package config

import "testing"

// A fork must be able to point the panel's own update check at its own
// repository. Without an override the panel reports the upstream release as an
// available update and the one-click updater would replace this build with the
// upstream image.
func TestReleaseAPIURLDefaultsToEmptyForBuiltInUpstreamFallback(t *testing.T) {
	t.Setenv("PANEL_RELEASE_API_URL", "")
	if got := Load().ReleaseAPIURL; got != "" {
		t.Fatalf("ReleaseAPIURL = %q, want empty so updatecheck keeps its built-in default", got)
	}
}

func TestReleaseAPIURLCanPointAtAFork(t *testing.T) {
	const fork = "https://api.github.com/repos/EeiMo/stardew-server-anxi-panel/releases/latest"
	t.Setenv("PANEL_RELEASE_API_URL", fork)
	if got := Load().ReleaseAPIURL; got != fork {
		t.Fatalf("ReleaseAPIURL = %q, want %q", got, fork)
	}
}
