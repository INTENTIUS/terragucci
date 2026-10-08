/**
 * The reports front door as a template: `ReportsFrontDoor` over one parameter
 * per setting. `just ci` renders it to docs-site/public/reports-front-door.json,
 * the file the "Keep reports in S3" guide deploys, and `just ci-check` fails
 * when that file differs.
 */
import { Join, output, Parameter, Partition, Ref, StackName } from "@intentius/chant-lexicon-aws";
import { distributionArn, ReportsFrontDoor } from "./front-door";

export const ReportsBucket = new Parameter("String", { description: "The reports bucket: reports.bucket without s3://" });
export const ReportsBucketRegion = new Parameter("String", { description: "The region of the reports bucket", defaultValue: "us-east-1" });
export const DomainName = new Parameter("String", { description: "The DNS name people open, such as reports.acme.example; reports.url is https:// and this name" });
export const HostedZoneId = new Parameter("String", { description: "The Route 53 hosted zone of DomainName, for its alias records and the certificate's validation; empty writes no DNS record", defaultValue: "" });
export const CertificateArn = new Parameter("String", { description: "An ACM certificate in us-east-1 for DomainName; empty requests one, validated in HostedZoneId", defaultValue: "" });
export const OidcIssuer = new Parameter("String", { description: "The OpenID Connect issuer, such as https://accounts.google.com" });
export const OidcClientId = new Parameter("String", { description: "The client id of the web application registered with the issuer" });
export const OidcClientSecretName = new Parameter("String", { description: "The name of a Secrets Manager secret in us-east-1 whose value is the client secret" });
export const AllowedEmailDomain = new Parameter("String", { description: "Only email addresses at this domain sign in; empty lets in anyone the issuer signs in", defaultValue: "" });
export const SessionHours = new Parameter("String", { description: "How long a sign-in lasts, in hours", defaultValue: "12" });
export const WriteBucketPolicy = new Parameter("String", { description: "true writes the bucket policy; false leaves it to you, with the statement in the BucketPolicyStatement output", defaultValue: "false" });

export const door = ReportsFrontDoor({
  name: StackName,
  bucket: Ref(ReportsBucket),
  bucketRegion: Ref(ReportsBucketRegion),
  domain: Ref(DomainName),
  certificateArn: Ref(CertificateArn),
  hostedZoneId: Ref(HostedZoneId),
  issuer: Ref(OidcIssuer),
  clientId: Ref(OidcClientId),
  clientSecretName: Ref(OidcClientSecretName),
  allowedDomain: Ref(AllowedEmailDomain),
  sessionHours: Ref(SessionHours),
  bucketPolicy: Ref(WriteBucketPolicy),
});

export const Url = output(Join("", ["https://", Ref(DomainName)]), "Url");
export const DistributionId = output(door.distribution.Id, "DistributionId");
export const DistributionDomainName = output(door.distribution.DomainName, "DistributionDomainName");
export const BucketPolicyStatement = output(Join("", [
  '{"Sid":"TerragucciReportsFrontDoor","Effect":"Allow","Principal":{"Service":"cloudfront.amazonaws.com"},"Action":"s3:GetObject","Resource":"arn:',
  Partition, ":s3:::", Ref(ReportsBucket), '/*","Condition":{"StringEquals":{"AWS:SourceArn":"', distributionArn(door.distribution.Id), '"}}}',
]), "BucketPolicyStatement");
