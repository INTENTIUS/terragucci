// Command terraform-provider-terragucci serves the terragucci provider to
// Terraform and OpenTofu.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/intentius/terragucci/terraform-provider-terragucci/internal/provider"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run with support for debuggers such as delve")
	flag.Parse()
	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/intentius/terragucci",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err)
	}
}
