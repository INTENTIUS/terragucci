package provider

import (
	"context"
	"fmt"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"
	"gopkg.in/yaml.v3"
)

// entry is where one resource's settings live in the file.
type entry struct {
	// noun names the resource in commit messages and errors.
	noun   string
	get    func(root *yaml.Node, key string) *yaml.Node
	set    func(root *yaml.Node, key string, v *yaml.Node) error
	remove func(root *yaml.Node, key string) bool
	// importHint is how to adopt an entry the file already has.
	importHint func(key string) string
}

var projectEntry = entry{
	noun: "terragucci_project",
	get:  projectSettings,
	set:  setProject,
	remove: func(root *yaml.Node, key string) bool {
		return dropProject(root, key)
	},
	importHint: func(key string) string {
		return fmt.Sprintf("projects.%s is already in the file; import it: terraform import terragucci_project.<name> %s", key, key)
	},
}

var defaultsEntry = entry{
	noun: "terragucci_defaults",
	get:  func(root *yaml.Node, _ string) *yaml.Node { return lookup(root, "defaults") },
	set: func(root *yaml.Node, _ string, v *yaml.Node) error {
		setDefaults(root, v)
		return nil
	},
	remove: func(root *yaml.Node, _ string) bool { return drop(root, "defaults") },
	importHint: func(string) string {
		return "defaults is already in the file; import it: terraform import terragucci_defaults.<name> defaults"
	},
}

// settingsNode turns the configured settings into the YAML the file holds. Null is {}.
func settingsNode(v types.Dynamic) (*yaml.Node, error) {
	g, err := toGo(v)
	if err != nil {
		return nil, err
	}
	if g == nil {
		g = map[string]any{}
	}
	if _, ok := g.(map[string]any); !ok {
		return nil, fmt.Errorf("settings must be an object of terragucci.yml keys")
	}
	return encodeValue(g)
}

// readSettings is the file's settings as state: the prior value when it says
// the same thing, so a list written as a tuple does not show as a change.
func readSettings(n *yaml.Node, prior types.Dynamic) (types.Dynamic, error) {
	g, err := decodeValue(n)
	if err != nil {
		return prior, err
	}
	if g != nil {
		if _, ok := g.(map[string]any); !ok {
			return prior, fmt.Errorf("the settings in the file are not a mapping")
		}
	}
	if !prior.IsUnknown() {
		if p, perr := toGo(prior); perr == nil && sameSettings(p, g) {
			return prior, nil
		}
	}
	if isEmpty(g) {
		g = map[string]any{}
	}
	v, err := fromGo(g)
	if err != nil {
		return prior, err
	}
	return types.DynamicValue(v), nil
}

// settingsIsObject checks a configured settings value is an object or a map.
type settingsIsObject struct{}

func (settingsIsObject) Description(context.Context) string {
	return "settings is an object of terragucci.yml keys"
}
func (s settingsIsObject) MarkdownDescription(ctx context.Context) string { return s.Description(ctx) }
func (settingsIsObject) ValidateDynamic(_ context.Context, req validator.DynamicRequest, resp *validator.DynamicResponse) {
	v := req.ConfigValue
	if v.IsNull() || v.IsUnknown() || v.IsUnderlyingValueUnknown() || v.IsUnderlyingValueNull() {
		return
	}
	switch v.UnderlyingValue().(type) {
	case basetypes.ObjectValue, basetypes.MapValue:
		return
	}
	resp.Diagnostics.AddAttributeError(req.Path, "settings is not an object", "settings takes an object of terragucci.yml keys, such as { binary = \"tofu\" }")
}

func settingsAttribute(desc string, required bool) schema.DynamicAttribute {
	return schema.DynamicAttribute{
		Required:    required,
		Optional:    !required,
		Description: desc,
		Validators:  []validator.Dynamic{settingsIsObject{}},
	}
}

func configured(req any, resp *diag.Diagnostics) *control {
	if req == nil {
		return nil
	}
	c, ok := req.(*control)
	if !ok {
		resp.AddError("Unexpected provider data", fmt.Sprintf("got %T", req))
		return nil
	}
	return c
}

// ── terragucci_project ──────────────────────────────────────────────────────

var projectKey = regexp.MustCompile(`^[^/\s]+(/[^/\s]+)+$`)

type projectResource struct{ c *control }

type projectModel struct {
	ID       types.String  `tfsdk:"id"`
	Key      types.String  `tfsdk:"key"`
	Settings types.Dynamic `tfsdk:"settings"`
}

func newProjectResource() resource.Resource { return &projectResource{} }

var (
	_ resource.ResourceWithConfigure   = &projectResource{}
	_ resource.ResourceWithImportState = &projectResource{}
)

func (r *projectResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_project"
}

func (r *projectResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "One project of the control repo: projects.<key> in terragucci.yml.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"key": schema.StringAttribute{
				Required:      true,
				Description:   "The project's address on its forge, <host>/<path>, such as github.com/acme/infra.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
				Validators:    []validator.String{keyValidator{}},
			},
			"settings": settingsAttribute("The project's own terragucci.yml keys, which override defaults. Unset writes {}.", false),
		},
	}
}

type keyValidator struct{}

func (keyValidator) Description(context.Context) string { return "a <host>/<path> project key" }
func (k keyValidator) MarkdownDescription(ctx context.Context) string {
	return k.Description(ctx)
}
func (keyValidator) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	if !projectKey.MatchString(req.ConfigValue.ValueString()) {
		resp.Diagnostics.AddAttributeError(req.Path, "Not a project key", "key is <host>/<path>, such as github.com/acme/infra; got "+req.ConfigValue.ValueString())
	}
}

func (r *projectResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.c = configured(req.ProviderData, &resp.Diagnostics)
}

func (r *projectResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var m projectModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	key := m.Key.ValueString()
	if err := create(ctx, r.c, projectEntry, key, m.Settings); err != nil {
		resp.Diagnostics.AddError("Cannot write the project", err.Error())
		return
	}
	m.ID = types.StringValue(key)
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

func (r *projectResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var m projectModel
	resp.Diagnostics.Append(req.State.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	settings, found, err := read(ctx, r.c, projectEntry, m.Key.ValueString(), m.Settings)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the project", err.Error())
		return
	}
	if !found {
		resp.State.RemoveResource(ctx)
		return
	}
	m.Settings = settings
	m.ID = m.Key
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

func (r *projectResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var m projectModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := update(ctx, r.c, projectEntry, m.Key.ValueString(), m.Settings); err != nil {
		resp.Diagnostics.AddError("Cannot write the project", err.Error())
		return
	}
	m.ID = m.Key
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

func (r *projectResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var m projectModel
	resp.Diagnostics.Append(req.State.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := remove(ctx, r.c, projectEntry, m.Key.ValueString()); err != nil {
		resp.Diagnostics.AddError("Cannot remove the project", err.Error())
	}
}

func (r *projectResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("key"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("settings"), types.DynamicNull())...)
}

// ── terragucci_defaults ─────────────────────────────────────────────────────

type defaultsResource struct{ c *control }

type defaultsModel struct {
	ID       types.String  `tfsdk:"id"`
	Settings types.Dynamic `tfsdk:"settings"`
}

func newDefaultsResource() resource.Resource { return &defaultsResource{} }

var (
	_ resource.ResourceWithConfigure   = &defaultsResource{}
	_ resource.ResourceWithImportState = &defaultsResource{}
)

func (r *defaultsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_defaults"
}

func (r *defaultsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The control repo's defaults: the terragucci.yml keys every project gets unless it sets its own. One per control repo.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"settings": settingsAttribute("The defaults' terragucci.yml keys.", true),
		},
	}
}

func (r *defaultsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.c = configured(req.ProviderData, &resp.Diagnostics)
}

func (r *defaultsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var m defaultsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := create(ctx, r.c, defaultsEntry, "", m.Settings); err != nil {
		resp.Diagnostics.AddError("Cannot write the defaults", err.Error())
		return
	}
	m.ID = types.StringValue("defaults")
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

func (r *defaultsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var m defaultsModel
	resp.Diagnostics.Append(req.State.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	settings, found, err := read(ctx, r.c, defaultsEntry, "", m.Settings)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the defaults", err.Error())
		return
	}
	if !found {
		resp.State.RemoveResource(ctx)
		return
	}
	m.Settings = settings
	m.ID = types.StringValue("defaults")
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

func (r *defaultsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var m defaultsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := update(ctx, r.c, defaultsEntry, "", m.Settings); err != nil {
		resp.Diagnostics.AddError("Cannot write the defaults", err.Error())
		return
	}
	m.ID = types.StringValue("defaults")
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

func (r *defaultsResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	if err := remove(ctx, r.c, defaultsEntry, ""); err != nil {
		resp.Diagnostics.AddError("Cannot remove the defaults", err.Error())
	}
}

func (r *defaultsResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), "defaults")...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("settings"), types.DynamicNull())...)
}

// ── the edits both resources make ───────────────────────────────────────────

func label(e entry, key string) string {
	if key == "" {
		return e.noun
	}
	return e.noun + " " + key
}

func create(ctx context.Context, c *control, e entry, key string, settings types.Dynamic) error {
	n, err := settingsNode(settings)
	if err != nil {
		return err
	}
	return c.edit(ctx, "terraform: add "+label(e, key), func(root *yaml.Node) (bool, error) {
		if e.get(root, key) != nil {
			return false, fmt.Errorf("%s", e.importHint(key))
		}
		return true, e.set(root, key, n)
	})
}

func update(ctx context.Context, c *control, e entry, key string, settings types.Dynamic) error {
	n, err := settingsNode(settings)
	if err != nil {
		return err
	}
	want, _ := decodeValue(n)
	return c.edit(ctx, "terraform: update "+label(e, key), func(root *yaml.Node) (bool, error) {
		if cur := e.get(root, key); cur != nil {
			if have, err := decodeValue(cur); err == nil && sameSettings(have, want) {
				return false, nil
			}
		}
		return true, e.set(root, key, n)
	})
}

func remove(ctx context.Context, c *control, e entry, key string) error {
	return c.edit(ctx, "terraform: remove "+label(e, key), func(root *yaml.Node) (bool, error) {
		return e.remove(root, key), nil
	})
}

func read(ctx context.Context, c *control, e entry, key string, prior types.Dynamic) (types.Dynamic, bool, error) {
	root, _, err := c.load(ctx)
	if err != nil {
		return prior, false, err
	}
	n := e.get(root, key)
	if n == nil {
		return prior, false, nil
	}
	v, err := readSettings(n, prior)
	return v, true, err
}
