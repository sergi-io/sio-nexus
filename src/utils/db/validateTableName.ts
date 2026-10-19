export function validateTableName(name: string, label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `${label} must start with a letter and contain only letters, digits, or underscores.`
    );
  }
  return name;
}
