export function contentSecurityPolicyDirectives(
  policy: string,
): Map<string, string[]>;

export function admitsAnotherSource(value: string): boolean;

export function dashboardPolicyShortfall(policy: string | null): string | null;
