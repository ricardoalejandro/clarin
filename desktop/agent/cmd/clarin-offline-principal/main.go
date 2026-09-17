package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/google/uuid"

	"github.com/naperu/clarin-offline-agent/internal/v3/principalpipe"
)

func main() {
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	parsed, err := url.Parse(os.Args[1])
	if err != nil || parsed.Scheme != "clarin-offline-v3" || parsed.Host != "principal" || parsed.User != nil || parsed.Path != "" || parsed.Fragment != "" {
		os.Exit(2)
	}
	query := parsed.Query()
	if len(query) != 1 || len(query["challenge"]) != 1 {
		os.Exit(2)
	}
	challengeID := query.Get("challenge")
	id, err := uuid.Parse(challengeID)
	if err != nil || id.String() != strings.ToLower(challengeID) {
		os.Exit(2)
	}
	if err := principalpipe.Complete(challengeID); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "Clarin Offline no pudo validar la sesión de Windows")
		os.Exit(1)
	}
}
