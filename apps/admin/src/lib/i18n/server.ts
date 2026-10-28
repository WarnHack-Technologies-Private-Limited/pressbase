import { sprintf } from '@wordpress/i18n';
import { cache } from 'react';
import { coreGet } from '../core';
import { type AdminLocale, createTranslator, ENGLISH } from './locale';

/**
 * The admin's translations for this request, in the user's language
 * (`_locale=user`, as WordPress's admin scripts ask for it), or the site's
 * before anyone is logged in. English when core can't be reached.
 */
export const getAdminLocale = cache(async (): Promise<AdminLocale> => {
  try {
    const { status, data } = await coreGet<AdminLocale>('/pressbase/v1/i18n/admin?_locale=user');
    return status === 200 && data?.locale ? data : ENGLISH;
  } catch {
    return ENGLISH;
  }
});

/** `__`, `_x`, `_n`, `_nx` for server components, plus `sprintf`. */
export const getI18n = cache(async () => {
  const locale = await getAdminLocale();
  const i18n = createTranslator(locale);
  return {
    __: i18n.__,
    _x: i18n._x,
    _n: i18n._n,
    _nx: i18n._nx,
    sprintf,
    lang: locale.lang,
    dir: locale.dir,
  };
});
