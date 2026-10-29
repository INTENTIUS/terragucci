// The fixture module registry for Terraform (the templates profile): Terraform
// reads a module download's location only from the X-Terraform-Get header,
// which a file Forgejo serves cannot send. This server, on the stack's
// network as template-registry:8080, answers the module registry protocol
// from a scenario repo's own files on the local Forgejo:
//
//   GET /<owner>/<repo>/v1/modules/<ns>/<name>/<system>/versions
//       the repo's registry/v1/modules/.../versions, as it is
//   GET /<owner>/<repo>/v1/modules/<ns>/<name>/<system>/<version>/download
//       204, with X-Terraform-Get set to the location the repo's download
//       file holds (OpenTofu reads the same file's JSON body directly)
//
// A scenario's CLI config (registry/terraformrc, from
// stack/harness/fixtures/templates) points modules.harness.local's modules.v1
// at http://template-registry:8080/<owner>/<repo>/v1/modules/. Nothing it
// reads or answers leaves the stack.
import http from "node:http";

const FORGE = process.env.FORGE || "http://forgejo:3000";
const PORT = Number(process.env.PORT || 8080);

http
  .createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const m = /^\/([^/]+)\/([^/]+)\/v1\/modules\/(.+)$/.exec(path);
    if (req.method !== "GET" || !m) {
      res.writeHead(404).end();
      return;
    }
    const [, owner, repo, rest] = m;
    try {
      const up = await fetch(`${FORGE}/${owner}/${repo}/raw/branch/main/registry/v1/modules/${rest}`);
      const body = await up.text();
      if (!up.ok) {
        console.error(`template-registry: GET ${path} ${up.status}`);
        res.writeHead(up.status).end(body);
        return;
      }
      if (rest.endsWith("/download")) {
        const location = JSON.parse(body).location;
        console.error(`template-registry: GET ${path} 204 ${location}`);
        res.writeHead(204, { "X-Terraform-Get": location }).end();
        return;
      }
      console.error(`template-registry: GET ${path} 200`);
      res.writeHead(200, { "content-type": "application/json" }).end(body);
    } catch (e) {
      console.error(`template-registry: GET ${path} 502 ${e.message}`);
      res.writeHead(502).end(String(e.message));
    }
  })
  .listen(PORT, () => console.error(`template-registry: serving ${FORGE}'s registry files on :${PORT}`));
