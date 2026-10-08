/**
 * The reports front door: an optional CloudFormation stack, in the customer's
 * own AWS account, that serves the private reports bucket to people who sign
 * in with the company's identity provider.
 *
 *   CloudFront, with Origin Access Control: the bucket stays private and
 *     answers only this distribution (the bucket policy statement below).
 *   A Lambda@Edge function on every viewer request (front-door/edge.cjs):
 *     OpenID Connect sign-in, then a signed session cookie.
 *   A TLS certificate (ACM, DNS-validated in the hosted zone, or one given)
 *     and the DNS name (Route 53 alias records, when a hosted zone is given).
 *
 * `reports.url` in terragucci.yml is then https://<domain>, so every note,
 * report and dashboard links there.
 *
 * `ReportsFrontDoor` is the composite; front-door/stack.ts declares it over
 * template parameters, and `just ci` renders that to the template the site
 * offers (docs-site/public/reports-front-door.json). Lambda@Edge and the
 * certificate CloudFront uses both live in us-east-1, so the stack deploys
 * there whatever region the bucket is in.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { Composite, type Value } from "@intentius/chant";
import {
  AccountId,
  AcmCertificate,
  CfDistribution,
  Condition,
  Equals,
  Function,
  If,
  Join,
  Not,
  OriginAccessControl,
  Partition,
  RecordSet,
  Role,
  S3BucketPolicy,
  Secret,
  Version,
} from "@intentius/chant-lexicon-aws";

// Parameters cannot sit inside Fn::Sub in chant, so strings that hold one are joined.
const cat = (...parts: unknown[]) => Join("", parts);

/** The edge function's source, minified the same way every build. CloudFormation caps inline code at 4096 bytes. */
export const EDGE_SOURCE = readFileSync(new URL("./edge.cjs", import.meta.url), "utf8");
export const EDGE_CODE = transformSync(EDGE_SOURCE, { minify: true, loader: "js", format: "cjs", target: "node22", legalComments: "none" }).code;
export const EDGE_CODE_LIMIT = 4096;

/** CloudFront's managed CachingDisabled policy: a report or index is read from the bucket on every request. */
// chant-disable-next-line GHA020 -- a policy id AWS publishes, not a key
export const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
/** The hosted zone every CloudFront alias record targets. */
export const CLOUDFRONT_ZONE = "Z2FDTNDATAQYW2";

export interface ReportsFrontDoorProps {
  /** Names the function, its role's session and the settings secret. */
  name: Value<string>;
  /** The reports bucket's name, as in reports.bucket without s3://. */
  bucket: Value<string>;
  bucketRegion: Value<string>;
  /** The DNS name people open, such as reports.acme.example. */
  domain: Value<string>;
  /** An ACM certificate in us-east-1 for the domain; "" requests one, validated in hostedZoneId. */
  certificateArn: Value<string>;
  /** The Route 53 zone of the domain; "" writes no DNS record. */
  hostedZoneId: Value<string>;
  /** The OpenID Connect issuer, such as https://accounts.google.com. */
  issuer: Value<string>;
  clientId: Value<string>;
  /** A Secrets Manager secret in us-east-1 whose string is the client secret. */
  clientSecretName: Value<string>;
  /** Only email addresses at this domain sign in; "" lets in anyone the issuer signs in. */
  allowedDomain: Value<string>;
  sessionHours: Value<string>;
  /** "true" writes the bucket's policy; "false" leaves it to you (the BucketPolicyStatement output). */
  bucketPolicy: Value<string>;
}

/** The ARN the bucket policy admits: the distribution's, through its Origin Access Control. */
export const distributionArn = (id: unknown) => cat("arn:", Partition, ":cloudfront::", AccountId, ":distribution/", id);

type Of<T extends abstract new (...args: never) => unknown> = InstanceType<T>;
export type ReportsFrontDoorResult = {
  createCertificate: Condition; writeDns: Condition; writeBucketPolicy: Condition;
  settings: Of<typeof Secret>; role: Of<typeof Role>; edge: Of<typeof Function>; edgeVersion: Of<typeof Version>;
  access: Of<typeof OriginAccessControl>; certificate: Of<typeof AcmCertificate>; distribution: Of<typeof CfDistribution>;
  dnsA: Of<typeof RecordSet>; dnsAAAA: Of<typeof RecordSet>; bucketPolicy: Of<typeof S3BucketPolicy>;
};

export const ReportsFrontDoor = Composite<ReportsFrontDoorProps, ReportsFrontDoorResult>((props) => {
  const createCertificate = new Condition(Equals(props.certificateArn, ""));
  const writeDns = new Condition(Not(Equals(props.hostedZoneId, "")));
  const writeBucketPolicy = new Condition(Equals(props.bucketPolicy, "true"));

  // The settings the edge function reads, with a session key generated into it.
  const settings = new Secret({
    Name: props.name,
    Description: "Settings and session key of the terragucci reports front door",
    GenerateSecretString: {
      SecretStringTemplate: cat(
        '{"issuer":"', props.issuer, '","clientId":"', props.clientId, '","clientSecretName":"', props.clientSecretName,
        '","domain":"', props.domain, '","allowedDomain":"', props.allowedDomain, '","sessionHours":"', props.sessionHours, '"}',
      ),
      GenerateStringKey: "sessionKey",
      PasswordLength: 64,
      ExcludePunctuation: true,
    },
  });

  const role = new Role({
    AssumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"] }, Action: "sts:AssumeRole" }],
    },
    ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
    Policies: [{
      PolicyName: "read-settings",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: "secretsmanager:GetSecretValue",
          Resource: [settings, cat("arn:", Partition, ":secretsmanager:us-east-1:", AccountId, ":secret:", props.clientSecretName, "-*")],
        }],
      },
    }],
  });

  const edge = new Function({
    FunctionName: props.name,
    Description: "terragucci reports front door: OpenID Connect sign-in on every viewer request",
    Runtime: "nodejs22.x",
    Handler: "index.handler",
    Code: { ZipFile: EDGE_CODE },
    MemorySize: 128,
    Timeout: 5,
    Role: role.Arn,
  });

  // A version is immutable, so the code's digest in its description publishes a new one when the code changes.
  const edgeVersion = new Version({
    FunctionName: edge.Arn,
    Description: `edge code sha256 ${createHash("sha256").update(EDGE_CODE).digest("hex").slice(0, 16)}`,
  });

  const access = new OriginAccessControl({
    OriginAccessControlConfig: {
      Name: props.name,
      Description: "The reports bucket answers only this distribution",
      OriginAccessControlOriginType: "s3",
      SigningBehavior: "always",
      SigningProtocol: "sigv4",
    },
  });

  const certificate = new AcmCertificate({
    DomainName: props.domain,
    ValidationMethod: "DNS",
    DomainValidationOptions: [{ DomainName: props.domain, HostedZoneId: props.hostedZoneId }],
  }, { Condition: createCertificate });

  const distribution = new CfDistribution({
    DistributionConfig: {
      Enabled: true,
      Comment: "terragucci reports",
      Aliases: [props.domain],
      DefaultRootObject: "index.html",
      HttpVersion: "http2and3",
      PriceClass: "PriceClass_100",
      Origins: [{
        Id: "reports",
        DomainName: cat(props.bucket, ".s3.", props.bucketRegion, ".amazonaws.com"),
        OriginAccessControlId: access.Id,
        S3OriginConfig: { OriginAccessIdentity: "" },
      }],
      DefaultCacheBehavior: {
        TargetOriginId: "reports",
        ViewerProtocolPolicy: "redirect-to-https",
        AllowedMethods: ["GET", "HEAD"],
        CachedMethods: ["GET", "HEAD"],
        CachePolicyId: CACHING_DISABLED,
        Compress: true,
        LambdaFunctionAssociations: [{ EventType: "viewer-request", LambdaFunctionARN: edgeVersion }],
      },
      ViewerCertificate: {
        AcmCertificateArn: If(createCertificate, certificate, props.certificateArn),
        SslSupportMethod: "sni-only",
        MinimumProtocolVersion: "TLSv1.2_2021",
      },
    },
  });

  const alias = { DNSName: distribution.DomainName, HostedZoneId: CLOUDFRONT_ZONE, EvaluateTargetHealth: false };
  const dnsA = new RecordSet({ HostedZoneId: props.hostedZoneId, Name: props.domain, Type: "A", AliasTarget: alias }, { Condition: writeDns });
  const dnsAAAA = new RecordSet({ HostedZoneId: props.hostedZoneId, Name: props.domain, Type: "AAAA", AliasTarget: alias }, { Condition: writeDns });

  const bucketPolicy = new S3BucketPolicy({
    Bucket: props.bucket,
    PolicyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Sid: "TerragucciReportsFrontDoor",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: cat("arn:", Partition, ":s3:::", props.bucket, "/*"),
        Condition: { StringEquals: { "AWS:SourceArn": distributionArn(distribution.Id) } },
      }],
    },
  }, { Condition: writeBucketPolicy });

  return {
    createCertificate, writeDns, writeBucketPolicy,
    settings, role, edge, edgeVersion, access, certificate, distribution, dnsA, dnsAAAA, bucketPolicy,
  };
}, "ReportsFrontDoor");
