// Package provider is the terragucci Terraform and OpenTofu provider. It has
// data sources only: they run `terragucci config identities --json` and
// `terragucci forge check --json` over a local terragucci.yml and pass the
// values through. The control repo's projects and defaults live in chant
// workspace records (terragucci control records), so the provider no longer
// writes them.
package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var _ provider.Provider = &terragucciProvider{}

type terragucciProvider struct {
	version string
}

// New returns the provider factory main serves.
func New(version string) func() provider.Provider {
	return func() provider.Provider { return &terragucciProvider{version: version} }
}

type providerModel struct {
	TerragucciPath types.String `tfsdk:"terragucci_path"`
}

func (p *terragucciProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "terragucci"
	resp.Version = p.version
}

func (p *terragucciProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Reads what terragucci computes for a repo: the identities its jobs present and the trust each cloud needs, and a forge check. It writes nothing; a control repo's projects and defaults are chant workspace records, written with `terragucci control records`.",
		Attributes: map[string]schema.Attribute{
			"terragucci_path": schema.StringAttribute{
				Optional:    true,
				Description: "The terragucci command the data sources run, `terragucci config identities --json`: a path, or a command and its arguments split on spaces, such as \"npx -y @intentius/terragucci\". Default: terragucci on PATH.",
			},
		},
	}
}

func (p *terragucciProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var m providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() || m.TerragucciPath.IsUnknown() {
		return
	}
	resp.DataSourceData = &sources{command: commandOf(m.TerragucciPath.ValueString())}
}

func (p *terragucciProvider) Resources(_ context.Context) []func() resource.Resource {
	return nil
}

func (p *terragucciProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{newEnvironmentsDataSource, newTrustPolicyDataSource, newForgeCheckDataSource}
}
