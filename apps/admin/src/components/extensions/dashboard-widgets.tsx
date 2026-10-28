'use client';

import { SLOTS } from '@/lib/extensions/registry';
import pageStyles from '../shell/page.module.css';
import { Card } from '../ui/surface';
import { Slot } from './host';

/**
 * The `dashboard` slot: plugins' widgets, each a card in the dashboard grid
 * (a third of the width, or two thirds with size "large").
 */
export function DashboardWidgets() {
  return (
    <Slot
      name={SLOTS.dashboard}
      place="dashboard widget"
      wrap={(fill, content) => (
        <div className={fill.props.size === 'large' ? pageStyles.span8 : pageStyles.span4}>
          <Card title={typeof fill.props.title === 'string' ? fill.props.title : 'Widget'}>
            {content}
          </Card>
        </div>
      )}
    />
  );
}
