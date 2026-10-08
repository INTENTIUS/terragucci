/** What a root's plan changes, as the gate and `approval: pr-review` read it. */

/** Whether a plan changes a resource (not a no-op or a read) or an output. */
export function changesSomething(plan: unknown): boolean {
  const p = plan as { resource_changes?: { change?: { actions?: string[] } }[]; output_changes?: Record<string, { actions?: string[] }> } | undefined;
  const real = (actions: string[] | undefined) => (actions ?? []).some((a) => a !== "no-op" && a !== "read");
  return (p?.resource_changes ?? []).some((r) => real(r.change?.actions)) || Object.values(p?.output_changes ?? {}).some((o) => real(o.actions));
}

/** Whether a plan destroys or replaces a resource. */
export function destroysSomething(plan: unknown): boolean {
  const p = plan as { resource_changes?: { change?: { actions?: string[] } }[] } | undefined;
  return (p?.resource_changes ?? []).some((r) => (r.change?.actions ?? []).includes("delete"));
}
