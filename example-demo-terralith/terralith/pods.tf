# pods.tf - the identity layer's module-nested share (issue #574): a
# module call with more than one instance (for_each over 2 pod keys),
# each instance declaring its own count-expanded team-equivalents
# internally (modules/team_pod/main.tf). module.team_pod["pod-a"].
# aws_iam_role.pod_role[0] is exactly the double-indexed shape
# internal/live/markers/modulemarker.go's marker_module_prefix exists to
# serve (issue #378) - the "hardest shape" issue #574 asks this generator
# to produce at least one of.

module "team_pod" {
  source = "./modules/team_pod"

  for_each = toset(["pod-a", "pod-b"])

  prefix   = "${local.name_prefix}-${each.key}"
  pod_size = local.pod_size
}
