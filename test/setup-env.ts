// The forge's job variables (GITHUB_BASE_REF on a pull request, GitLab's CI_*)
// change what terragucci reads, such as the base it checks a policy against.
// A test that needs one stubs it; none comes from the job the suite runs in.
for (const k of Object.keys(process.env)) {
  if (/^(GITHUB_|GITLAB_|CI_|FORGEJO_|GITEA_|RUNNER_|ACTIONS_)/.test(k) || k === "CI") delete process.env[k];
}

// The drift job is a chant drift Op on every forge (terragucci#1305, chant
// issue 4622): load chant's Op generators, as init does when drift is set.
import { chantOpGenerator } from "../packages/terragucci/src/chant-next";
await chantOpGenerator();
