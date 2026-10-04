import { describe, expect, it } from "vitest";
import { diagnostics, triage, KNOWN_ERRORS } from "../src/respond/triage";

/** An error as Terraform and OpenTofu print it in CI, box and all. */
const boxed = (message: string, address: string): string =>
  [
    "╷",
    `│ Error: ${message}`,
    "│ ",
    `│   with ${address},`,
    `│   on main.tf line 12, in resource "${address.split(".").slice(-2, -1)[0]}" "${address.split(".").pop()}":`,
    `│   12: resource "${address.split(".").slice(-2, -1)[0]}" "${address.split(".").pop()}" {`,
    "│ ",
    "╵",
  ].join("\n");

// Each row is an error string as the AWS provider prints it, with the class
// and the table entry it must land on.
const CASES: Array<{ name: string; message: string; class: string; id: string; code?: string }> = [
  {
    name: "S3 AccessDenied",
    message:
      "creating S3 Bucket (shop-prod-orders-files): operation error S3: CreateBucket, https response error StatusCode: 403, RequestID: 4WQ1T2Z5GXK3B9AE, HostID: Zm9vYmFy, api error AccessDenied: Access Denied",
    class: "access-denied",
    id: "access-denied",
    code: "AccessDenied",
  },
  {
    name: "DynamoDB AccessDeniedException naming the action",
    message:
      "creating AWS DynamoDB Table (shop-prod-orders-records): operation error DynamoDB: CreateTable, https response error StatusCode: 400, RequestID: 8C2N0P6R2S4T6V8X0Z2B4D6F8H0J2L4N6P8R0T2V4X6Z8B, api error AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/terragucci-plan/ci is not authorized to perform: dynamodb:CreateTable on resource: arn:aws:dynamodb:us-east-1:123456789012:table/shop-prod-orders-records because no identity-based policy allows the dynamodb:CreateTable action",
    class: "access-denied",
    id: "access-denied",
    code: "AccessDeniedException",
  },
  {
    name: "EC2 UnauthorizedOperation",
    message:
      "creating EC2 VPC: operation error EC2: CreateVpc, https response error StatusCode: 403, RequestID: 1f7d6c5b-4a39-4e28-9d17-0c6b5a493827, api error UnauthorizedOperation: You are not authorized to perform this operation. User: arn:aws:sts::123456789012:assumed-role/ci/runner is not authorized to perform: ec2:CreateVpc on resource: arn:aws:ec2:us-east-1:123456789012:vpc/* because no identity-based policy allows the ec2:CreateVpc action. Encoded authorization failure message: 3kD9f",
    class: "access-denied",
    id: "access-denied",
    code: "UnauthorizedOperation",
  },
  {
    name: "EC2 VpcLimitExceeded",
    message:
      "creating EC2 VPC: operation error EC2: CreateVpc, https response error StatusCode: 400, RequestID: 6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d, api error VpcLimitExceeded: The maximum number of VPCs has been reached.",
    class: "quota",
    id: "quota",
    code: "VpcLimitExceeded",
  },
  {
    name: "IAM LimitExceeded",
    message:
      "attaching IAM Policy (arn:aws:iam::aws:policy/ReadOnlyAccess) to IAM Role (app): operation error IAM: AttachRolePolicy, https response error StatusCode: 409, RequestID: 0b9a8c7d-6e5f-4a3b-2c1d-0e9f8a7b6c5d, LimitExceeded: Cannot exceed quota for PoliciesPerRole: 10",
    class: "quota",
    id: "quota",
    code: "LimitExceeded",
  },
  {
    name: "S3 TooManyBuckets",
    message:
      "creating S3 Bucket (shop-prod-search-files): operation error S3: CreateBucket, https response error StatusCode: 400, RequestID: 9GH2K4M6P8R0T2V4, HostID: YmF6cXV4, api error TooManyBuckets: You have attempted to create more buckets than allowed",
    class: "quota",
    id: "quota",
    code: "TooManyBuckets",
  },
  {
    name: "IAM Throttling after retries",
    message:
      "reading IAM Role (app): operation error IAM: GetRole, exceeded maximum number of attempts, 25, https response error StatusCode: 400, RequestID: 2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f, api error Throttling: Rate exceeded",
    class: "throttling",
    id: "throttling",
    code: "Throttling",
  },
  {
    name: "CloudWatch Logs ThrottlingException",
    message:
      "creating CloudWatch Logs Log Group (/aws/lambda/worker): operation error CloudWatch Logs: CreateLogGroup, exceeded maximum number of attempts, 25, https response error StatusCode: 400, RequestID: 7e8f9a0b-1c2d-4e3f-8a9b-0c1d2e3f4a5b, api error ThrottlingException: Rate exceeded",
    class: "throttling",
    id: "throttling",
    code: "ThrottlingException",
  },
  {
    name: "EC2 RequestLimitExceeded",
    message:
      "reading EC2 Security Groups: operation error EC2: DescribeSecurityGroups, exceeded maximum number of attempts, 25, https response error StatusCode: 503, RequestID: 3d4e5f6a-7b8c-4d9e-0f1a-2b3c4d5e6f7a, api error RequestLimitExceeded: Request limit exceeded.",
    class: "throttling",
    id: "throttling",
    code: "RequestLimitExceeded",
  },
  {
    name: "IAM EntityAlreadyExists",
    message:
      "creating IAM Role (app): operation error IAM: CreateRole, https response error StatusCode: 409, RequestID: 5f6a7b8c-9d0e-4f1a-2b3c-4d5e6f7a8b9c, EntityAlreadyExists: Role with name app already exists.",
    class: "already-exists",
    id: "already-exists",
    code: "EntityAlreadyExists",
  },
  {
    name: "CloudWatch Logs ResourceAlreadyExistsException",
    message:
      "creating CloudWatch Logs Log Group (/aws/lambda/worker): operation error CloudWatch Logs: CreateLogGroup, https response error StatusCode: 400, RequestID: 8b9c0d1e-2f3a-4b4c-5d6e-7f8a9b0c1d2e, ResourceAlreadyExistsException: The specified log group already exists",
    class: "already-exists",
    id: "already-exists",
    code: "ResourceAlreadyExistsException",
  },
  {
    name: "S3 BucketAlreadyOwnedByYou",
    message:
      "creating S3 Bucket (shop-terraform-state): operation error S3: CreateBucket, https response error StatusCode: 409, RequestID: K8M0P2R4T6V8X0Z2, HostID: cXV1eGZvbw==, BucketAlreadyOwnedByYou: Your previous request to create the named bucket succeeded and you already own it.",
    class: "already-exists",
    id: "already-exists",
    code: "BucketAlreadyOwnedByYou",
  },
  {
    name: "DynamoDB ResourceInUseException on create",
    message:
      "creating AWS DynamoDB Table (shop-dev-orders-records): operation error DynamoDB: CreateTable, https response error StatusCode: 400, RequestID: Q4S6U8W0Y2A4C6E8G0I2K4M6O8Q0S2U4W6Y8A0C2E4G6I8, ResourceInUseException: Table already exists: shop-dev-orders-records",
    class: "already-exists",
    id: "already-exists",
    code: "ResourceInUseException",
  },
  {
    name: "EC2 InvalidGroup.Duplicate",
    message:
      "creating Security Group (web): operation error EC2: CreateSecurityGroup, https response error StatusCode: 400, RequestID: 4a5b6c7d-8e9f-4a0b-1c2d-3e4f5a6b7c8d, api error InvalidGroup.Duplicate: The security group 'web' already exists for VPC 'vpc-0a1b2c3d4e5f60718'",
    class: "already-exists",
    id: "already-exists",
    code: "InvalidGroup.Duplicate",
  },
  {
    name: "SQS QueueAlreadyExists",
    message:
      "creating SQS Queue (shop-dev-orders-jobs): operation error SQS: CreateQueue, https response error StatusCode: 400, RequestID: 6c7d8e9f-0a1b-5c2d-3e4f-5a6b7c8d9e0f, QueueAlreadyExists: A queue already exists with the same name and a different value for attribute VisibilityTimeout",
    class: "already-exists",
    id: "already-exists",
    code: "QueueAlreadyExists",
  },
  {
    name: "S3 BucketAlreadyExists, another account's name",
    message:
      "creating S3 Bucket (assets): operation error S3: CreateBucket, https response error StatusCode: 409, RequestID: N1P3R5T7V9X1Z3B5, HostID: YmFyYmF6, BucketAlreadyExists: The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.",
    class: "already-exists",
    id: "bucket-name-taken",
    code: "BucketAlreadyExists",
  },
  {
    name: "EC2 DependencyViolation on a security group",
    message:
      "deleting Security Group (sg-0123456789abcdef0): operation error EC2: DeleteSecurityGroup, https response error StatusCode: 400, RequestID: 0e1f2a3b-4c5d-4e6f-7a8b-9c0d1e2f3a4b, api error DependencyViolation: resource sg-0123456789abcdef0 has a dependent object",
    class: "dependency",
    id: "dependency",
    code: "DependencyViolation",
  },
  {
    name: "EC2 DependencyViolation on a subnet",
    message:
      "deleting EC2 Subnet (subnet-0a1b2c3d4e5f60718): operation error EC2: DeleteSubnet, https response error StatusCode: 400, RequestID: 2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e, api error DependencyViolation: The subnet 'subnet-0a1b2c3d4e5f60718' has dependencies and cannot be deleted.",
    class: "dependency",
    id: "dependency",
    code: "DependencyViolation",
  },
  {
    name: "IAM DeleteConflict",
    message:
      "deleting IAM Role (app): operation error IAM: DeleteRole, https response error StatusCode: 409, RequestID: 9f0a1b2c-3d4e-4f5a-6b7c-8d9e0f1a2b3c, DeleteConflict: Cannot delete entity, must detach all policies first.",
    class: "dependency",
    id: "dependency",
    code: "DeleteConflict",
  },
  {
    name: "S3 BucketNotEmpty",
    message:
      "deleting S3 Bucket (shop-dev-orders-files): operation error S3: DeleteBucket, https response error StatusCode: 409, RequestID: B2D4F6H8J0L2N4P6, HostID: Zm9vYmF6, api error BucketNotEmpty: The bucket you tried to delete is not empty",
    class: "dependency",
    id: "bucket-not-empty",
    code: "BucketNotEmpty",
  },
];

describe("apply-failed triage: the known-error table", () => {
  for (const c of CASES) {
    it(`${c.name} is ${c.class}`, () => {
      const t = triage(boxed(c.message, "module.service.aws_thing.main"));
      expect(t.unknown).toEqual([]);
      expect(t.known).toHaveLength(1);
      expect(t.known[0]).toMatchObject({ class: c.class, id: c.id, address: "module.service.aws_thing.main", ...(c.code ? { code: c.code } : {}) });
      expect(t.known[0]!.fix.length).toBeGreaterThan(20);
    });
  }

  it("a state lock held by another run is state-lock, with its lock id", () => {
    const log = [
      "╷",
      "│ Error: Error acquiring the state lock",
      "│ ",
      "│ Error message: operation error S3: PutObject, https response error StatusCode: 412, RequestID: 9VQ6S8E0W2Y4A6C8, HostID: c3RhdGU=, api error PreconditionFailed: At least one of the pre-conditions you specified did not hold",
      "│ Lock Info:",
      "│   ID:        6f0c3a9e-2b1d-4c8e-9a7f-5d3e1b0c2a4f",
      "│   Path:      shop-terraform-state/envs/prod/orders.tfstate.tflock",
      "│   Operation: OperationTypeApply",
      "│   Who:       runner@forgejo-runner",
      "│ ",
      "│ Terraform acquires a state lock to protect the state from being written",
      "│ by multiple users at the same time.",
      "╵",
    ].join("\n");
    const t = triage(log);
    expect(t.known).toHaveLength(1);
    expect(t.known[0]).toMatchObject({ class: "state-lock", id: "state-lock" });
    expect(t.known[0]!.fix).toContain("force-unlock");
  });

  it("names the permission a denied call needed", () => {
    const t = triage(boxed(CASES[1]!.message, "aws_dynamodb_table.records"));
    expect(t.known[0]!.action).toBe("dynamodb:CreateTable");
  });

  it("leaves an error the table does not know for a person or an agent", () => {
    const t = triage(
      boxed(
        "creating Lambda Function (worker): operation error Lambda: CreateFunction, https response error StatusCode: 400, RequestID: 1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d, InvalidParameterValueException: The role defined for the function cannot be assumed by Lambda.",
        "aws_lambda_function.worker",
      ),
    );
    expect(t.known).toEqual([]);
    expect(t.unknown).toMatchObject([{ address: "aws_lambda_function.worker", code: "InvalidParameterValueException" }]);
  });

  it("reads several errors from one log, plain or boxed", () => {
    const log = [
      "aws_iam_role.app: Creating...",
      "Error: " + CASES[9]!.message,
      "",
      "  with aws_iam_role.app,",
      '  on main.tf line 3, in resource "aws_iam_role" "app":',
      "",
      boxed(CASES[16]!.message, "aws_security_group.web"),
    ].join("\n");
    expect(diagnostics(log).map((d) => d.address)).toEqual(["aws_iam_role.app", "aws_security_group.web"]);
    expect(triage(log).known.map((k) => k.class)).toEqual(["already-exists", "dependency"]);
  });

  it("every table entry is reached by a case above", () => {
    const ids = new Set([...CASES.map((c) => c.id), "state-lock"]);
    expect(KNOWN_ERRORS.map((k) => k.id).filter((id) => !ids.has(id))).toEqual([]);
  });
});
