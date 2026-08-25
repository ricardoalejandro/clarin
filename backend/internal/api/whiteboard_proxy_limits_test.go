package api

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestWhiteboardSmallMutationRoutesAreBoundedAtTraefik(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source")
	}
	raw, err := os.ReadFile(filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", "..", "docker-compose.yml")))
	if err != nil {
		t.Fatal(err)
	}
	compose := string(raw)
	for _, invariant := range []string{
		"traefik.http.routers.clarin-whiteboard-guest-session.rule=Host(`clarin.naperu.cloud`) && Method(`POST`) && PathRegexp(`(?i)^",
		"traefik.http.middlewares.clarin-whiteboard-guest-session-limit.buffering.maxRequestBodyBytes=16384",
		"traefik.http.middlewares.clarin-whiteboard-guest-session-limit.buffering.memRequestBodyBytes=16384",
		"traefik.http.routers.clarin-whiteboard-library-start.rule=Host(`clarin.naperu.cloud`) && Method(`POST`) && PathRegexp(`(?i)^",
		"traefik.http.routers.clarin-whiteboard-library-callback.rule=Host(`clarin.naperu.cloud`) && Method(`POST`) && PathRegexp(`(?i)^",
		"traefik.http.routers.clarin-whiteboard-library-complete.rule=Host(`clarin.naperu.cloud`) && Method(`POST`) && PathRegexp(`(?i)^",
		"traefik.http.middlewares.clarin-whiteboard-library-import-limit.buffering.maxRequestBodyBytes=4096",
		"traefik.http.middlewares.clarin-whiteboard-library-import-limit.buffering.memRequestBodyBytes=4096",
		"traefik.http.routers.clarin-whiteboard-comment-post.rule=Host(`clarin.naperu.cloud`) && Method(`POST`)",
		"traefik.http.routers.clarin-whiteboard-comment-patch.rule=Host(`clarin.naperu.cloud`) && Method(`PATCH`)",
		"traefik.http.routers.clarin-whiteboard-comment-delete.rule=Host(`clarin.naperu.cloud`) && Method(`DELETE`)",
		"traefik.http.middlewares.clarin-whiteboard-comment-limit.buffering.maxRequestBodyBytes=16384",
		"traefik.http.middlewares.clarin-whiteboard-comment-limit.buffering.memRequestBodyBytes=16384",
		`- "127.0.0.1:8080:8080"`,
		`- "127.0.0.1:8081:8081"`,
	} {
		if !strings.Contains(compose, invariant) {
			t.Fatalf("docker-compose lost whiteboard edge invariant %q", invariant)
		}
	}
	for _, remotelyPublished := range []string{`- "8080:8080"`, `- "8081:8081"`} {
		if strings.Contains(compose, remotelyPublished) {
			t.Fatalf("backend direct port bypass remains: %s", remotelyPublished)
		}
	}
	routes := []struct {
		name       string
		middleware string
		priority   int
		paths      []string
	}{
		{
			name: "clarin-whiteboard-guest-session", middleware: "clarin-whiteboard-guest-session-limit", priority: 250,
			paths: []string{"/API/PUBLIC/WHITEBOARD-LINKS/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/SESSION/"},
		},
		{
			name: "clarin-whiteboard-library-start", middleware: "clarin-whiteboard-library-import-limit", priority: 260,
			paths: []string{"/API/WHITEBOARDS/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/PUBLIC-LIBRARY-IMPORT/START/"},
		},
		{
			name: "clarin-whiteboard-library-callback", middleware: "clarin-whiteboard-library-import-limit", priority: 260,
			paths: []string{"/API/WHITEBOARDS/PUBLIC-LIBRARY-IMPORT/CALLBACK/"},
		},
		{
			name: "clarin-whiteboard-library-complete", middleware: "clarin-whiteboard-library-import-limit", priority: 260,
			paths: []string{"/API/WHITEBOARDS/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/PUBLIC-LIBRARY-IMPORTS/BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB/COMPLETE/"},
		},
		{
			name: "clarin-whiteboard-comment-post", middleware: "clarin-whiteboard-comment-limit", priority: 260,
			paths: []string{
				"/API/WHITEBOARDS/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/COMMENT-THREADS/",
				"/API/WHITEBOARDS/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/COMMENT-THREADS/BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB/REPLIES/",
			},
		},
		{
			name: "clarin-whiteboard-comment-patch", middleware: "clarin-whiteboard-comment-limit", priority: 260,
			paths: []string{
				"/API/WHITEBOARDS/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/COMMENT-THREADS/BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB/COMMENTS/CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC/",
				"/API/WHITEBOARDS/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/COMMENT-THREADS/BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB/STATUS/",
			},
		},
		{
			name: "clarin-whiteboard-comment-delete", middleware: "clarin-whiteboard-comment-limit", priority: 260,
			paths: []string{"/API/WHITEBOARDS/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/COMMENT-THREADS/BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB/COMMENTS/CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC/"},
		},
	}
	for _, route := range routes {
		for _, invariant := range []string{
			"traefik.http.routers." + route.name + ".priority=" + strconv.Itoa(route.priority),
			"traefik.http.routers." + route.name + ".middlewares=" + route.middleware,
		} {
			if !strings.Contains(compose, invariant) {
				t.Fatalf("router %s lost edge invariant %q", route.name, invariant)
			}
		}
		pathPattern := whiteboardTraefikPathRegexp(t, compose, route.name)
		for _, path := range route.paths {
			if !pathPattern.MatchString(path) {
				t.Fatalf("router %s does not protect case/slash variant %q with %q", route.name, path, pathPattern.String())
			}
		}
	}
}

func whiteboardTraefikPathRegexp(t *testing.T, compose, router string) *regexp.Regexp {
	t.Helper()
	prefix := "traefik.http.routers." + router + ".rule="
	start := strings.Index(compose, prefix)
	if start < 0 {
		t.Fatalf("missing router rule %s", router)
	}
	line := compose[start:]
	if end := strings.IndexByte(line, '\n'); end >= 0 {
		line = line[:end]
	}
	marker := "PathRegexp(`"
	patternStart := strings.Index(line, marker)
	if patternStart < 0 {
		t.Fatalf("router %s does not use PathRegexp: %s", router, line)
	}
	patternStart += len(marker)
	patternEnd := strings.Index(line[patternStart:], "`)")
	if patternEnd < 0 {
		t.Fatalf("router %s has malformed PathRegexp: %s", router, line)
	}
	compiled, err := regexp.Compile(line[patternStart : patternStart+patternEnd])
	if err != nil {
		t.Fatalf("router %s has invalid PathRegexp: %v", router, err)
	}
	return compiled
}
