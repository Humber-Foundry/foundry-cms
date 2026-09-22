export function contentSecurityPolicyDirectives(
  policy: string,
): Map<string, string[]>;

export const expectedDashboardDirectives: ReadonlyArray<
  readonly [name: string, expected: string]
>;

export function namesAHost(value: string): boolean;

export function dashboardPolicyShortfall(policy: string | null): string | null;
