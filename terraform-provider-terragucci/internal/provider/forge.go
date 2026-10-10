package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Forges the provider writes to, the same three terragucci's config names.
var forges = []string{"github", "gitlab", "forgejo"}

// errConflict is a write the forge refused because the file moved since it was read.
var errConflict = errors.New("the file changed since it was read")

// file is one file on a branch, as the forge's contents API answers it.
type file struct {
	exists  bool
	content []byte
	// GitHub and Forgejo: the blob SHA an update names. GitLab: the last commit
	// that touched the file.
	version string
}

// forge reads and writes one repository's files through its API.
type forge struct {
	kind  string
	api   string // API base, no trailing slash
	repo  string // owner/name, or a GitLab project's full path
	token string
	http  *http.Client
}

// apiBase is the API root for a forge origin, as terragucci's own forge.ts derives it.
func apiBase(kind, origin string) string {
	origin = strings.TrimRight(origin, "/")
	switch kind {
	case "github":
		if strings.EqualFold(origin, "https://github.com") || strings.EqualFold(origin, "http://github.com") {
			return "https://api.github.com"
		}
		return origin + "/api/v3"
	case "gitlab":
		return origin + "/api/v4"
	default:
		return origin + "/api/v1"
	}
}

// defaultOrigin is the forge's public origin, for a provider block that names none.
func defaultOrigin(kind string) string {
	switch kind {
	case "github":
		return "https://github.com"
	case "gitlab":
		return "https://gitlab.com"
	default:
		return "https://codeberg.org"
	}
}

// tokenEnv is the variable a forge's token is read from, as terragucci's DEFAULT_TOKEN_ENV names it.
func tokenEnv(kind string) string {
	switch kind {
	case "github":
		return "GITHUB_TOKEN"
	case "gitlab":
		return "GITLAB_TOKEN"
	default:
		return "FORGEJO_TOKEN"
	}
}

type httpError struct {
	method, path string
	status       int
	body         string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("%s %s answered %d: %s", e.method, e.path, e.status, e.body)
}

func (f *forge) call(ctx context.Context, method, path string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, f.api+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "application/json")
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if f.token != "" {
		switch f.kind {
		case "github":
			req.Header.Set("authorization", "Bearer "+f.token)
		case "gitlab":
			req.Header.Set("private-token", f.token)
		default:
			req.Header.Set("authorization", "token "+f.token)
		}
	}
	client := f.http
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		text := string(data)
		if len(text) > 300 {
			text = text[:300]
		}
		return &httpError{method: method, path: path, status: res.StatusCode, body: text}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func statusOf(err error) int {
	var he *httpError
	if errors.As(err, &he) {
		return he.status
	}
	return 0
}

// escapePath escapes each segment of a file path, keeping the slashes.
func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

func (f *forge) project() string { return url.PathEscape(f.repo) }

// defaultBranch is the repository's default branch.
func (f *forge) defaultBranch(ctx context.Context) (string, error) {
	var out struct {
		DefaultBranch string `json:"default_branch"`
	}
	path := "/repos/" + f.repo
	if f.kind == "gitlab" {
		path = "/projects/" + f.project()
	}
	if err := f.call(ctx, "GET", path, nil, &out); err != nil {
		return "", err
	}
	if out.DefaultBranch == "" {
		return "", fmt.Errorf("%s names no default branch; set branch in the provider block", f.repo)
	}
	return out.DefaultBranch, nil
}

// read fetches a file at a branch; a missing file is not an error.
func (f *forge) read(ctx context.Context, path, branch string) (file, error) {
	var out struct {
		Content      string `json:"content"`
		Encoding     string `json:"encoding"`
		SHA          string `json:"sha"`
		LastCommitID string `json:"last_commit_id"`
		Type         string `json:"type"`
	}
	var api string
	if f.kind == "gitlab" {
		api = "/projects/" + f.project() + "/repository/files/" + url.PathEscape(path) + "?ref=" + url.QueryEscape(branch)
	} else {
		api = "/repos/" + f.repo + "/contents/" + escapePath(path) + "?ref=" + url.QueryEscape(branch)
	}
	if err := f.call(ctx, "GET", api, nil, &out); err != nil {
		if statusOf(err) == 404 {
			return file{}, nil
		}
		return file{}, err
	}
	if out.Type != "" && out.Type != "file" {
		return file{}, fmt.Errorf("%s on %s is a %s, not a file", path, branch, out.Type)
	}
	content, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(out.Content, "\n", ""))
	if err != nil {
		return file{}, fmt.Errorf("%s: the forge's content is not base64: %w", path, err)
	}
	version := out.SHA
	if f.kind == "gitlab" {
		version = out.LastCommitID
	}
	return file{exists: true, content: content, version: version}, nil
}

// write creates or updates a file on a branch with one commit. prev is the
// file as it was read; a forge that finds it moved answers errConflict.
func (f *forge) write(ctx context.Context, path, branch string, content []byte, prev file, message string) error {
	enc := base64.StdEncoding.EncodeToString(content)
	var err error
	switch f.kind {
	case "gitlab":
		body := map[string]any{"branch": branch, "content": enc, "encoding": "base64", "commit_message": message}
		method := "POST"
		if prev.exists {
			method = "PUT"
			body["last_commit_id"] = prev.version
		}
		err = f.call(ctx, method, "/projects/"+f.project()+"/repository/files/"+url.PathEscape(path), body, nil)
	case "github":
		body := map[string]any{"branch": branch, "content": enc, "message": message}
		if prev.exists {
			body["sha"] = prev.version
		}
		err = f.call(ctx, "PUT", "/repos/"+f.repo+"/contents/"+escapePath(path), body, nil)
	default:
		body := map[string]any{"branch": branch, "content": enc, "message": message}
		method := "POST"
		if prev.exists {
			method = "PUT"
			body["sha"] = prev.version
		}
		err = f.call(ctx, method, "/repos/"+f.repo+"/contents/"+escapePath(path), body, nil)
	}
	return conflictOr(err)
}

// remove deletes a file on a branch with one commit.
func (f *forge) remove(ctx context.Context, path, branch string, prev file, message string) error {
	var err error
	if f.kind == "gitlab" {
		body := map[string]any{"branch": branch, "commit_message": message, "last_commit_id": prev.version}
		err = f.call(ctx, "DELETE", "/projects/"+f.project()+"/repository/files/"+url.PathEscape(path), body, nil)
	} else {
		body := map[string]any{"branch": branch, "message": message, "sha": prev.version}
		err = f.call(ctx, "DELETE", "/repos/"+f.repo+"/contents/"+escapePath(path), body, nil)
	}
	return conflictOr(err)
}

// conflictOr maps the answers a forge gives for a stale version to errConflict:
// 409 (GitHub, Forgejo), 422 (a create over a file that appeared, or a stale
// SHA), and GitLab's 400 for a file changed since its last_commit_id.
func conflictOr(err error) error {
	switch statusOf(err) {
	case 409, 422:
		return fmt.Errorf("%w: %v", errConflict, err)
	case 400:
		var he *httpError
		if errors.As(err, &he) && (strings.Contains(he.body, "has changed") || strings.Contains(he.body, "already exists")) {
			return fmt.Errorf("%w: %v", errConflict, err)
		}
	}
	return err
}
