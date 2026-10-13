package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

// The goldens are terragucci's own `config identities --json` over its
// fixture configs (packages/terragucci/test/identities.test.ts writes them),
// so these tests hold the provider to what the core prints.

func goldenPath(t *testing.T, name string) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("testdata", "identities", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal(err)
	}
	return p
}

// goldenNames are the goldens the core wrote.
func goldenNames(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("testdata", "identities", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no goldens: %v", err)
	}
	var out []string
	for _, f := range files {
		out = append(out, strings.TrimSuffix(filepath.Base(f), ".json"))
	}
	return out
}

// fakeTerragucci is a terragucci that prints a golden and records its arguments, one per line.
func fakeTerragucci(t *testing.T, golden string) (*sources, string) {
	t.Helper()
	dir := t.TempDir()
	args := filepath.Join(dir, "args")
	script := filepath.Join(dir, "terragucci")
	body := "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + args + "'\ncat '" + golden + "'\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return &sources{command: []string{script}}, args
}

// localConfig is a terragucci.yml for path; the fake binary does not read it.
func localConfig(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "terragucci.yml")
	if err := os.WriteFile(p, []byte("forge: github\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func readArgs(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

// goldenResults is a golden's results, decoded apart from the provider's own types.
func goldenResults(t *testing.T, name string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(goldenPath(t, name))
	if err != nil {
		t.Fatal(err)
	}
	var e map[string]any
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	return e["results"].(map[string]any)
}

func emptyState(ctx context.Context, t *testing.T, s datasource.DataSource) tfsdk.State {
	t.Helper()
	var sr datasource.SchemaResponse
	s.Schema(ctx, datasource.SchemaRequest{}, &sr)
	if sr.Diagnostics.HasError() {
		t.Fatal(sr.Diagnostics)
	}
	return tfsdk.State{Schema: sr.Schema, Raw: tftypes.NewValue(sr.Schema.Type().TerraformType(ctx), nil)}
}

// configOf is a data source configuration holding model, as Terraform would send it.
func configOf(ctx context.Context, t *testing.T, s datasource.DataSource, model any) tfsdk.Config {
	t.Helper()
	st := emptyState(ctx, t, s)
	if d := st.Set(ctx, model); d.HasError() {
		t.Fatal(d)
	}
	return tfsdk.Config{Schema: st.Schema, Raw: st.Raw}
}

func readSource(ctx context.Context, t *testing.T, s datasource.DataSource, model any) tfsdk.State {
	t.Helper()
	resp := datasource.ReadResponse{State: emptyState(ctx, t, s)}
	s.(interface {
		Read(context.Context, datasource.ReadRequest, *datasource.ReadResponse)
	}).Read(ctx, datasource.ReadRequest{Config: configOf(ctx, t, s, model)}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatal(resp.Diagnostics)
	}
	return resp.State
}

func TestEnvironmentsMatchEachGolden(t *testing.T) {
	ctx := context.Background()
	for _, name := range goldenNames(t) {
		t.Run(name, func(t *testing.T) {
			src, _ := fakeTerragucci(t, goldenPath(t, name))
			ds := &environmentsDataSource{s: src}
			state := readSource(ctx, t, ds, &environmentsModel{sourceModel: sourceModel{Path: types.StringValue(localConfig(t))}})
			var m environmentsModel
			if d := state.Get(ctx, &m); d.HasError() {
				t.Fatal(d)
			}
			g := goldenResults(t, name)
			repo := g["repository"].(map[string]any)
			if m.Forge.ValueString() != g["forge"] || m.Repository.ValueString() != repo["path"] || m.DefaultBranch.ValueString() != repo["default_branch"] || m.Host.ValueString() != repo["host"] {
				t.Fatalf("forge %s repository %s branch %s host %s, golden %v %v", m.Forge, m.Repository, m.DefaultBranch, m.Host, g["forge"], repo)
			}
			envs := g["environments"].([]any)
			if len(m.Environments) != len(envs) {
				t.Fatalf("%d environments, golden %d", len(m.Environments), len(envs))
			}
			for _, ge := range envs {
				ge := ge.(map[string]any)
				e, ok := m.Environments[ge["name"].(string)]
				if !ok {
					t.Fatalf("no environment %s", ge["name"])
				}
				if e.Environment != ge["environment"].(bool) {
					t.Fatalf("%s environment %v", ge["name"], e.Environment)
				}
				if (ge["roots"] == nil) != (e.Roots == nil) {
					t.Fatalf("%s roots %v, golden %v", ge["name"], e.Roots, ge["roots"])
				}
				stages := ge["stages"].(map[string]any)
				for st, got := range map[string]*stageModel{"plan": e.Plan, "decide": e.Decide, "confirm": e.Confirm, "apply": e.Apply, "drift": e.Drift} {
					gs, _ := stages[st].(map[string]any)
					if gs == nil {
						if got != nil {
							t.Fatalf("%s %s: a stage the golden has not", ge["name"], st)
						}
						continue
					}
					tok := gs["token"].(map[string]any)
					if got.Subject != tok["subject"] || got.Issuer != tok["issuer"] || got.SubjectPattern != tok["subject_pattern"] {
						t.Fatalf("%s %s: sub %s iss %s, golden %v", ge["name"], st, got.Subject, got.Issuer, tok)
					}
					if fe, _ := gs["forge_environment"].(string); got.ForgeEnvironment.ValueString() != fe {
						t.Fatalf("%s %s: forge environment %s, golden %s", ge["name"], st, got.ForgeEnvironment, fe)
					}
					if a, _ := gs["aws"].(map[string]any); (a == nil) != (got.AWS == nil) || (a != nil && (got.AWS.AssumeRolePolicy != a["assume_role_policy"] || got.AWS.Audience != a["audience"] || len(got.AWS.Trusts) != len(a["trusts"].([]any)))) {
						t.Fatalf("%s %s: aws %+v, golden %v", ge["name"], st, got.AWS, a)
					}
					if gc, _ := gs["gcp"].(map[string]any); (gc == nil) != (got.GCP == nil) || (gc != nil && got.GCP.AttributeCondition != gc["attribute_condition"]) {
						t.Fatalf("%s %s: gcp %+v, golden %v", ge["name"], st, got.GCP, gc)
					}
					if z, _ := gs["azure"].(map[string]any); (z == nil) != (got.Azure == nil) || (z != nil && got.Azure.ClientID != z["client_id"]) {
						t.Fatalf("%s %s: azure %+v, golden %v", ge["name"], st, got.Azure, z)
					}
				}
			}
			var whole map[string]any
			if err := json.Unmarshal([]byte(m.JSON.ValueString()), &whole); err != nil || whole["schema"] != identitiesSchema {
				t.Fatalf("json %v %v", whole["schema"], err)
			}
		})
	}
}

func TestTrustPolicyFromGoldens(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		golden, env, stage, cloud string
		check                     func(t *testing.T, m trustPolicyModel)
	}{
		{"github-aws", "prod", "apply", "aws", func(t *testing.T, m trustPolicyModel) {
			want := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"arn:aws:iam::222222222222:oidc-provider/token.actions.githubusercontent.com"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"terragucci-prod-apply","token.actions.githubusercontent.com:sub":"repo:acme/infra:environment:production"}}}]}`
			if m.AWSAssumeRolePolicy.ValueString() != want {
				t.Fatalf("policy %s", m.AWSAssumeRolePolicy)
			}
			if m.Identity.ValueString() != "arn:aws:iam::222222222222:role/prod-apply" || m.Audience.ValueString() != "terragucci-prod-apply" || !m.GCPAttributeCondition.IsNull() || !m.AzureSubject.IsNull() {
				t.Fatalf("identity %s audience %s gcp %s azure %s", m.Identity, m.Audience, m.GCPAttributeCondition, m.AzureSubject)
			}
		}},
		{"github-aws", "dev", "apply", "aws", func(t *testing.T, m trustPolicyModel) {
			if !strings.Contains(m.AWSAssumeRolePolicy.ValueString(), `"repo:acme/infra:environment:dev"`) || strings.Contains(m.AWSAssumeRolePolicy.ValueString(), ":environment:production") {
				t.Fatalf("dev's policy %s", m.AWSAssumeRolePolicy)
			}
		}},
		{"gitlab-gcp", "prod", "apply", "gcp", func(t *testing.T, m trustPolicyModel) {
			want := "assertion.sub == 'project_path:acme/platform/infra:ref_type:branch:ref:trunk' && assertion.environment == 'production' && assertion.environment_protected == 'true' && assertion.ref_protected == 'true'"
			if m.GCPAttributeCondition.ValueString() != want {
				t.Fatalf("condition %s", m.GCPAttributeCondition)
			}
			if m.Claims.Elements()["environment_protected"].(types.String).ValueString() != "true" {
				t.Fatalf("claims %s", m.Claims)
			}
		}},
		{"gitlab-gcp", "prod", "plan", "gcp", func(t *testing.T, m trustPolicyModel) {
			// The plan service account serves the merge request's plan job, each wave's deciding job and drift.
			if !m.SubjectPattern.ValueBool() || m.GCPAttributeCondition.ValueString() != "(assertion.sub.startsWith('project_path:acme/platform/infra:ref_type:branch:ref:')) || (assertion.sub == 'project_path:acme/platform/infra:ref_type:branch:ref:trunk')" {
				t.Fatalf("pattern %v condition %s", m.SubjectPattern, m.GCPAttributeCondition)
			}
		}},
		{"azure", "prod", "apply", "azure", func(t *testing.T, m trustPolicyModel) {
			var auds []string
			m.AzureAudiences.ElementsAs(context.Background(), &auds, false)
			if m.AzureSubject.ValueString() != "repo:acme/infra:environment:prod" || m.AzureIssuer.ValueString() != "https://token.actions.githubusercontent.com" || !slices.Equal(auds, []string{"api://AzureADTokenExchangeUSGov"}) || m.Identity.ValueString() != "00000000-0000-0000-0000-0000000000b2" {
				t.Fatalf("subject %s issuer %s audiences %v identity %s", m.AzureSubject, m.AzureIssuer, auds, m.Identity)
			}
		}},
		{"forgejo-aws-ids", "prod", "plan", "aws", func(t *testing.T, m trustPolicyModel) {
			if !strings.Contains(m.AWSAssumeRolePolicy.ValueString(), `"git.example.com/api/actions:sub":"repo:acme-3/infra-17:pull_request"`) {
				t.Fatalf("policy %s", m.AWSAssumeRolePolicy)
			}
		}},
		{"github-aws", "prod", "decide", "aws", func(t *testing.T, m trustPolicyModel) {
			var p struct{ Statement []any }
			json.Unmarshal([]byte(m.AWSAssumeRolePolicy.ValueString()), &p)
			if m.Subject.ValueString() != "repo:acme/infra:ref:refs/heads/main" || m.Audience.ValueString() != "terragucci-plan" || len(p.Statement) != 3 {
				t.Fatalf("subject %s audience %s policy %s", m.Subject, m.Audience, m.AWSAssumeRolePolicy)
			}
		}},
		{"pr-apply", "default", "confirm", "aws", func(t *testing.T, m trustPolicyModel) {
			if m.Identity.ValueString() != "arn:aws:iam::121212121212:role/plan" || m.Audience.ValueString() != "terragucci-apply" || !strings.Contains(m.AWSAssumeRolePolicy.ValueString(), `"repo:acme/infra:pull_request"`) {
				t.Fatalf("identity %s audience %s policy %s", m.Identity, m.Audience, m.AWSAssumeRolePolicy)
			}
		}},
		{"no-environments", "default", "apply", "aws", func(t *testing.T, m trustPolicyModel) {
			if m.Subject.ValueString() != "repo:acme/infra:ref:refs/heads/main" {
				t.Fatalf("subject %s", m.Subject)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.golden+"/"+c.env+"/"+c.stage+"/"+c.cloud, func(t *testing.T) {
			src, _ := fakeTerragucci(t, goldenPath(t, c.golden))
			ds := &trustPolicyDataSource{s: src}
			state := readSource(ctx, t, ds, &trustPolicyModel{
				sourceModel: sourceModel{Path: types.StringValue(localConfig(t))},
				Environment: types.StringValue(c.env), Stage: types.StringValue(c.stage), Cloud: types.StringValue(c.cloud),
				Claims: types.MapNull(types.StringType), AzureAudiences: types.ListNull(types.StringType),
			})
			var m trustPolicyModel
			if d := state.Get(ctx, &m); d.HasError() {
				t.Fatal(d)
			}
			c.check(t, m)
		})
	}
}

func TestTrustPolicyRefusesWhatTheConfigLacks(t *testing.T) {
	cases := []struct{ golden, env, stage, cloud, want string }{
		{"github-aws", "staging", "apply", "aws", `no environment "staging"`},
		{"forgejo-aws", "prod", "drift", "aws", "drift is off"},
		{"github-aws", "prod", "confirm", "aws", "apply.when: pull-request"},
		{"github-aws", "prod", "apply", "gcp", "no oidc.gcp"},
		{"gitlab-gcp", "prod", "apply", "azure", "no oidc.azure"},
		{"azure", "prod", "apply", "aws", "no AWS role"},
	}
	for _, c := range cases {
		b, err := os.ReadFile(goldenPath(t, c.golden))
		if err != nil {
			t.Fatal(err)
		}
		contract, _, err := parseIdentities(b, "", nil, "terragucci")
		if err != nil {
			t.Fatal(err)
		}
		m := trustPolicyModel{Environment: types.StringValue(c.env), Stage: types.StringValue(c.stage), Cloud: types.StringValue(c.cloud)}
		if err := trustPolicyState(&m, contract); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%v: %v, want %q", c, err, c.want)
		}
	}
}

func TestNoDecideStageWhenAWaveAppliesInOneJob(t *testing.T) {
	b, err := os.ReadFile(goldenPath(t, "no-environments"))
	if err != nil {
		t.Fatal(err)
	}
	contract, _, err := parseIdentities(b, "", nil, "terragucci")
	if err != nil {
		t.Fatal(err)
	}
	contract.Environments[0].Stages["decide"] = nil
	m := trustPolicyModel{Environment: types.StringValue("default"), Stage: types.StringValue("decide"), Cloud: types.StringValue("aws")}
	if err := trustPolicyState(&m, contract); err == nil || !strings.Contains(err.Error(), "applies in one job") {
		t.Fatalf("%v", err)
	}
}

func TestTheBinaryGetsTheInputsAsFlags(t *testing.T) {
	ctx := context.Background()
	src, args := fakeTerragucci(t, goldenPath(t, "forgejo-aws-ids"))
	cfg := localConfig(t)
	in := identityInputs{path: cfg, forge: "forgejo", repository: "acme/infra", defaultBranch: "trunk", ownerID: "3", repoID: "17"}
	if _, _, err := src.identities(ctx, in); err != nil {
		t.Fatal(err)
	}
	want := []string{"config", "identities", "--json", "--config", cfg, "--forge", "forgejo", "--repo", "acme/infra", "--default-branch", "trunk", "--owner-id", "3", "--repo-id", "17"}
	if got := readArgs(t, args); !slices.Equal(got, want) {
		t.Fatalf("args %q\nwant %q", got, want)
	}
}

func TestFromTheForgeTheRootsAreNotRead(t *testing.T) {
	ctx := context.Background()
	c, _ := newControl(t, "github", map[string]string{"terragucci.yml": "projects:\n  gitlab.com/acme/platform/infra: {}\n"})
	src, args := fakeTerragucci(t, goldenPath(t, "control"))
	src.control = c
	contract, _, err := src.identities(ctx, identityInputs{project: "gitlab.com/acme/platform/infra"})
	if err != nil {
		t.Fatal(err)
	}
	got := readArgs(t, args)
	if got[3] != "--config" || filepath.Base(got[4]) != "terragucci.yml" || !slices.Equal(got[5:], []string{"--project", "gitlab.com/acme/platform/infra", "--no-roots"}) {
		t.Fatalf("args %q", got)
	}
	if contract.Forge != "gitlab" || contract.Environments[0].Roots != nil {
		t.Fatalf("contract %+v", contract)
	}
}

func TestTheCommandsFailuresAreErrors(t *testing.T) {
	if _, _, err := parseIdentities([]byte(`{"schema":1,"command":"config identities","exit":2,"status":"usage","results":null,"error":"this config lists projects"}`), "", nil, "terragucci"); err == nil || !strings.Contains(err.Error(), "this config lists projects") {
		t.Fatalf("usage: %v", err)
	}
	if _, _, err := parseIdentities([]byte(`{"schema":1,"command":"config check","exit":2,"status":"usage","results":null,"error":"usage"}`), "", nil, "terragucci"); err == nil || !strings.Contains(err.Error(), "older") {
		t.Fatalf("an older terragucci: %v", err)
	}
	if _, _, err := parseIdentities(nil, "boom", nil, "terragucci"); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("no JSON: %v", err)
	}
	src := &sources{command: []string{filepath.Join(t.TempDir(), "missing")}}
	if _, _, err := src.identities(context.Background(), identityInputs{path: localConfig(t)}); err == nil || !strings.Contains(err.Error(), "terragucci_path") {
		t.Fatalf("missing binary: %v", err)
	}
	if got := commandOf("npx -y @intentius/terragucci"); !slices.Equal(got, []string{"npx", "-y", "@intentius/terragucci"}) {
		t.Fatalf("commandOf %q", got)
	}
	if got := commandOf(""); !slices.Equal(got, []string{"terragucci"}) {
		t.Fatalf("commandOf empty %q", got)
	}
}
