// Loads a Prow job config with Prow's own strict loader (what checkconfig
// --strict runs) and turns each job into the ProwJob Prow would create for
// it, printed as JSON lines on stdout. The Prow job tests run it
// (packages/terragucci/test/prow.test.ts).
//
//	go run . <prow config.yaml> <job config.yaml>
package main

import (
	"encoding/json"
	"fmt"
	"os"

	prowapi "sigs.k8s.io/prow/pkg/apis/prowjobs/v1"
	"sigs.k8s.io/prow/pkg/config"
	"sigs.k8s.io/prow/pkg/pjutil"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: go run . <prow config.yaml> <job config.yaml>")
		os.Exit(2)
	}
	c, err := config.LoadStrict(os.Args[1], []string{os.Args[2]}, nil, "")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var jobs []prowapi.ProwJob
	for repo, ps := range c.PresubmitsStatic {
		org, name := split(repo)
		for _, p := range ps {
			refs := prowapi.Refs{Org: org, Repo: name, BaseRef: "main", BaseSHA: "0000000000000000000000000000000000000001", Pulls: []prowapi.Pull{{Number: 1, Author: "someone", SHA: "0000000000000000000000000000000000000002"}}}
			jobs = append(jobs, pjutil.NewProwJob(pjutil.PresubmitSpec(p, refs), p.Labels, p.Annotations))
		}
	}
	for repo, ps := range c.PostsubmitsStatic {
		org, name := split(repo)
		for _, p := range ps {
			refs := prowapi.Refs{Org: org, Repo: name, BaseRef: "main", BaseSHA: "0000000000000000000000000000000000000001"}
			jobs = append(jobs, pjutil.NewProwJob(pjutil.PostsubmitSpec(p, refs), p.Labels, p.Annotations))
		}
	}
	for _, p := range c.Periodics {
		jobs = append(jobs, pjutil.NewProwJob(pjutil.PeriodicSpec(p), p.Labels, p.Annotations))
	}
	enc := json.NewEncoder(os.Stdout)
	for _, j := range jobs {
		j.Namespace = c.ProwJobNamespace
		if err := enc.Encode(j); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}

func split(repo string) (string, string) {
	for i := 0; i < len(repo); i++ {
		if repo[i] == '/' {
			return repo[:i], repo[i+1:]
		}
	}
	return repo, ""
}
