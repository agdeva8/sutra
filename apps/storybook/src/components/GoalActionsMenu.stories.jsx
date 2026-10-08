import { fn } from 'storybook/test';
import { GoalActionsMenu } from './GoalActionsMenu';

export default {
  title: 'Planner/GoalActionsMenu',
  component: GoalActionsMenu,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className='w-full max-w-2xl p-6 bg-[var(--bg-primary)] text-[var(--text-primary)]'>
        {/* Stand-in for the PlanLadder header the menu lives in. */}
        <header className='flex items-center gap-2 rounded-md px-1 py-2'>
          <div className='min-w-0 flex-1'>
            <h2 className='truncate text-[16px] font-semibold leading-tight'>Switch into platform engineering</h2>
            <p className='text-[12px] text-[var(--text-muted)]'>6h/wk · target 2026-12-01</p>
          </div>
          <Story />
        </header>
      </div>
    ),
  ],
};

const goal = { id: 'g1', title: 'Switch into platform engineering', target_date: '2026-12-01' };

/** Everything wired: the four chat-mediated actions plus the three dialogs. */
export const Default = {
  args: {
    goal,
    onAction: fn(),
    onDetails: fn(),
    onChanged: fn(),
  },
};

/**
 * No `onAction` supplied — the app has no confirmation path, so Edit /
 * Add a milestone / Pause / Drop render disabled rather than firing.
 * Sources still navigates to the Sources screen.
 */
export const WithoutActionHandler = {
  args: {
    goal,
    onDetails: fn(),
  },
};

/** Parent-supplied handlers override the built-in dialogs and navigation. */
export const WithParentHandlers = {
  args: {
    goal,
    onAction: fn(),
    onDetails: fn(),
    onOpenMemories: fn(),
    onOpenSources: fn(),
    onUploadFile: fn(),
    onAddLink: fn(),
    onChanged: fn(),
  },
};

/** Long titles must not blow out the menu width. */
export const LongGoalTitle = {
  args: {
    goal: {
      id: 'g9',
      title: 'Ship a production-grade distributed task queue with observability before the Q1 review',
      target_date: '2027-03-31',
    },
    onAction: fn(),
    onDetails: fn(),
  },
};
