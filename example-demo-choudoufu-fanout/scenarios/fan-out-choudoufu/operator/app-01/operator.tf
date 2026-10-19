# The operator's change to app-01's estate, applied from outside the pipeline
# with -target while the pipeline's wave 3 applies app-01 (stack/demo.sh,
# fan-out-choudoufu). It is a resource of its own, with a record of its own, so
# both applies land and neither waits. The next reset's apply of the base tree
# deletes it: choudoufu deletes a resource of the estate that no code declares.
resource "aws_sqs_queue" "alarms" {
  name = "fan-out-choudoufu-app-01-alarms"
  tags = { tier = "app", owner = "operator" }
}
