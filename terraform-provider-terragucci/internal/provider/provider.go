// Package provider is the terragucci Terraform and OpenTofu provider: it
// writes a control repo's terragucci.yml through the forge's API, one key per
// resource, so `terragucci reconcile` reads what Terraform wrote.
package provider

import (
	"context"
	"os"
	"slices"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// DefaultPath is the control repo file the provider edits unless told otherwise.
const DefaultPath = "terragucci.yml"

var _ provider.Provider = &terragucciProvider{}

type terragucciProvider struct {
	version string
}

// New returns the provider factory main serves.
func New(version string) func() provider.Provider {
	return func() provider.Provider { return &terragucciProvider{version: version} }
}

type providerModel struct {
	Forge      types.String `tfsdk:"forge"`
	URL        types.String `tfsdk:"url"`
	API        types.String `tfsdk:"api"`
	Repository types.String `tfsdk:"repository"`
	Branch     types.String `tfsdk:"branch"`
	Path       types.String `tfsdk:"path"`
	Token      types.String `tfsdk:"token"`
}

func (p *terragucciProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "terragucci"
	resp.Version = p.version
}

func (p *terragucciProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Writes a terragucci control repo's terragucci.yml through the forge's API. Each resource owns one key of the file; `terragucci reconcile` reads the file as it does any other.",
		Attributes: map[string]schema.Attribute{
			"forge": schema.StringAttribute{
				Required:    true,
				Description: "The control repo's forge: github, gitlab or forgejo.",
			},
			"url": schema.StringAttribute{
				Optional:    true,
				Description: "The forge's origin, such as https://github.example.com. Default: github.com, gitlab.com or codeberg.org by forge.",
			},
			"api": schema.StringAttribute{
				Optional:    true,
				Description: "The API base, when it is not the one url implies (url + /api/v3 on GitHub Enterprise, /api/v4 on GitLab, /api/v1 on Forgejo).",
			},
			"repository": schema.StringAttribute{
				Required:    true,
				Description: "The control repo: owner/name, or a GitLab project's full path.",
			},
			"branch": schema.StringAttribute{
				Optional:    true,
				Description: "The branch the provider commits to. Default: the repository's default branch.",
			},
			"path": schema.StringAttribute{
				Optional:    true,
				Description: "The file in the control repo. Default: terragucci.yml.",
			},
			"token": schema.StringAttribute{
				Optional:    true,
				Sensitive:   true,
				Description: "A token that can push to the branch. Default: TERRAGUCCI_TOKEN, else GITHUB_TOKEN, GITLAB_TOKEN or FORGEJO_TOKEN by forge.",
			},
		},
	}
}

func (p *terragucciProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var m providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if m.Forge.IsUnknown() || m.Repository.IsUnknown() || m.URL.IsUnknown() || m.API.IsUnknown() || m.Branch.IsUnknown() || m.Path.IsUnknown() || m.Token.IsUnknown() {
		// Known at apply; resources are not called before then.
		return
	}
	kind := m.Forge.ValueString()
	if !slices.Contains(forges, kind) {
		resp.Diagnostics.AddAttributeError(path.Root("forge"), "Unknown forge", "forge is "+kind+"; use one of github, gitlab, forgejo")
		return
	}
	origin := m.URL.ValueString()
	if origin == "" {
		origin = defaultOrigin(kind)
	}
	api := m.API.ValueString()
	if api == "" {
		api = apiBase(kind, origin)
	}
	token := m.Token.ValueString()
	if token == "" {
		token = os.Getenv("TERRAGUCCI_TOKEN")
	}
	if token == "" {
		token = os.Getenv(tokenEnv(kind))
	}
	file := m.Path.ValueString()
	if file == "" {
		file = DefaultPath
	}
	c := &control{
		forge:  &forge{kind: kind, api: trimSlash(api), repo: m.Repository.ValueString(), token: token},
		branch: m.Branch.ValueString(),
		path:   file,
	}
	resp.ResourceData = c
	resp.DataSourceData = c
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

func (p *terragucciProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{newProjectResource, newDefaultsResource}
}

func (p *terragucciProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return nil
}
