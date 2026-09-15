// P2 fix (23rd independent review round, "reject blank founder confirmation
// identities"): shared, single-source validator for "is this a genuine,
// semantically non-empty identity string" — used everywhere a human
// approver/confirmer identity is required (approval.ts's assertValidApprover,
// assumption-register.ts's accept() and its persisted-state restore path).
// A merely TRUTHY string (`"   "`, a tab, a newline) is NOT sufficient: bir
// onaylayan/kurucu kimliği anlamlı bir kimlik OLMALIDIR, sadece boş
// olmayan bir string DEĞİL — "kim onayladı?" sorusunun her zaman gerçek,
// izlenebilir bir cevabı olmalıdır (bölüm 145, 47).
export function isNonBlankIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
