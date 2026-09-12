/**
 * Authorize RDS SG inbound PostgreSQL (5432) from ForkUp V2 EC2 security groups.
 * Additive only — does not remove existing rules.
 *
 * Inputs: env AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
 *         RDS_INSTANCE_ID (or discover by endpoint), EC2_SG_IDS (comma-separated)
 * Outputs: prints authorize result; exits 0 on success / already exists
 */
import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
} from "@aws-sdk/client-ec2";
import {
  RDSClient,
  DescribeDBInstancesCommand,
} from "@aws-sdk/client-rds";

const region = process.env.AWS_REGION || "us-east-1";
const endpointHint =
  process.env.RDS_ENDPOINT_HINT ||
  "forkup.ct4oyoyc8mxs.us-east-1.rds.amazonaws.com";
const ec2SgIds = (process.env.EC2_SG_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (ec2SgIds.length === 0) {
  console.error("Set EC2_SG_IDS=sg-xxx,sg-yyy");
  process.exit(1);
}

const ec2 = new EC2Client({ region });
const rds = new RDSClient({ region });

async function main() {
  const desc = await rds.send(new DescribeDBInstancesCommand({}));
  const db = (desc.DBInstances || []).find((d) =>
    (d.Endpoint?.Address || "").includes(endpointHint.split(".")[0]),
  );
  if (!db) {
    console.error("RDS instance not found for", endpointHint);
    process.exit(1);
  }
  console.log("RDS:", db.DBInstanceIdentifier, db.Endpoint?.Address);
  console.log("RDS VPC:", db.DBSubnetGroup?.VpcId);
  const rdsSgIds = (db.VpcSecurityGroups || [])
    .map((g) => g.VpcSecurityGroupId)
    .filter(Boolean);
  console.log("RDS SGs:", rdsSgIds.join(", "));

  for (const rdsSg of rdsSgIds) {
    for (const sourceSg of ec2SgIds) {
      try {
        await ec2.send(
          new AuthorizeSecurityGroupIngressCommand({
            GroupId: rdsSg,
            IpPermissions: [
              {
                IpProtocol: "tcp",
                FromPort: 5432,
                ToPort: 5432,
                UserIdGroupPairs: [
                  {
                    GroupId: sourceSg,
                    Description: "ForkUp V2 EC2 API postgres",
                  },
                ],
              },
            ],
          }),
        );
        console.log(`AUTHORIZED: ${rdsSg} <- ${sourceSg}:5432`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("InvalidPermission.Duplicate")) {
          console.log(`ALREADY: ${rdsSg} <- ${sourceSg}:5432`);
        } else {
          console.error(`FAILED: ${rdsSg} <- ${sourceSg}:`, msg);
          throw err;
        }
      }
    }

    const sg = await ec2.send(
      new DescribeSecurityGroupsCommand({ GroupIds: [rdsSg] }),
    );
    const perms = sg.SecurityGroups?.[0]?.IpPermissions || [];
    const pg = perms.filter((p) => p.FromPort === 5432 || p.ToPort === 5432);
    console.log(`Current 5432 rules on ${rdsSg}:`, JSON.stringify(pg, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
