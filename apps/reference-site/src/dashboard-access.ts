export type DashboardAccessDecision =
  | Readonly<{ allowed: true; reason: "local_development" }>
  | Readonly<{
      allowed: false;
      reason: "authentication_not_configured";
    }>;

export function authorizeDashboard({
  runtime,
}: {
  runtime: "development" | "production" | "test";
}): DashboardAccessDecision {
  if (runtime === "development") {
    return { allowed: true, reason: "local_development" };
  }

  return { allowed: false, reason: "authentication_not_configured" };
}
