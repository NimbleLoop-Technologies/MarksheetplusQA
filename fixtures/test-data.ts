/** Unique test data so parallel runs never collide. No page knowledge here. */

/** Letters only: the name validator rejects digits, so encode time in base 26 (a–z). */
export function uniqueLetters(): string {
  let n = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export function uniqueEmail(prefix = 'qa-auto'): string {
  return `${prefix}+${uniqueLetters()}@marksheetplus-qa.invalid`;
}

/** e.g. "Qa Kxjfqzbd" — capitalised, letters and a space only. */
export function uniqueName(prefix = 'Qa'): string {
  const s = uniqueLetters();
  return `${prefix} ${s[0].toUpperCase()}${s.slice(1)}`;
}

/** Pakistani mobile format `03` + 9 digits, which the phone validator accepts. */
export function uniquePhone(): string {
  const digits = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
  return `03${digits}`;
}

/** Meets the password rule: 8–20 chars, upper + lower + digit. */
export const VALID_PASSWORD = 'QaAuto2026x';
