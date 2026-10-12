#!/bin/sh
# The synth command: writes out/a and out/b, each holding the word it was given.
set -e
for s in a b; do
  mkdir -p "out/$s"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "this" {\n  input = "%s"\n}\n' "$1" > "out/$s/main.tf"
done
