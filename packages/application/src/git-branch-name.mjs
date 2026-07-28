const allowedBranchCharacters = /^[A-Za-z0-9._/-]+$/u;

/**
 * Validate a branch name using the subset of `git check-ref-format --branch`
 * accepted by Foundry's provider and build adapters.
 */
export function isValidGitBranchName(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !allowedBranchCharacters.test(value) ||
    value === "HEAD" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..")
  ) {
    return false;
  }

  return value
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    );
}
