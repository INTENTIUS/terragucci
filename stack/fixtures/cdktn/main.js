// A CDK Terrain app with two stacks. `npx cdktn synth` writes each one to
// cdktf.out/stacks/<stack>/cdk.tf.json, the roots the pipeline plans.
const { App, S3Backend, TerraformStack, TerraformResource, TerraformOutput } = require("cdktn");

const SIZES = { dev: 1, prod: 3 };
// A claim whose state must outlive the job sets this to its prefix in floci's
// bucket; empty, each stack keeps CDK Terrain's default local state.
const STATE = "";

class Queue extends TerraformStack {
  constructor(scope, id, size) {
    super(scope, id);
    if (STATE) new S3Backend(this, { bucket: "shop-terraform-state", key: `${STATE}/${id}.tfstate`, region: "us-east-1", usePathStyle: true });
    const cfg = new TerraformResource(this, "cfg", { terraformResourceType: "terraform_data" });
    cfg.addOverride("input", { size });
    new TerraformOutput(this, "size", { value: size });
  }
}

const app = new App();
for (const [name, size] of Object.entries(SIZES)) new Queue(app, name, size);
app.synth();
