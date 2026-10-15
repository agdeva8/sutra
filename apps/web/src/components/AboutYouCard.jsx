import { useState } from "react";
import { Loader2 } from "lucide-react";
import TimeWheelInput from "./TimeWheelInput";
import { weekProblem } from "../lib/profileCheck";
import { WEEKDAYS, DEFAULT_WORK_DAYS, WEEKLY_HOURS_CHOICES, MAX_WEEKLY_GOAL_HOURS, DEFAULT_WAKE, DEFAULT_SLEEP, DEFAULT_WORK_START, DEFAULT_WORK_END, DEFAULT_WEEKLY_HOURS } from "../constants/profile";

/**
 * AboutYouCard — asked once, at the start of the first Add Goal: the user's usual week.
 *
 * Work or study days and hours, wake and sleep, how many hours a week they can genuinely give to
 * goals, and optional rest days. Every field can be left empty; "Skip" saves nothing but marks the step
 * as asked so it never comes back. What they give here becomes the planner's waking window, its blocked
 * hours and its weekly capacity, and the coach reads it instead of asking again.
 */
export default function AboutYouCard({ onSave, onSkip }) {
  const [workDays, setWorkDays] = useState(DEFAULT_WORK_DAYS);
  const [wake, setWake] = useState(DEFAULT_WAKE);
  const [sleep, setSleep] = useState(DEFAULT_SLEEP);
  const [workStart, setWorkStart] = useState(DEFAULT_WORK_START);
  const [workEnd, setWorkEnd] = useState(DEFAULT_WORK_END);
  const [hours, setHours] = useState(DEFAULT_WEEKLY_HOURS);
  const [otherHours, setOtherHours] = useState("");
  const [restDays, setRestDays] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = (list, setList, key) =>
    setList(list.includes(key) ? list.filter((d) => d !== key) : [...list, key]);

  const weeklyHours = () => {
    if (hours === "other") {
      const n = Number(otherHours);
      return n > 0 && n <= MAX_WEEKLY_GOAL_HOURS ? n : null;
    }
    return hours;
  };

  const submit = async (skip) => {
    setBusy(true);
    setError("");
    const hasWorkTime = workStart && workEnd;
    const profile = skip
      ? {}
      : {
          work_days: hasWorkTime ? workDays : [],
          work_start: hasWorkTime ? workStart : "",
          work_end: hasWorkTime ? workEnd : "",
          wake,
          sleep,
          weekly_goal_hours: weeklyHours(),
          rest_days: restDays,
        };
    try {
      await (skip ? onSkip : onSave)(profile);
    } catch (e) {
      setError(typeof e?.message === "string" ? e.message : "Couldn't save that.");
      setBusy(false);
    }
  };

  const dayChips = (selected, onToggle, testId) => (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {WEEKDAYS.map((d) => {
        const on = selected.includes(d.key);
        return (
          <button
            key={d.key}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(d.key)}
            className={`min-h-11 min-w-11 rounded-full border px-3 text-sm ${
              on
                ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-primary)]"
                : "border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            }`}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );

  const timeField = (label, value, setValue, testId) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">
      {label}
      <TimeWheelInput
        data-testid={testId}
        value={value}
        onChange={setValue}
        className="min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)]"
      />
    </label>
  );

  // Told at once, in plain words, if the times contradict each other; Continue waits until they agree.
  const problem = weekProblem({ wake, sleep, workStart, workEnd });

  const section = "flex flex-col gap-2";
  const heading = "text-sm font-medium text-[var(--text-primary)]";

  return (
    <div data-testid="about-you" className="flex flex-col gap-5 gc-fade-up">
      <div>
        <p className="text-sm font-semibold text-[var(--text-primary)]">First, your usual week</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
          So plans fit around your life. Asked once; leave anything blank.
        </p>
      </div>

      <div className={section}>
        <p className={heading}>Your day</p>
        <div className="flex gap-3">
          {timeField("I wake up at", wake, setWake, "about-you-wake")}
          {timeField("I go to sleep at", sleep, setSleep, "about-you-sleep")}
        </div>
      </div>

      <div className={section}>
        <p className={heading}>Work or study hours</p>
        {dayChips(workDays, (k) => toggle(workDays, setWorkDays, k), "about-you-work-days")}
        <div className="flex gap-3">
          {timeField("From", workStart, setWorkStart, "about-you-work-start")}
          {timeField("To", workEnd, setWorkEnd, "about-you-work-end")}
        </div>
      </div>

      {problem && (
        <p role="alert" data-testid="about-you-problem" className="rounded-lg bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] px-3 py-2 text-xs leading-relaxed text-[var(--text-primary)]">
          {problem}
        </p>
      )}

      <div className={section}>
        <p className={heading}>Hours a week you can really give your goals</p>
        <div className="flex flex-wrap gap-1.5" data-testid="about-you-hours">
          {[...WEEKLY_HOURS_CHOICES, "other"].map((h) => (
            <button
              key={h}
              type="button"
              aria-pressed={hours === h}
              onClick={() => setHours(hours === h ? null : h)}
              className={`min-h-11 rounded-full border px-4 text-sm ${
                hours === h
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              }`}
            >
              {h === "other" ? "Other" : `${h}h`}
            </button>
          ))}
        </div>
        {hours === "other" && (
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max={MAX_WEEKLY_GOAL_HOURS}
            data-testid="about-you-hours-other"
            value={otherHours}
            onChange={(e) => setOtherHours(e.target.value)}
            placeholder="Hours a week"
            className="min-h-11 w-40 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)]"
          />
        )}
      </div>

      <div className={section}>
        <p className={heading}>
          Days to keep free of goal work <span className="font-normal text-[var(--text-muted)]">(optional)</span>
        </p>
        {dayChips(restDays, (k) => toggle(restDays, setRestDays, k), "about-you-rest-days")}
      </div>

      {error && <p className="text-xs text-[var(--danger,#c0392b)]">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid="about-you-skip"
          disabled={busy}
          onClick={() => submit(true)}
          className="min-h-11 rounded-full px-4 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          Skip
        </button>
        <button
          type="button"
          data-testid="about-you-save"
          disabled={busy || Boolean(problem)}
          onClick={() => submit(false)}
          className="min-h-11 inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Continue
        </button>
      </div>
    </div>
  );
}
