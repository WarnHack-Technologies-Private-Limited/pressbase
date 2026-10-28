import { describe, expect, it } from 'vitest';
import { installable, languageLabel } from './languages';

describe('languages', () => {
  it('labels a language by its own name, then its English one', () => {
    expect(languageLabel({ native_name: 'Deutsch', english_name: 'German' })).toBe(
      'Deutsch (German)',
    );
    expect(languageLabel({ native_name: 'Afrikaans', english_name: 'Afrikaans' })).toBe(
      'Afrikaans',
    );
  });

  it('offers only the packs not installed yet', () => {
    const pack = (language: string, english_name: string, installed = false) => ({
      language,
      english_name,
      native_name: english_name,
      version: '7.1.3',
      updated: '',
      installed,
    });
    const result = installable(
      [pack('fr_FR', 'French'), pack('de_DE', 'German'), pack('ar', 'Arabic', true)],
      [
        {
          language: 'en_US',
          english_name: 'English',
          native_name: 'English',
          dir: 'ltr',
          wordpress: true,
        },
        {
          language: 'de_DE',
          english_name: 'German',
          native_name: 'Deutsch',
          dir: 'ltr',
          wordpress: true,
        },
      ],
    );
    expect(result.map((l) => l.language)).toEqual(['fr_FR']);
  });
});
