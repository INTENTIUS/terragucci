package provider

import (
	"context"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
)

func TestTheProviderHasDataSourcesOnly(t *testing.T) {
	p := New("test")()
	if r := p.Resources(context.Background()); len(r) != 0 {
		t.Fatalf("%d resources: the control repo's projects and defaults are workspace records now", len(r))
	}
	if d := p.DataSources(context.Background()); len(d) != 3 {
		t.Fatalf("%d data sources", len(d))
	}
}

func TestADataSourceWithNoPathSaysSo(t *testing.T) {
	ctx := context.Background()
	src := &sources{command: []string{"terragucci"}}
	ds := &environmentsDataSource{}
	var cresp datasource.ConfigureResponse
	ds.Configure(ctx, datasource.ConfigureRequest{ProviderData: src}, &cresp)
	if cresp.Diagnostics.HasError() {
		t.Fatal(cresp.Diagnostics)
	}
	if _, _, err := src.identities(ctx, identityInputs{}); err == nil || !strings.Contains(err.Error(), "set path") {
		t.Fatalf("no path: %v", err)
	}
}

func TestADataSourceWithAPathRuns(t *testing.T) {
	ctx := context.Background()
	_, _ = ctx, t
	src, _ := fakeTerragucci(t, goldenPath(t, "github-aws"))
	if _, _, err := src.identities(ctx, identityInputs{path: localConfig(t)}); err != nil {
		t.Fatal(err)
	}
}
