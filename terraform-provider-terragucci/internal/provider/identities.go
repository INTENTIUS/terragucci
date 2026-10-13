package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// The data sources do not compute identities themselves: they run
// `terragucci config identities --json` and pass its values through, so the
// provider and terragucci's pipeline cannot disagree on a subject, an
// audience or a trust policy. The Go tests read the goldens the core writes
// (testdata/identities), through a fake binary that prints them.

// identitiesSchema is the contract version the data sources read.
const identitiesSchema = "terragucci.identities/v1"

// sources is what the provider hands its data sources: the control repo, to
// read terragucci.yml from the forge, and the terragucci command to run.
type sources struct {
	control *control
	command []string
}

// commandOf splits the provider's terragucci_path into a command and its arguments. Empty is terragucci on PATH.
func commandOf(s string) []string {
	f := strings.Fields(s)
	if len(f) == 0 {
		return []string{"terragucci"}
	}
	return f
}

// envelope is the --json output of every terragucci command.
type envelope struct {
	Schema  int             `json:"schema"`
	Command string          `json:"command"`
	Exit    int             `json:"exit"`
	Status  string          `json:"status"`
	Results json.RawMessage `json:"results"`
	Error   string          `json:"error"`
}

type identitiesContract struct {
	Schema       string          `json:"schema"`
	File         string          `json:"file"`
	Forge        string          `json:"forge"`
	Repository   contractRepo    `json:"repository"`
	Environments []contractEntry `json:"environments"`
}

type contractRepo struct {
	Host          string `json:"host"`
	Path          string `json:"path"`
	DefaultBranch string `json:"default_branch"`
	OwnerID       string `json:"owner_id,omitempty"`
	RepoID        string `json:"repo_id,omitempty"`
}

type contractEntry struct {
	Name        string                    `json:"name"`
	Environment bool                      `json:"environment"`
	RootGlobs   []string                  `json:"root_globs"`
	Roots       []string                  `json:"roots"`
	Stages      map[string]*contractStage `json:"stages"`
}

type contractStage struct {
	Runner           *contractRunner `json:"runner"`
	ForgeEnvironment *string         `json:"forge_environment"`
	Token            contractToken   `json:"token"`
	AWS              *contractAWS    `json:"aws"`
	GCP              *contractGCP    `json:"gcp"`
	Azure            *contractAzure  `json:"azure"`
}

type contractRunner struct {
	Labels []string `json:"labels"`
	Group  *string  `json:"group"`
}

type contractToken struct {
	Issuer         string            `json:"issuer"`
	Subject        string            `json:"subject"`
	SubjectPattern bool              `json:"subject_pattern"`
	Claims         map[string]string `json:"claims"`
	Placeholders   []string          `json:"placeholders"`
}

type contractAWS struct {
	Role             *string           `json:"role"`
	RootRoles        map[string]string `json:"root_roles"`
	Audience         string            `json:"audience"`
	AssumeRolePolicy string            `json:"assume_role_policy"`
}

type contractGCP struct {
	ServiceAccount           string            `json:"service_account"`
	RootServiceAccounts      map[string]string `json:"root_service_accounts"`
	WorkloadIdentityProvider string            `json:"workload_identity_provider"`
	Audience                 string            `json:"audience"`
	AttributeCondition       string            `json:"attribute_condition"`
}

type contractAzure struct {
	ClientID                 string            `json:"client_id"`
	RootClientIDs            map[string]string `json:"root_client_ids"`
	TenantID                 string            `json:"tenant_id"`
	Issuer                   string            `json:"issuer"`
	Subject                  *string           `json:"subject"`
	Audiences                []string          `json:"audiences"`
	ClaimsMatchingExpression *string           `json:"claims_matching_expression"`
}

// identityInputs are the attributes both data sources take to say which config and repository to read.
type identityInputs struct {
	// path is a local terragucci.yml; empty reads the provider's control repo file from the forge.
	path          string
	project       string
	forge         string
	repository    string
	defaultBranch string
	ownerID       string
	repoID        string
}

// args are the command-line flags for `config identities`, after --config.
func (in identityInputs) args() []string {
	var out []string
	add := func(flag, v string) {
		if v != "" {
			out = append(out, flag, v)
		}
	}
	add("--project", in.project)
	add("--forge", in.forge)
	add("--repo", in.repository)
	add("--default-branch", in.defaultBranch)
	add("--owner-id", in.ownerID)
	add("--repo-id", in.repoID)
	return out
}

// identities reads the contract: from a local file, beside which terragucci
// reads the repo's roots, or from the control repo's file on the forge,
// whose roots it does not read.
func (s *sources) identities(ctx context.Context, in identityInputs) (*identitiesContract, []byte, error) {
	command := []string{"terragucci"}
	if s != nil && len(s.command) > 0 {
		command = s.command
	}
	file := in.path
	extra := in.args()
	if file == "" {
		if s == nil || s.control == nil {
			return nil, nil, errors.New("set path, or configure the provider's forge and repository to read terragucci.yml from the control repo")
		}
		_, f, err := s.control.load(ctx)
		if err != nil {
			return nil, nil, err
		}
		if !f.exists {
			return nil, nil, fmt.Errorf("%s is not on %s of %s", s.control.path, s.control.branch, s.control.forge.repo)
		}
		dir, err := os.MkdirTemp("", "terragucci-identities-")
		if err != nil {
			return nil, nil, err
		}
		defer os.RemoveAll(dir)
		file = filepath.Join(dir, filepath.Base(s.control.path))
		if err := os.WriteFile(file, f.content, 0o600); err != nil {
			return nil, nil, err
		}
		extra = append(extra, "--no-roots")
	}
	abs, err := filepath.Abs(file)
	if err != nil {
		return nil, nil, err
	}
	argv := append(append(append([]string{}, command[1:]...), "config", "identities", "--json", "--config", abs), extra...)
	cmd := exec.CommandContext(ctx, command[0], argv...)
	cmd.Dir = filepath.Dir(abs)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	return parseIdentities(stdout.Bytes(), stderr.String(), runErr, strings.Join(command, " "))
}

// parseIdentities reads `config identities --json`'s envelope: the contract, or why the command could not give one.
func parseIdentities(stdout []byte, stderr string, runErr error, command string) (*identitiesContract, []byte, error) {
	var e envelope
	if err := json.Unmarshal(stdout, &e); err != nil {
		// Not run at all, rather than run and failed: no such file, or not executable.
		var xe *exec.ExitError
		if runErr != nil && !errors.As(runErr, &xe) {
			return nil, nil, fmt.Errorf("cannot run %s: %v; install terragucci, or set terragucci_path in the provider block", command, runErr)
		}
		msg := strings.TrimSpace(stderr)
		if msg == "" && runErr != nil {
			msg = runErr.Error()
		}
		return nil, nil, fmt.Errorf("%s config identities printed no JSON envelope: %s", command, msg)
	}
	if e.Command != "config identities" {
		return nil, nil, fmt.Errorf("%s answered for %q, not config identities; it may be older than the data sources need", command, e.Command)
	}
	if e.Exit != 0 || len(e.Results) == 0 || string(e.Results) == "null" {
		return nil, nil, fmt.Errorf("terragucci config identities: %s", e.Error)
	}
	var c identitiesContract
	if err := json.Unmarshal(e.Results, &c); err != nil {
		return nil, nil, fmt.Errorf("terragucci config identities: %w", err)
	}
	if c.Schema != identitiesSchema {
		return nil, nil, fmt.Errorf("terragucci config identities printed schema %q; the provider reads %s", c.Schema, identitiesSchema)
	}
	return &c, e.Results, nil
}

// entry is one environment of the contract, by name.
func (c *identitiesContract) entry(name string) (*contractEntry, error) {
	var names []string
	for i := range c.Environments {
		if c.Environments[i].Name == name {
			return &c.Environments[i], nil
		}
		names = append(names, c.Environments[i].Name)
	}
	return nil, fmt.Errorf("no environment %q in %s (environments: %s)", name, c.File, strings.Join(names, ", "))
}
