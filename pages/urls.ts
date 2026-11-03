/** Hosts under test. The web app signs in through the separate auth app (OIDC). */

export const WEB_URL = process.env.QA_BASE_URL ?? 'https://qa-integration.marksheetplus.com';
export const AUTH_URL = process.env.QA_AUTH_URL ?? 'https://qa-integration-auth.marksheetplus.com';
