# The shared root's state, one file on s3, as a stock root keeps it. The
# adopt pull request replaces this block with a live block, the adopt beat's
# shared/state.tf (scripts/phases.py). stack/demo.sh writes
# each cycle's name prefix over "tl", so each cycle's state has a key of its own.
terraform {
  backend "s3" {
    bucket         = "demo-terralith-state"
    key            = "tl-shared.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}
