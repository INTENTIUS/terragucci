package provider

import (
	"math/big"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

func bigInt(i int64) *big.Float { return new(big.Float).SetInt64(i) }

func TestSettingsRoundTripThroughYaml(t *testing.T) {
	policy := obj(t, map[string]attr.Value{"source": types.StringValue("git+https://github.com/acme/policy.git@v3")})
	settings := obj(t, map[string]attr.Value{
		"binary":      types.StringValue("tofu"),
		"drift":       types.StringValue("17 4 * * *"),
		"parallelism": types.NumberValue(bigInt(1)),
		"tips":        types.BoolValue(false),
		"version":     types.StringValue("1.10"),
		"roots":       roots(t, "envs/*/*", "global"),
		"policy":      policy.UnderlyingValue(),
		"gone":        types.StringNull(),
	})
	n, err := settingsNode(settings)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := renderDoc(n)
	want := "binary: tofu\ndrift: 17 4 * * *\nparallelism: 1\npolicy:\n  source: git+https://github.com/acme/policy.git@v3\nroots:\n  - envs/*/*\n  - global\ntips: false\nversion: \"1.10\"\n"
	if string(out) != want {
		t.Fatalf("yaml:\n%s\nwant:\n%s", out, want)
	}
	// Read with no prior state: the file's values come back as an HCL literal would type them.
	back, err := readSettings(n, types.DynamicNull())
	if err != nil {
		t.Fatal(err)
	}
	g1, _ := toGo(back)
	g2, _ := toGo(settings)
	if !sameSettings(g1, g2) {
		t.Fatalf("%v != %v", g1, g2)
	}
	// With the prior state saying the same, the prior value stands as it is.
	same, err := readSettings(n, settings)
	if err != nil || !same.Equal(settings) {
		t.Fatalf("%v %v", same, err)
	}
}

func TestAListTypedSettingIsTheSameAsItsTuple(t *testing.T) {
	list, _ := types.ListValue(types.StringType, []attr.Value{types.StringValue("a")})
	prior := obj(t, map[string]attr.Value{"roots": list})
	n, _ := settingsNode(prior)
	got, err := readSettings(n, prior)
	if err != nil || !got.Equal(prior) {
		t.Fatalf("%v %v", got, err)
	}
}

func TestSettingsMustBeAnObject(t *testing.T) {
	if _, err := settingsNode(types.DynamicValue(types.StringValue("tofu"))); err == nil {
		t.Fatal("a string is not settings")
	}
	n, err := settingsNode(types.DynamicNull())
	if err != nil {
		t.Fatal(err)
	}
	out, _ := renderDoc(n)
	if string(out) != "{}\n" {
		t.Fatalf("null writes {}: %q", out)
	}
}

func TestSameSettings(t *testing.T) {
	if !sameSettings(map[string]any{"a": 1}, map[string]any{"a": 1.0}) {
		t.Fatal("1 and 1.0 are one number")
	}
	if !sameSettings(nil, map[string]any{}) {
		t.Fatal("nil is {}")
	}
	if sameSettings(map[string]any{"a": "1"}, map[string]any{"a": 1}) {
		t.Fatal(`"1" is not 1`)
	}
}
