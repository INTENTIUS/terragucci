package provider

import (
	"context"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

func TestWithoutForgeAndRepositoryTheResourcesRefuseAndPathStillWorks(t *testing.T) {
	ctx := context.Background()
	for _, m := range []providerModel{
		{},
		{Forge: types.StringValue("github")},
		{Repository: types.StringValue("acme/control")},
	} {
		data, src, diags := configureData(m)
		if diags.HasError() {
			t.Fatal(diags)
		}
		if src == nil || src.control != nil {
			t.Fatalf("sources %+v", src)
		}
		for _, r := range []resource.Resource{newProjectResource(), newDefaultsResource()} {
			var resp resource.ConfigureResponse
			r.(resource.ResourceWithConfigure).Configure(ctx, resource.ConfigureRequest{ProviderData: data}, &resp)
			if !resp.Diagnostics.HasError() {
				t.Fatalf("%T configured with no control repo", r)
			}
			text := ""
			for _, d := range resp.Diagnostics {
				text += d.Summary() + " " + d.Detail() + "\n"
			}
			for _, a := range data.(*noControl).missing {
				if !strings.Contains(text, "Missing provider attribute "+a) {
					t.Fatalf("diagnostics do not name %s:\n%s", a, text)
				}
			}
		}
	}

	// A data source with path runs without them.
	_, src, _ := configureData(providerModel{})
	fake, _ := fakeTerragucci(t, goldenPath(t, "github-aws"))
	src.command = fake.command
	ds := &environmentsDataSource{}
	var cresp datasource.ConfigureResponse
	ds.Configure(ctx, datasource.ConfigureRequest{ProviderData: src}, &cresp)
	if cresp.Diagnostics.HasError() {
		t.Fatal(cresp.Diagnostics)
	}
	state := readSource(ctx, t, ds, &environmentsModel{sourceModel: sourceModel{Path: types.StringValue(localConfig(t))}})
	var m environmentsModel
	if d := state.Get(ctx, &m); d.HasError() || m.Environments["prod"].Apply.Subject != "repo:acme/infra:environment:production" {
		t.Fatalf("%v %+v", d, m.Environments["prod"].Apply)
	}
	// Without path, it says what is missing.
	if _, _, err := src.identities(ctx, identityInputs{}); err == nil || !strings.Contains(err.Error(), "forge and repository") {
		t.Fatalf("no path: %v", err)
	}
}

func TestWithForgeAndRepositoryTheResourcesGetTheControlRepo(t *testing.T) {
	data, src, diags := configureData(providerModel{Forge: types.StringValue("gitlab"), Repository: types.StringValue("acme/control")})
	if diags.HasError() {
		t.Fatal(diags)
	}
	c, ok := data.(*control)
	if !ok || src.control != c || c.forge.api != "https://gitlab.com/api/v4" || c.path != DefaultPath {
		t.Fatalf("%+v %+v", data, src)
	}
	var resp resource.ConfigureResponse
	r := newProjectResource().(*projectResource)
	r.Configure(context.Background(), resource.ConfigureRequest{ProviderData: data}, &resp)
	if resp.Diagnostics.HasError() || r.c != c {
		t.Fatalf("%v", resp.Diagnostics)
	}
	if _, _, diags := configureData(providerModel{Forge: types.StringValue("svn"), Repository: types.StringValue("acme/control")}); !diags.HasError() {
		t.Fatal("an unknown forge configured")
	}
}
