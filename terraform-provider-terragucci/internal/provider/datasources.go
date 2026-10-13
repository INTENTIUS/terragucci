package provider

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// ── shared ──────────────────────────────────────────────────────────────────

// sourceAttributes are the inputs both data sources take.
func sourceAttributes() map[string]schema.Attribute {
	return map[string]schema.Attribute{
		"path": schema.StringAttribute{
			Optional:    true,
			Description: "A local terragucci.yml. terragucci reads the repo's roots beside it. Unset: the provider's control repo file, read from the forge, whose roots are not read (roots is null).",
		},
		"project": schema.StringAttribute{
			Optional:    true,
			Description: "A control repo's project, by its key, such as github.com/acme/infra. Required when the file lists projects.",
		},
		"forge": schema.StringAttribute{
			Optional:    true,
			Computed:    true,
			Description: "The forge whose jobs present the tokens: github, gitlab or forgejo. Default: the config's forge, the project key's host, or the git remote's.",
		},
		"repository": schema.StringAttribute{
			Optional:    true,
			Computed:    true,
			Description: "The repository whose jobs present the tokens: owner/name, or a GitLab project's full path. Default: the project key's path, or the git remote's.",
		},
		"default_branch": schema.StringAttribute{
			Optional:    true,
			Computed:    true,
			Description: "The repository's default branch, which the apply and drift jobs run on. Default: main.",
		},
		"forgejo_owner_id": schema.StringAttribute{
			Optional:    true,
			Description: "Forgejo: the repository owner's numeric id, which Forgejo puts in the token's subject. Unset: <owner-id> in the subject.",
		},
		"forgejo_repo_id": schema.StringAttribute{
			Optional:    true,
			Description: "Forgejo: the repository's numeric id, which Forgejo puts in the token's subject. Unset: <repo-id> in the subject.",
		},
		"id": schema.StringAttribute{Computed: true},
	}
}

// sourceModel holds the inputs of sourceAttributes; each data source's model embeds its fields.
type sourceModel struct {
	ID             types.String `tfsdk:"id"`
	Path           types.String `tfsdk:"path"`
	Project        types.String `tfsdk:"project"`
	Forge          types.String `tfsdk:"forge"`
	Repository     types.String `tfsdk:"repository"`
	DefaultBranch  types.String `tfsdk:"default_branch"`
	ForgejoOwnerID types.String `tfsdk:"forgejo_owner_id"`
	ForgejoRepoID  types.String `tfsdk:"forgejo_repo_id"`
}

func (m sourceModel) inputs() identityInputs {
	return identityInputs{
		path:          m.Path.ValueString(),
		project:       m.Project.ValueString(),
		forge:         m.Forge.ValueString(),
		repository:    m.Repository.ValueString(),
		defaultBranch: m.DefaultBranch.ValueString(),
		ownerID:       m.ForgejoOwnerID.ValueString(),
		repoID:        m.ForgejoRepoID.ValueString(),
	}
}

// fill sets the computed inputs from the contract.
func (m *sourceModel) fill(c *identitiesContract) {
	m.Forge = types.StringValue(c.Forge)
	m.Repository = types.StringValue(c.Repository.Path)
	m.DefaultBranch = types.StringValue(c.Repository.DefaultBranch)
	m.ID = types.StringValue(c.Repository.Host + "/" + c.Repository.Path)
}

func configuredSources(data any, d *diag.Diagnostics) *sources {
	if data == nil {
		return nil
	}
	s, ok := data.(*sources)
	if !ok {
		d.AddError("Unexpected provider data", fmt.Sprintf("got %T", data))
		return nil
	}
	return s
}

func strPtr(s *string) types.String {
	if s == nil {
		return types.StringNull()
	}
	return types.StringValue(*s)
}

// ── terragucci_environments ────────────────────────────────────────────────

type environmentsDataSource struct{ s *sources }

func newEnvironmentsDataSource() datasource.DataSource { return &environmentsDataSource{} }

var _ datasource.DataSourceWithConfigure = &environmentsDataSource{}

type environmentsModel struct {
	sourceModel
	Host         types.String        `tfsdk:"host"`
	JSON         types.String        `tfsdk:"json"`
	Environments map[string]envModel `tfsdk:"environments"`
}

type envModel struct {
	Environment bool        `tfsdk:"environment"`
	RootGlobs   []string    `tfsdk:"root_globs"`
	Roots       []string    `tfsdk:"roots"`
	Plan        *stageModel `tfsdk:"plan"`
	Apply       *stageModel `tfsdk:"apply"`
	Drift       *stageModel `tfsdk:"drift"`
}

type stageModel struct {
	RunnerLabels     []string          `tfsdk:"runner_labels"`
	RunnerGroup      types.String      `tfsdk:"runner_group"`
	ForgeEnvironment types.String      `tfsdk:"forge_environment"`
	Issuer           string            `tfsdk:"issuer"`
	Subject          string            `tfsdk:"subject"`
	SubjectPattern   bool              `tfsdk:"subject_pattern"`
	Claims           map[string]string `tfsdk:"claims"`
	Placeholders     []string          `tfsdk:"placeholders"`
	AWS              *awsModel         `tfsdk:"aws"`
	GCP              *gcpModel         `tfsdk:"gcp"`
	Azure            *azureModel       `tfsdk:"azure"`
}

type awsModel struct {
	Role             types.String      `tfsdk:"role"`
	RootRoles        map[string]string `tfsdk:"root_roles"`
	Audience         string            `tfsdk:"audience"`
	AssumeRolePolicy string            `tfsdk:"assume_role_policy"`
}

type gcpModel struct {
	ServiceAccount           string            `tfsdk:"service_account"`
	RootServiceAccounts      map[string]string `tfsdk:"root_service_accounts"`
	WorkloadIdentityProvider string            `tfsdk:"workload_identity_provider"`
	Audience                 string            `tfsdk:"audience"`
	AttributeCondition       string            `tfsdk:"attribute_condition"`
}

type azureModel struct {
	ClientID                 string            `tfsdk:"client_id"`
	RootClientIDs            map[string]string `tfsdk:"root_client_ids"`
	TenantID                 string            `tfsdk:"tenant_id"`
	Issuer                   string            `tfsdk:"issuer"`
	Subject                  types.String      `tfsdk:"subject"`
	Audiences                []string          `tfsdk:"audiences"`
	ClaimsMatchingExpression types.String      `tfsdk:"claims_matching_expression"`
}

func computedString(desc string) schema.StringAttribute {
	return schema.StringAttribute{Computed: true, Description: desc}
}

func computedStrings(desc string) schema.ListAttribute {
	return schema.ListAttribute{Computed: true, ElementType: types.StringType, Description: desc}
}

func computedMap(desc string) schema.MapAttribute {
	return schema.MapAttribute{Computed: true, ElementType: types.StringType, Description: desc}
}

func stageAttribute(desc string) schema.SingleNestedAttribute {
	return schema.SingleNestedAttribute{
		Computed:    true,
		Description: desc,
		Attributes: map[string]schema.Attribute{
			"runner_labels":     computedStrings("The runner labels the stage's jobs run on (runs-on, or GitLab tags). Null when runner gives none."),
			"runner_group":      computedString("The GitHub runner group, or null."),
			"forge_environment": computedString("The forge environment the apply jobs run in, on GitHub and GitLab. Null for plan and drift, on Forgejo, and for roots in no environment."),
			"issuer":            computedString("The OIDC token's issuer."),
			"subject":           computedString("The token's sub claim. With subject_pattern, * stands for any text."),
			"subject_pattern":   schema.BoolAttribute{Computed: true, Description: "Whether subject is a pattern: GitLab's merge request pipelines carry their source branch."},
			"claims":            computedMap("Other claims the job's token carries that a trust can check: GitLab's environment, environment_protected and ref_protected on an apply job with a forge environment."),
			"placeholders":      computedStrings("Parts of subject written as <name> that terragucci could not know, such as Forgejo's owner-id and repo-id."),
			"aws": schema.SingleNestedAttribute{
				Computed:    true,
				Description: "The AWS role and its trust. Null without AWS identities.",
				Attributes: map[string]schema.Attribute{
					"role":               computedString("The role the stage's jobs take for these roots; null when only oidc.roles names roles."),
					"root_roles":         computedMap("Roots whose role is not role, from oidc.roles."),
					"audience":           computedString("The token's aud."),
					"assume_role_policy": computedString("The trust policy, as JSON for aws_iam_role.assume_role_policy."),
				},
			},
			"gcp": schema.SingleNestedAttribute{
				Computed:    true,
				Description: "The GCP service account and the provider's condition. Null without oidc.gcp.",
				Attributes: map[string]schema.Attribute{
					"service_account":            computedString("The service account the stage's jobs impersonate."),
					"root_service_accounts":      computedMap("Roots whose service account is not service_account, from oidc.gcp.roles."),
					"workload_identity_provider": computedString("The Workload Identity Federation provider's resource name."),
					"audience":                   computedString("The token's aud."),
					"attribute_condition":        computedString("A CEL condition for google_iam_workload_identity_pool_provider.attribute_condition."),
				},
			},
			"azure": schema.SingleNestedAttribute{
				Computed:    true,
				Description: "The Entra client and its federated credential. Null without oidc.azure.",
				Attributes: map[string]schema.Attribute{
					"client_id":                  computedString("The client the stage's jobs take."),
					"root_client_ids":            computedMap("Roots whose client is not client_id, from oidc.azure.roles."),
					"tenant_id":                  computedString("The tenant."),
					"issuer":                     computedString("The federated credential's issuer."),
					"subject":                    computedString("The federated credential's subject; null when the subject is a pattern."),
					"audiences":                  computedStrings("The federated credential's audiences."),
					"claims_matching_expression": computedString("For a subject pattern, a flexible federated credential's expression; null otherwise."),
				},
			},
		},
	}
}

func (d *environmentsDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_environments"
}

func (d *environmentsDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	attrs := sourceAttributes()
	attrs["host"] = computedString("The forge's host.")
	attrs["json"] = computedString("The whole contract terragucci printed (results of `terragucci config identities --json`), as JSON.")
	attrs["environments"] = schema.MapNestedAttribute{
		Computed:    true,
		Description: "Each environment of terragucci.yml by name, and default for the roots in no environment when there are any.",
		NestedObject: schema.NestedAttributeObject{Attributes: map[string]schema.Attribute{
			"environment": schema.BoolAttribute{Computed: true, Description: "False for default, the roots in no environment."},
			"root_globs":  computedStrings("The environment's roots globs; for default, the top-level roots, or null when they are detected."),
			"roots":       computedStrings("The repo's roots in the environment; null when they were not read."),
			"plan":        stageAttribute("The pull request's plan job."),
			"apply":       stageAttribute("The default branch's apply jobs."),
			"drift":       stageAttribute("The scheduled drift job; null when drift is off."),
		}},
	}
	resp.Schema = schema.Schema{
		Description: "Per environment and stage of a terragucci.yml: the roots, runner, forge environment, cloud identities, and the OIDC subject and audience each job presents, from `terragucci config identities --json`.",
		Attributes:  attrs,
	}
}

func (d *environmentsDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.s = configuredSources(req.ProviderData, &resp.Diagnostics)
}

func (d *environmentsDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m environmentsModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	c, raw, err := d.s.identities(ctx, m.inputs())
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the identities", err.Error())
		return
	}
	environmentsState(&m, c, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

// environmentsState fills the data source's computed attributes from the contract.
func environmentsState(m *environmentsModel, c *identitiesContract, raw []byte) {
	m.fill(c)
	m.Host = types.StringValue(c.Repository.Host)
	m.JSON = types.StringValue(string(raw))
	m.Environments = map[string]envModel{}
	for _, e := range c.Environments {
		m.Environments[e.Name] = envModel{
			Environment: e.Environment,
			RootGlobs:   e.RootGlobs,
			Roots:       e.Roots,
			Plan:        stageState(e.Stages["plan"]),
			Apply:       stageState(e.Stages["apply"]),
			Drift:       stageState(e.Stages["drift"]),
		}
	}
}

func stageState(s *contractStage) *stageModel {
	if s == nil {
		return nil
	}
	out := &stageModel{
		RunnerGroup:      types.StringNull(),
		ForgeEnvironment: strPtr(s.ForgeEnvironment),
		Issuer:           s.Token.Issuer,
		Subject:          s.Token.Subject,
		SubjectPattern:   s.Token.SubjectPattern,
		Claims:           nonNilMap(s.Token.Claims),
		Placeholders:     nonNilList(s.Token.Placeholders),
	}
	if s.Runner != nil {
		out.RunnerLabels = nonNilList(s.Runner.Labels)
		out.RunnerGroup = strPtr(s.Runner.Group)
	}
	if a := s.AWS; a != nil {
		out.AWS = &awsModel{Role: strPtr(a.Role), RootRoles: nonNilMap(a.RootRoles), Audience: a.Audience, AssumeRolePolicy: a.AssumeRolePolicy}
	}
	if g := s.GCP; g != nil {
		out.GCP = &gcpModel{ServiceAccount: g.ServiceAccount, RootServiceAccounts: nonNilMap(g.RootServiceAccounts), WorkloadIdentityProvider: g.WorkloadIdentityProvider, Audience: g.Audience, AttributeCondition: g.AttributeCondition}
	}
	if z := s.Azure; z != nil {
		out.Azure = &azureModel{ClientID: z.ClientID, RootClientIDs: nonNilMap(z.RootClientIDs), TenantID: z.TenantID, Issuer: z.Issuer, Subject: strPtr(z.Subject), Audiences: nonNilList(z.Audiences), ClaimsMatchingExpression: strPtr(z.ClaimsMatchingExpression)}
	}
	return out
}

// nonNilMap and nonNilList keep an empty value empty rather than null: the contract's {} and [] are values.
func nonNilMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func nonNilList(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}

// ── terragucci_trust_policy ────────────────────────────────────────────────

var (
	stages = []string{"plan", "apply", "drift"}
	clouds = []string{"aws", "gcp", "azure"}
)

type trustPolicyDataSource struct{ s *sources }

func newTrustPolicyDataSource() datasource.DataSource { return &trustPolicyDataSource{} }

var _ datasource.DataSourceWithConfigure = &trustPolicyDataSource{}

type trustPolicyModel struct {
	sourceModel
	Environment types.String `tfsdk:"environment"`
	Stage       types.String `tfsdk:"stage"`
	Cloud       types.String `tfsdk:"cloud"`

	Issuer         types.String `tfsdk:"issuer"`
	Subject        types.String `tfsdk:"subject"`
	SubjectPattern types.Bool   `tfsdk:"subject_pattern"`
	Claims         types.Map    `tfsdk:"claims"`
	Audience       types.String `tfsdk:"audience"`
	Identity       types.String `tfsdk:"identity"`

	AWSAssumeRolePolicy           types.String `tfsdk:"aws_assume_role_policy"`
	GCPAttributeCondition         types.String `tfsdk:"gcp_attribute_condition"`
	AzureIssuer                   types.String `tfsdk:"azure_issuer"`
	AzureSubject                  types.String `tfsdk:"azure_subject"`
	AzureAudiences                types.List   `tfsdk:"azure_audiences"`
	AzureClaimsMatchingExpression types.String `tfsdk:"azure_claims_matching_expression"`
}

func (d *trustPolicyDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_trust_policy"
}

func (d *trustPolicyDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	attrs := sourceAttributes()
	attrs["environment"] = schema.StringAttribute{Required: true, Description: "An environment of terragucci.yml, or default for the roots in none."}
	attrs["stage"] = schema.StringAttribute{Required: true, Description: "plan, apply or drift."}
	attrs["cloud"] = schema.StringAttribute{Required: true, Description: "aws, gcp or azure."}
	attrs["issuer"] = computedString("The OIDC token's issuer.")
	attrs["subject"] = computedString("The token's sub claim; with subject_pattern, * stands for any text.")
	attrs["subject_pattern"] = schema.BoolAttribute{Computed: true, Description: "Whether subject is a pattern."}
	attrs["claims"] = computedMap("Other claims the job's token carries that the trust checks.")
	attrs["audience"] = computedString("The token's aud for this cloud.")
	attrs["identity"] = computedString("The stage's role ARN, service account or client id; null when only root globs name AWS roles.")
	attrs["aws_assume_role_policy"] = computedString("cloud aws: the trust policy JSON for aws_iam_role.assume_role_policy.")
	attrs["gcp_attribute_condition"] = computedString("cloud gcp: a CEL condition for google_iam_workload_identity_pool_provider.attribute_condition.")
	attrs["azure_issuer"] = computedString("cloud azure: the federated credential's issuer.")
	attrs["azure_subject"] = computedString("cloud azure: the federated credential's subject; null for a subject pattern.")
	attrs["azure_audiences"] = computedStrings("cloud azure: the federated credential's audiences.")
	attrs["azure_claims_matching_expression"] = computedString("cloud azure, a subject pattern: a flexible federated credential's expression.")
	resp.Schema = schema.Schema{
		Description: "The trust one cloud needs to accept one environment's job of one stage and no other job, from `terragucci config identities --json`.",
		Attributes:  attrs,
	}
}

func (d *trustPolicyDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.s = configuredSources(req.ProviderData, &resp.Diagnostics)
}

func (d *trustPolicyDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m trustPolicyModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if !slices.Contains(stages, m.Stage.ValueString()) {
		resp.Diagnostics.AddAttributeError(path.Root("stage"), "Unknown stage", "stage is "+m.Stage.ValueString()+"; use one of "+strings.Join(stages, ", "))
	}
	if !slices.Contains(clouds, m.Cloud.ValueString()) {
		resp.Diagnostics.AddAttributeError(path.Root("cloud"), "Unknown cloud", "cloud is "+m.Cloud.ValueString()+"; use one of "+strings.Join(clouds, ", "))
	}
	if resp.Diagnostics.HasError() {
		return
	}
	c, _, err := d.s.identities(ctx, m.inputs())
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the identities", err.Error())
		return
	}
	if err := trustPolicyState(&m, c); err != nil {
		resp.Diagnostics.AddError("No such trust", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

// trustPolicyState fills the data source's computed attributes for its environment, stage and cloud.
func trustPolicyState(m *trustPolicyModel, c *identitiesContract) error {
	env, stage, cloud := m.Environment.ValueString(), m.Stage.ValueString(), m.Cloud.ValueString()
	e, err := c.entry(env)
	if err != nil {
		return err
	}
	s := e.Stages[stage]
	if s == nil {
		return fmt.Errorf("%s has no %s job: drift is off in %s", env, stage, c.File)
	}
	m.fill(c)
	m.Issuer = types.StringValue(s.Token.Issuer)
	m.Subject = types.StringValue(s.Token.Subject)
	m.SubjectPattern = types.BoolValue(s.Token.SubjectPattern)
	m.Claims = types.MapValueMust(types.StringType, stringValues(s.Token.Claims))
	m.AWSAssumeRolePolicy = types.StringNull()
	m.GCPAttributeCondition = types.StringNull()
	m.AzureIssuer = types.StringNull()
	m.AzureSubject = types.StringNull()
	m.AzureAudiences = types.ListNull(types.StringType)
	m.AzureClaimsMatchingExpression = types.StringNull()
	switch cloud {
	case "aws":
		if s.AWS == nil {
			return fmt.Errorf("%s's %s job takes no AWS role: %s sets no oidc plan_role and apply_role, or oidc.roles", env, stage, c.File)
		}
		m.Audience = types.StringValue(s.AWS.Audience)
		m.Identity = strPtr(s.AWS.Role)
		m.AWSAssumeRolePolicy = types.StringValue(s.AWS.AssumeRolePolicy)
	case "gcp":
		if s.GCP == nil {
			return fmt.Errorf("%s's %s job takes no GCP service account: %s sets no oidc.gcp", env, stage, c.File)
		}
		m.Audience = types.StringValue(s.GCP.Audience)
		m.Identity = types.StringValue(s.GCP.ServiceAccount)
		m.GCPAttributeCondition = types.StringValue(s.GCP.AttributeCondition)
	case "azure":
		if s.Azure == nil {
			return fmt.Errorf("%s's %s job takes no Azure client: %s sets no oidc.azure", env, stage, c.File)
		}
		aud := types.StringNull()
		if len(s.Azure.Audiences) > 0 {
			aud = types.StringValue(s.Azure.Audiences[0])
		}
		m.Audience = aud
		m.Identity = types.StringValue(s.Azure.ClientID)
		m.AzureIssuer = types.StringValue(s.Azure.Issuer)
		m.AzureSubject = strPtr(s.Azure.Subject)
		m.AzureAudiences = types.ListValueMust(types.StringType, listValues(s.Azure.Audiences))
		m.AzureClaimsMatchingExpression = strPtr(s.Azure.ClaimsMatchingExpression)
	}
	return nil
}

func stringValues(m map[string]string) map[string]attr.Value {
	out := make(map[string]attr.Value, len(m))
	for k, v := range m {
		out[k] = types.StringValue(v)
	}
	return out
}

func listValues(l []string) []attr.Value {
	out := make([]attr.Value, len(l))
	for i, v := range l {
		out[i] = types.StringValue(v)
	}
	return out
}
