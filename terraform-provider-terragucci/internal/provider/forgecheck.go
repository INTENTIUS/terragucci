package provider

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// terragucci_forge_check runs `terragucci forge check --json` and passes its
// rows through: each expected forge and cloud setting, what was found and
// whether it matches. The command reads with the forge and cloud credentials
// in the environment Terraform runs in, and only reads.

// forgeCheckSchema is the result version the data source reads.
const forgeCheckSchema = "terragucci.forge-check/v1"

type forgeCheckResult struct {
	Schema     string         `json:"schema"`
	File       string         `json:"file"`
	Forge      string         `json:"forge"`
	Repository contractRepo   `json:"repository"`
	Rows       []checkRow     `json:"rows"`
	Counts     map[string]int `json:"counts"`
	OK         bool           `json:"ok"`
}

type checkRow struct {
	Where    string `json:"where" tfsdk:"where"`
	Check    string `json:"check" tfsdk:"check"`
	Subject  string `json:"subject" tfsdk:"subject"`
	Expected string `json:"expected" tfsdk:"expected"`
	Found    string `json:"found" tfsdk:"found"`
	Status   string `json:"status" tfsdk:"status"`
}

// forgeCheck runs `terragucci forge check --json` over in's config.
func (s *sources) forgeCheck(ctx context.Context, in identityInputs, requireClouds bool) (*forgeCheckResult, []byte, error) {
	var extra []string
	if requireClouds {
		extra = append(extra, "--require-clouds")
	}
	stdout, stderr, runErr, command, err := s.run(ctx, in, []string{"forge", "check"}, extra)
	if err != nil {
		return nil, nil, err
	}
	return parseForgeCheck(stdout, stderr, runErr, command)
}

// parseForgeCheck reads `forge check --json`'s envelope. Exit 1 is a check
// that found mismatches, and its rows are the result; exit 2 is a command
// that could not run.
func parseForgeCheck(stdout []byte, stderr string, runErr error, command string) (*forgeCheckResult, []byte, error) {
	e, err := readEnvelope(stdout, stderr, runErr, command, "forge check")
	if err != nil {
		return nil, nil, err
	}
	if (e.Exit != 0 && e.Exit != 1) || len(e.Results) == 0 || string(e.Results) == "null" {
		return nil, nil, fmt.Errorf("terragucci forge check: %s", e.Error)
	}
	var r forgeCheckResult
	if err := json.Unmarshal(e.Results, &r); err != nil {
		return nil, nil, fmt.Errorf("terragucci forge check: %w", err)
	}
	if r.Schema != forgeCheckSchema {
		return nil, nil, fmt.Errorf("terragucci forge check printed schema %q; the provider reads %s", r.Schema, forgeCheckSchema)
	}
	return &r, e.Results, nil
}

type forgeCheckDataSource struct{ s *sources }

func newForgeCheckDataSource() datasource.DataSource { return &forgeCheckDataSource{} }

var _ datasource.DataSourceWithConfigure = &forgeCheckDataSource{}

type forgeCheckModel struct {
	sourceModel
	RequireClouds types.Bool       `tfsdk:"require_clouds"`
	Host          types.String     `tfsdk:"host"`
	OK            types.Bool       `tfsdk:"ok"`
	Counts        map[string]int64 `tfsdk:"counts"`
	Rows          []checkRow       `tfsdk:"rows"`
	JSON          types.String     `tfsdk:"json"`
}

func (d *forgeCheckDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_forge_check"
}

func (d *forgeCheckDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	attrs := sourceAttributes()
	attrs["require_clouds"] = schema.BoolAttribute{Optional: true, Description: "Count a configured cloud left unchecked, for want of credentials, against ok."}
	attrs["host"] = computedString("The forge's host.")
	attrs["ok"] = schema.BoolAttribute{Computed: true, Description: "No row is a mismatch (with require_clouds, and no cloud row is not-checked)."}
	attrs["counts"] = schema.MapAttribute{Computed: true, ElementType: types.Int64Type, Description: "The number of rows of each status: match, mismatch, unknown and not-checked."}
	attrs["rows"] = schema.ListNestedAttribute{
		Computed:    true,
		Description: "Each expected setting, what was found, and whether it matches.",
		NestedObject: schema.NestedAttributeObject{Attributes: map[string]schema.Attribute{
			"where":    computedString("github, gitlab, forgejo, aws, gcp or azure."),
			"check":    computedString("What is checked: environment, deployment-branches, runner-group, protected-environment, protected-runners, variable, protected-branch, repository or trust."),
			"subject":  computedString("The environment, runner group, tag set, variable, branch, role, provider or app checked."),
			"expected": computedString("What the identities contract expects."),
			"found":    computedString("What the forge or cloud answered."),
			"status":   computedString("match, mismatch, unknown (it could not be read) or not-checked (no credentials for that cloud)."),
		}},
	}
	attrs["json"] = computedString("The whole result terragucci printed (results of `terragucci forge check --json`), as JSON.")
	resp.Schema = schema.Schema{
		Description: "The identities contract next to the live forge and cloud setup, from `terragucci forge check --json`. It only reads, with the credentials in Terraform's environment.",
		Attributes:  attrs,
	}
}

func (d *forgeCheckDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.s = configuredSources(req.ProviderData, &resp.Diagnostics)
}

func (d *forgeCheckDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m forgeCheckModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r, raw, err := d.s.forgeCheck(ctx, m.inputs(), m.RequireClouds.ValueBool())
	if err != nil {
		resp.Diagnostics.AddError("Cannot check the forge", err.Error())
		return
	}
	forgeCheckState(&m, r, raw)
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

// forgeCheckState fills the data source's computed attributes from the result.
func forgeCheckState(m *forgeCheckModel, r *forgeCheckResult, raw []byte) {
	m.Forge = types.StringValue(r.Forge)
	m.Repository = types.StringValue(r.Repository.Path)
	m.DefaultBranch = types.StringValue(r.Repository.DefaultBranch)
	m.ID = types.StringValue(r.Repository.Host + "/" + r.Repository.Path)
	m.Host = types.StringValue(r.Repository.Host)
	m.OK = types.BoolValue(r.OK)
	m.Counts = map[string]int64{}
	for k, v := range r.Counts {
		m.Counts[k] = int64(v)
	}
	m.Rows = r.Rows
	if m.Rows == nil {
		m.Rows = []checkRow{}
	}
	m.JSON = types.StringValue(string(raw))
}
