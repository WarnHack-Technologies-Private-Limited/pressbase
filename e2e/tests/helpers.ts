import { expect, type Page } from '@playwright/test';

/** The administrator the installer test creates; the other tests log in as them. */
export const ADMIN = {
  title: 'End to End',
  username: 'editor-in-chief',
  password: 'quiet-harbour-71-lantern-maple',
  email: 'chief@example.com',
};

export async function logIn(page: Page, password = ADMIN.password) {
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(ADMIN.username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

export async function logInAsAdmin(page: Page) {
  await logIn(page);
  await expect(page).toHaveURL(/\/admin\/?$/);
}

/** A string unique to this run, so tests never match leftovers. */
export function unique(prefix: string) {
  return `${prefix} ${Date.now().toString(36)}`;
}
