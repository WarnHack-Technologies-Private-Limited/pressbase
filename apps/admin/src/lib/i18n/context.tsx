'use client';

import { sprintf } from '@wordpress/i18n';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { type AdminLocale, createTranslator, ENGLISH } from './locale';

function translatorFor(locale: AdminLocale) {
  const i18n = createTranslator(locale);
  return {
    __: i18n.__,
    _x: i18n._x,
    _n: i18n._n,
    _nx: i18n._nx,
    sprintf,
    isRTL: i18n.isRTL,
    locale: locale.locale,
    lang: locale.lang,
    dir: locale.dir,
  };
}

export type Translator = ReturnType<typeof translatorFor>;

const I18nContext = createContext<Translator>(translatorFor(ENGLISH));

/** Gives client components the user's translations (set up in the root layout). */
export function I18nProvider({ locale, children }: { locale: AdminLocale; children: ReactNode }) {
  const value = useMemo(() => translatorFor(locale), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `__`, `_x`, `_n`, `_nx` and `sprintf`, in the user's language. */
export function useI18n(): Translator {
  return useContext(I18nContext);
}
