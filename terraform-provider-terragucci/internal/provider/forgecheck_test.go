package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/types"
)

// The goldens are terragucci's own `forge check --json` over recorded forge
// and cloud answers (packages/terragucci/test/forge-check.test.ts writes
// them), so the data source is held to what the core prints.

func forgeCheckGolden(t *testing.T, name string) (string, map[string]any) {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("testdata", "forge-check", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var e map[string]any
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	return p, e
}

// fakeForgeCheck is a terragucci that prints a golden, exits with the golden's exit code, and records its arguments.
func fakeForgeCheck(t *testing.T, golden string, exit int) (*sources, string) {
	t.Helper()
	dir := t.TempDir()
	args := filepath.Join(dir, "args")
	script := filepath.Join(dir, "terragucci")
	body := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$@\" > '%s'\ncat '%s'\nexit %d\n", args, golden, exit)
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return &sources{command: []string{script}}, args
}

func TestForgeCheckMatchesEachGolden(t *testing.T) {
	ctx := context.Background()
	for _, name := range []string{"github-aws", "github-aws-match"} {
		t.Run(name, func(t *testing.T) {
			path, g := forgeCheckGolden(t, name)
			exit := int(g["exit"].(float64))
			src, args := fakeForgeCheck(t, path, exit)
			ds := &forgeCheckDataSource{s: src}
			state := readSource(ctx, t, ds, &forgeCheckModel{sourceModel: sourceModel{Path: types.StringValue(localConfig(t))}, RequireClouds: types.BoolValue(true)})
			var m forgeCheckModel
			if d := state.Get(ctx, &m); d.HasError() {
				t.Fatal(d)
			}
			argv := readArgs(t, args)
			if !slices.Equal(argv[:3], []string{"forge", "check", "--json"}) || !slices.Contains(argv, "--require-clouds") {
				t.Fatalf("args %v", argv)
			}
			res := g["results"].(map[string]any)
			rows := res["rows"].([]any)
			if len(m.Rows) != len(rows) {
				t.Fatalf("%d rows, golden %d", len(m.Rows), len(rows))
			}
			for i, gr := range rows {
				gr := gr.(map[string]any)
				r := m.Rows[i]
				if r.Where != gr["where"] || r.Check != gr["check"] || r.Subject != gr["subject"] || r.Expected != gr["expected"] || r.Found != gr["found"] || r.Status != gr["status"] {
					t.Fatalf("row %d %+v, golden %v", i, r, gr)
				}
			}
			if m.OK.ValueBool() != res["ok"].(bool) || (exit == 0) != m.OK.ValueBool() {
				t.Fatalf("ok %v, golden %v, exit %d", m.OK, res["ok"], exit)
			}
			for k, v := range res["counts"].(map[string]any) {
				if m.Counts[k] != int64(v.(float64)) {
					t.Fatalf("counts %v, golden %v", m.Counts, res["counts"])
				}
			}
			repo := res["repository"].(map[string]any)
			if m.Forge.ValueString() != res["forge"] || m.Repository.ValueString() != repo["path"] || m.Host.ValueString() != repo["host"] {
				t.Fatalf("forge %s repository %s host %s", m.Forge, m.Repository, m.Host)
			}
		})
	}
}

func TestForgeCheckGoldenHoldsAMismatch(t *testing.T) {
	// A check {} block asserts on rows: the golden with exit 1 is read as rows, not as an error.
	_, g := forgeCheckGolden(t, "github-aws")
	b, _ := json.Marshal(g)
	r, _, err := parseForgeCheck(b, "", nil, "terragucci")
	if err != nil {
		t.Fatal(err)
	}
	var mismatched []string
	for _, row := range r.Rows {
		if row.Status == "mismatch" {
			mismatched = append(mismatched, row.Where+" "+row.Check+" "+row.Subject)
		}
	}
	if r.OK || !slices.Equal(mismatched, []string{"github deployment-branches dev"}) {
		t.Fatalf("ok %v mismatches %v", r.OK, mismatched)
	}
}

func TestForgeCheckRefusals(t *testing.T) {
	if _, _, err := parseForgeCheck([]byte(`{"schema":1,"command":"forge check","exit":2,"status":"usage","results":null,"error":"no terragucci config here"}`), "", nil, "terragucci"); err == nil || !strings.Contains(err.Error(), "no terragucci config here") {
		t.Fatalf("usage error: %v", err)
	}
	if _, _, err := parseForgeCheck([]byte(`{"schema":1,"command":"config identities","exit":0,"status":"ok","results":{}}`), "", nil, "terragucci"); err == nil || !strings.Contains(err.Error(), "not forge check") {
		t.Fatalf("other command: %v", err)
	}
	if _, _, err := parseForgeCheck([]byte(`{"schema":1,"command":"forge check","exit":0,"status":"ok","results":{"schema":"terragucci.forge-check/v9"}}`), "", nil, "terragucci"); err == nil || !strings.Contains(err.Error(), "v9") {
		t.Fatalf("schema: %v", err)
	}
	if _, _, err := parseForgeCheck([]byte("unknown command \"forge\""), "unknown command", nil, "terragucci"); err == nil || !strings.Contains(err.Error(), "printed no JSON envelope") {
		t.Fatalf("old binary: %v", err)
	}
}
