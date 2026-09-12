#!/usr/bin/env bash
set -euo pipefail
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
H="X-aws-ec2-metadata-token: ${TOKEN}"
INSTANCE=$(curl -s -H "$H" http://169.254.169.254/latest/meta-data/instance-id)
MAC=$(curl -s -H "$H" http://169.254.169.254/latest/meta-data/mac)
SG=$(curl -s -H "$H" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC}/security-group-ids")
VPC=$(curl -s -H "$H" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC}/vpc-id")
SUBNET=$(curl -s -H "$H" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC}/subnet-id")
AZ=$(curl -s -H "$H" http://169.254.169.254/latest/meta-data/placement/availability-zone)
PRIV=$(curl -s -H "$H" http://169.254.169.254/latest/meta-data/local-ipv4)
echo "INSTANCE=${INSTANCE}"
echo "SG=${SG}"
echo "VPC=${VPC}"
echo "SUBNET=${SUBNET}"
echo "AZ=${AZ}"
echo "PRIV=${PRIV}"
# Resolve RDS from inside VPC
getent hosts forkup.ct4oyoyc8mxs.us-east-1.rds.amazonaws.com || true
timeout 3 bash -c 'echo > /dev/tcp/172.31.96.36/5432' && echo RDS_PRIVATE_OPEN || echo RDS_PRIVATE_CLOSED
timeout 3 bash -c 'echo > /dev/tcp/34.231.97.123/5432' && echo RDS_PUBLIC_OPEN || echo RDS_PUBLIC_CLOSED
