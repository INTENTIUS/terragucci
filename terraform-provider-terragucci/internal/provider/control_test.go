package provider

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"gopkg.in/yaml.v3"
)

// fakeForge serves the contents API of one repository on one forge, in memory.
type fakeForge struct {
	t        *testing.T
	kind     string
	mu       sync.Mutex
	files    map[string]string // path -> content
	commits  []string          // commit messages
	conflict int               // writes to refuse as stale before taking one
	auth     string            // the auth header value every request must carry
}

func sum(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

func (f *fakeForge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	got := r.Header.Get("authorization")
	if f.kind == "gitlab" {
		got = r.Header.Get("private-token")
	}
	if got != f.auth {
		http.Error(w, "unauthorized", 401)
		return
	}
	var path string
	switch {
	case f.kind == "gitlab" && strings.HasPrefix(r.URL.EscapedPath(), "/api/v4/projects/acme%2Fcontrol/repository/files/"):
		p, _ := url.PathUnescape(strings.TrimPrefix(r.URL.EscapedPath(), "/api/v4/projects/acme%2Fcontrol/repository/files/"))
		path = p
	case f.kind == "gitlab" && r.URL.EscapedPath() == "/api/v4/projects/acme%2Fcontrol":
		json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
		return
	case f.kind != "gitlab" && strings.HasPrefix(r.URL.Path, f.prefix()+"/repos/acme/control/contents/"):
		path = strings.TrimPrefix(r.URL.Path, f.prefix()+"/repos/acme/control/contents/")
	case f.kind != "gitlab" && r.URL.Path == f.prefix()+"/repos/acme/control":
		json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
		return
	default:
		http.Error(w, "not found: "+r.URL.Path, 404)
		return
	}
	content, exists := f.files[path]
	version := sum(content)
	if r.Method == "GET" {
		if !exists {
			http.Error(w, "not found", 404)
			return
		}
		out := map[string]string{"content": base64.StdEncoding.EncodeToString([]byte(content)), "encoding": "base64"}
		if f.kind == "gitlab" {
			out["last_commit_id"] = version
		} else {
			out["sha"] = version
			out["type"] = "file"
		}
		json.NewEncoder(w).Encode(out)
		return
	}
	var body map[string]string
	json.NewDecoder(r.Body).Decode(&body)
	if body["branch"] != "main" {
		http.Error(w, "wrong branch "+body["branch"], 400)
		return
	}
	prev := body["sha"]
	msg := body["message"]
	if f.kind == "gitlab" {
		prev = body["last_commit_id"]
		msg = body["commit_message"]
	}
	if f.conflict > 0 {
		f.conflict--
		if f.kind == "gitlab" {
			http.Error(w, `{"message":"You are attempting to update a file that has changed since you started editing it."}`, 400)
		} else {
			http.Error(w, "sha does not match", 409)
		}
		return
	}
	creating := r.Method == "POST" || (f.kind == "github" && r.Method == "PUT" && prev == "")
	switch {
	case creating && exists:
		http.Error(w, "already exists", 422)
		return
	case !creating && !exists:
		http.Error(w, "not found", 404)
		return
	case !creating && prev != version:
		http.Error(w, "stale", 409)
		return
	}
	if r.Method == "DELETE" {
		delete(f.files, path)
	} else {
		b, err := base64.StdEncoding.DecodeString(body["content"])
		if err != nil {
			f.t.Errorf("content is not base64: %v", err)
		}
		f.files[path] = string(b)
	}
	f.commits = append(f.commits, msg)
	w.WriteHeader(201)
	w.Write([]byte("{}"))
}

func (f *fakeForge) prefix() string {
	if f.kind == "github" {
		return "/api/v3"
	}
	return "/api/v1"
}

func newControl(t *testing.T, kind string, files map[string]string) (*control, *fakeForge) {
	t.Helper()
	ff := &fakeForge{t: t, kind: kind, files: files}
	switch kind {
	case "github":
		ff.auth = "Bearer secret"
	case "gitlab":
		ff.auth = "secret"
	default:
		ff.auth = "token secret"
	}
	srv := httptest.NewServer(ff)
	t.Cleanup(srv.Close)
	return &control{forge: &forge{kind: kind, api: apiBase(kind, srv.URL), repo: "acme/control", token: "secret"}, path: DefaultPath}, ff
}

func obj(t *testing.T, m map[string]attr.Value) types.Dynamic {
	t.Helper()
	ts := map[string]attr.Type{}
	for k, v := range m {
		ts[k] = v.Type(context.Background())
	}
	o, d := types.ObjectValue(ts, m)
	if d.HasError() {
		t.Fatal(d)
	}
	return types.DynamicValue(o)
}

func roots(t *testing.T, globs ...string) attr.Value {
	t.Helper()
	ts := make([]attr.Type, len(globs))
	vs := make([]attr.Value, len(globs))
	for i, g := range globs {
		ts[i] = types.StringType
		vs[i] = types.StringValue(g)
	}
	v, d := types.TupleValue(ts, vs)
	if d.HasError() {
		t.Fatal(d)
	}
	return v
}

func TestProjectAndDefaultsOnEachForge(t *testing.T) {
	for _, kind := range forges {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			c, ff := newControl(t, kind, map[string]string{})
			settings := obj(t, map[string]attr.Value{"binary": types.StringValue("tofu"), "roots": roots(t, "envs/*")})
			if err := create(ctx, c, projectEntry, "github.com/acme/infra", settings); err != nil {
				t.Fatal(err)
			}
			if err := create(ctx, c, defaultsEntry, "", obj(t, map[string]attr.Value{"gate": types.StringValue("on-destroy")})); err != nil {
				t.Fatal(err)
			}
			want := "defaults:\n  gate: on-destroy\nprojects:\n  github.com/acme/infra:\n    binary: tofu\n    roots:\n      - envs/*\n"
			if got := ff.files["terragucci.yml"]; got != want {
				t.Fatalf("file:\n%s\nwant:\n%s", got, want)
			}
			// The state reads back as written, with no change to show.
			got, found, err := read(ctx, c, projectEntry, "github.com/acme/infra", settings)
			if err != nil || !found || !got.Equal(settings) {
				t.Fatalf("read %v %v %v", got, found, err)
			}
			if err := remove(ctx, c, projectEntry, "github.com/acme/infra"); err != nil {
				t.Fatal(err)
			}
			if got := ff.files["terragucci.yml"]; got != "defaults:\n  gate: on-destroy\n" {
				t.Fatalf("after removing the project:\n%s", got)
			}
			if err := remove(ctx, c, defaultsEntry, ""); err != nil {
				t.Fatal(err)
			}
			if _, ok := ff.files["terragucci.yml"]; ok {
				t.Fatal("a file left with no keys is deleted")
			}
			if len(ff.commits) != 4 || ff.commits[0] != "terraform: add terragucci_project github.com/acme/infra" {
				t.Fatalf("commits %q", ff.commits)
			}
		})
	}
}

func TestEditKeepsTheRestOfTheFile(t *testing.T) {
	ctx := context.Background()
	orig := "# the control repo\ndefaults:\n  binary: tofu # every project\nprojects:\n  github.com/acme/edge: {}\n  github.com/acme/infra:\n    roots: [\"envs/*\"]\n"
	c, ff := newControl(t, "forgejo", map[string]string{"terragucci.yml": orig})
	if err := update(ctx, c, projectEntry, "github.com/acme/infra", obj(t, map[string]attr.Value{"parallelism": types.NumberValue(bigInt(2))})); err != nil {
		t.Fatal(err)
	}
	got := ff.files["terragucci.yml"]
	for _, s := range []string{"# the control repo", "binary: tofu # every project", "github.com/acme/edge: {}", "    parallelism: 2\n"} {
		if !strings.Contains(got, s) {
			t.Fatalf("%q is gone:\n%s", s, got)
		}
	}
	if strings.Contains(got, "envs/*") {
		t.Fatalf("the old settings stayed:\n%s", got)
	}
}

func TestCreateOverAnExistingEntryNamesTheImport(t *testing.T) {
	c, ff := newControl(t, "github", map[string]string{"terragucci.yml": "projects:\n  github.com/acme/infra: {}\n"})
	err := create(context.Background(), c, projectEntry, "github.com/acme/infra", types.DynamicNull())
	if err == nil || !strings.Contains(err.Error(), "terraform import terragucci_project.<name> github.com/acme/infra") {
		t.Fatalf("err %v", err)
	}
	if len(ff.commits) != 0 {
		t.Fatal("nothing is written")
	}
}

func TestAStaleWriteIsRetriedOnTheNewFile(t *testing.T) {
	for _, kind := range forges {
		t.Run(kind, func(t *testing.T) {
			c, ff := newControl(t, kind, map[string]string{"terragucci.yml": "projects:\n  a.example/x/y: {}\n"})
			ff.conflict = 2
			if err := create(context.Background(), c, projectEntry, "a.example/x/z", types.DynamicNull()); err != nil {
				t.Fatal(err)
			}
			if got := ff.files["terragucci.yml"]; got != "projects:\n  a.example/x/y: {}\n  a.example/x/z: {}\n" {
				t.Fatalf("file:\n%s", got)
			}
		})
	}
}

func TestAnUpdateThatChangesNothingCommitsNothing(t *testing.T) {
	c, ff := newControl(t, "forgejo", map[string]string{"terragucci.yml": "projects:\n  a.example/x/y:\n    parallelism: 1\n"})
	if err := update(context.Background(), c, projectEntry, "a.example/x/y", obj(t, map[string]attr.Value{"parallelism": types.NumberValue(bigInt(1))})); err != nil {
		t.Fatal(err)
	}
	if len(ff.commits) != 0 {
		t.Fatalf("commits %q", ff.commits)
	}
}

func TestReadShowsWhatChangedInTheFile(t *testing.T) {
	ctx := context.Background()
	c, ff := newControl(t, "forgejo", map[string]string{})
	prior := obj(t, map[string]attr.Value{"binary": types.StringValue("tofu"), "token_env": types.StringValue("T")})
	if err := create(ctx, c, projectEntry, "a.example/x/y", prior); err != nil {
		t.Fatal(err)
	}
	// Someone drops a key by hand: the state shows it gone, so a plan puts it back.
	ff.files["terragucci.yml"] = "projects:\n  a.example/x/y:\n    binary: tofu\n"
	got, found, err := read(ctx, c, projectEntry, "a.example/x/y", prior)
	if err != nil || !found {
		t.Fatal(found, err)
	}
	if got.Equal(prior) {
		t.Fatal("the dropped key does not show")
	}
	g, _ := toGo(got)
	if !sameSettings(g, map[string]any{"binary": "tofu"}) {
		t.Fatalf("read %v", g)
	}
	// A project removed from the file is gone from state.
	ff.files["terragucci.yml"] = "projects: {}\n"
	if _, found, err := read(ctx, c, projectEntry, "a.example/x/y", prior); err != nil || found {
		t.Fatal(found, err)
	}
}

func TestDefaultBranchWhenNoneIsNamed(t *testing.T) {
	for _, kind := range forges {
		c, _ := newControl(t, kind, map[string]string{})
		if err := c.resolve(context.Background()); err != nil || c.branch != "main" {
			t.Fatalf("%s: branch %q, %v", kind, c.branch, err)
		}
	}
}

func TestAWrongTokenIsAnError(t *testing.T) {
	c, _ := newControl(t, "forgejo", map[string]string{})
	c.forge.token = "nope"
	c.branch = "main"
	err := create(context.Background(), c, projectEntry, "a.example/x/y", types.DynamicNull())
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err %v", err)
	}
}

func TestApiBase(t *testing.T) {
	cases := map[[2]string]string{
		{"github", "https://github.com"}:         "https://api.github.com",
		{"github", "https://ghe.example.com/"}:   "https://ghe.example.com/api/v3",
		{"gitlab", "https://gitlab.example.com"}: "https://gitlab.example.com/api/v4",
		{"forgejo", "http://localhost:3000"}:     "http://localhost:3000/api/v1",
	}
	for in, want := range cases {
		if got := apiBase(in[0], in[1]); got != want {
			t.Errorf("%v: %s, want %s", in, got, want)
		}
	}
}

func TestParseDoc(t *testing.T) {
	for _, s := range []string{"", "\n", "# only a comment\n", "~\n"} {
		root, err := parseDoc([]byte(s))
		if err != nil || root.Kind != yaml.MappingNode {
			t.Fatalf("%q: %v", s, err)
		}
	}
	if _, err := parseDoc([]byte("- a\n")); err == nil {
		t.Fatal("a list at the top is an error")
	}
}
