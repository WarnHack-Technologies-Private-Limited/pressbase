'use client';

import { useState } from 'react';
import {
  type ExportChoices,
  type ExportFilters,
  exportUrl,
  filtersFor,
  monthLabel,
} from '@/lib/import-export';
import { PageHeader } from '../shell/page-header';
import { Button } from '../ui/button';
import { SelectField } from '../ui/field';
import { Card } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './tools.module.css';

/**
 * Tools → Export (wp-admin/export.php), made calm: one choice of what to
 * export, its filters only when they apply, and one button.
 */

const HINTS: Record<string, string> = {
  all: 'Posts, pages, comments, custom fields, categories, tags, menus and media. Choose this to move a whole site.',
  post: 'Posts, with their comments, and the images attached to them.',
  page: 'Pages, with their comments, and the images attached to them.',
  attachment: 'The media library’s entries. The files themselves are downloaded by the importer.',
};

const FILTERED = ['post', 'page', 'attachment'] as const;

export function ExportScreen({ choices }: { choices: ExportChoices }) {
  const toast = useToast();
  const [filters, setFilters] = useState<ExportFilters>({
    content: 'all',
    category: '',
    author: '',
    start_date: '',
    end_date: '',
    status: '',
  });
  const set = (key: keyof ExportFilters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const options = [
    { name: 'all', label: 'All content' },
    ...['post', 'page'].flatMap((name) => choices.types.filter((t) => t.name === name)),
    ...choices.types.filter((t) => !['post', 'page', 'attachment'].includes(t.name)),
    ...choices.types.filter((t) => t.name === 'attachment').map((t) => ({ ...t, label: 'Media' })),
  ];

  const download = () => {
    window.location.href = exportUrl(filters);
    toast('Your export file is downloading.');
  };

  const filterFields = (content: string) => {
    const keys = filtersFor(content);
    if (!keys.length) return null;
    const type = content as (typeof FILTERED)[number];
    const months = choices.months[type] ?? [];
    return (
      <div className={styles.filters}>
        {keys.includes('category') && (
          <SelectField
            label="Category"
            value={filters.category}
            onChange={(e) => set('category', e.target.value)}
          >
            <option value="">All</option>
            {choices.categories.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </SelectField>
        )}
        {keys.includes('author') && (
          <SelectField
            label="Author"
            value={filters.author}
            onChange={(e) => set('author', e.target.value)}
          >
            <option value="">All</option>
            {(choices.authors[type] ?? []).map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.name}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField
          label="From"
          value={filters.start_date}
          onChange={(e) => set('start_date', e.target.value)}
        >
          <option value="">The beginning</option>
          {[...months].reverse().map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="To"
          value={filters.end_date}
          onChange={(e) => set('end_date', e.target.value)}
        >
          <option value="">Now</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </SelectField>
        {keys.includes('status') && (
          <SelectField
            label="Status"
            value={filters.status}
            onChange={(e) => set('status', e.target.value)}
          >
            <option value="">All</option>
            {choices.statuses.map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
          </SelectField>
        )}
      </div>
    );
  };

  return (
    <div className={styles.screen}>
      <PageHeader
        title="Export"
        description="Download your content as a WordPress export file (WXR). Pressbase and WordPress can both import it."
      />
      <Card title="Choose what to export">
        <div className={styles.fields}>
          <fieldset className={styles.choices}>
            <legend>Content to export</legend>
            {options.map((option) => (
              <div key={option.name} className={styles.choice}>
                <label>
                  <input
                    type="radio"
                    name="content"
                    value={option.name}
                    checked={filters.content === option.name}
                    onChange={() => set('content', option.name)}
                    aria-describedby={HINTS[option.name] ? `hint-${option.name}` : undefined}
                  />
                  <span>{option.label}</span>
                </label>
                {HINTS[option.name] && (
                  <p id={`hint-${option.name}`} className={styles.choiceHint}>
                    {HINTS[option.name]}
                  </p>
                )}
                {filters.content === option.name && filterFields(option.name)}
              </div>
            ))}
          </fieldset>
          <p>
            The file isn’t a full backup: themes, plugins, settings and the media files themselves
            aren’t in it.
          </p>
          <div className={styles.actions}>
            <Button variant="primary" onClick={download}>
              Download export file
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
