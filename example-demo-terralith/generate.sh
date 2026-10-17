#!/usr/bin/env bash
# The command that wrote terralith/: choudoufu's terralith-gen at scale 1
# with prefix tl, formatted by tofu, from a checkout of choudoufu (its
# origin/main at 7431c46634 wrote the committed files). state.tf and logs.tf
# are this tree's own, and the generator leaves them as they are. Then
# scripts/phases.py writes the scenario's pull requests from the result.
#
#   CHOUDOUFU_SRC=~/checkouts/intentius/choudoufu ./generate.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="${CHOUDOUFU_SRC:?set CHOUDOUFU_SRC to a checkout of INTENTIUS/choudoufu}"
(cd "$src" && go run ./tools/terralith-gen -scale 1 -prefix tl -fmt-bin tofu -out "$here/terralith")
python3 "$here/scripts/phases.py"
