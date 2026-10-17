#!/usr/bin/env bash
# shared/ is kept by hand. It is one shared root of 14 resources, small enough
# that each beat of the demo loop is short. The tree began as the output of
# choudoufu's terralith-gen at scale 1 (82 resources with logs.tf and
# state.tf), cut down by hand. What is
# left is a network that stays in the shared root (VPC, subnet and
# security group) and the teams team-a, team-b and team-c. Each team has a role
# with an inline policy and a log group, and team-b also has two workers from
# one count-expanded block. Change the .tf files there by hand, since no tool
# writes them.
#
# This script writes the scenario's pull requests from that tree
# (scripts/phases.py), so run it after any change to shared/:
#
#   ./generate.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python3 "$here/scripts/phases.py"
