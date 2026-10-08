// A CDK Terrain app with two stacks. `npx cdktn synth` writes each one to
// cdktf.out/stacks/<stack>/cdk.tf.json, the roots the pipeline plans.
const { App, TerraformStack, TerraformResource, TerraformOutput } = require("cdktn");

const SIZES = { dev: 1, prod: 3 };

class Queue extends TerraformStack {
  constructor(scope, id, size) {
    super(scope, id);
    const cfg = new TerraformResource(this, "cfg", { terraformResourceType: "terraform_data" });
    cfg.addOverride("input", { size });
    new TerraformOutput(this, "size", { value: size });
  }
}

const app = new App();
for (const [name, size] of Object.entries(SIZES)) new Queue(app, name, size);
app.synth();
