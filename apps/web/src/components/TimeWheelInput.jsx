import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  WHEEL_DEFAULT_TIME,
  WHEEL_ITEM_PX,
  WHEEL_MINUTE_STEP,
  WHEEL_PLACEHOLDER,
  WHEEL_SETTLE_MS,
  WHEEL_VISIBLE_ROWS,
} from "../constants/timeWheel";

/**
 * TimeWheelInput — a time field that opens an Apple-style scroll wheel (hour · minute · AM/PM) instead of the
 * browser's native dropdown. Same contract as `<input type="time">`: `value` and `onChange` carry a 24-hour
 * "HH:MM" string ("" when unset), so it drops in wherever a native time input was.
 */

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: Math.ceil(60 / WHEEL_MINUTE_STEP) }, (_, i) => String(i * WHEEL_MINUTE_STEP).padStart(2, "0"));
const PERIODS = ["AM", "PM"];
const PAD_PX = (WHEEL_ITEM_PX * (WHEEL_VISIBLE_ROWS - 1)) / 2;
const WHEEL_HEIGHT_PX = WHEEL_ITEM_PX * WHEEL_VISIBLE_ROWS;

/** "HH:MM" (24h) -> wheel indices, or null when it is not a time. */
function toIndices(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(value || "");
  if (!m) return null;
  const h = Number(m[1]) % 24;
  const minute = Math.round(Number(m[2]) / WHEEL_MINUTE_STEP);
  return { hour: (h % 12 || 12) - 1, minute: Math.min(minute, MINUTES.length - 1), period: h >= 12 ? 1 : 0 };
}

/** Wheel indices -> "HH:MM" (24h). */
function fromIndices({ hour, minute, period }) {
  const h12 = hour + 1;
  const h = (h12 % 12) + (period === 1 ? 12 : 0);
  return `${String(h).padStart(2, "0")}:${MINUTES[minute]}`;
}

const label12 = (value) => {
  const i = toIndices(value);
  return i ? `${HOURS[i.hour]}:${MINUTES[i.minute]} ${PERIODS[i.period]}` : "";
};

/** One scrolling column. Snaps a row under the centre band; the row it rests on is the choice. */
function Wheel({ items, index, onIndex, label, width }) {
  const ref = useRef(null);
  const timer = useRef(null);

  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = index * WHEEL_ITEM_PX;
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A change that did not come from scrolling (a tap on a row) moves the wheel to it.
  useEffect(() => {
    const el = ref.current;
    if (el && Math.abs(el.scrollTop - index * WHEEL_ITEM_PX) > 1) el.scrollTo({ top: index * WHEEL_ITEM_PX, behavior: "smooth" });
  }, [index]);

  const onScroll = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const i = Math.max(0, Math.min(items.length - 1, Math.round(ref.current.scrollTop / WHEEL_ITEM_PX)));
      if (i !== index) onIndex(i);
    }, WHEEL_SETTLE_MS);
  };

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      onScroll={onScroll}
      className="snap-y snap-mandatory overflow-y-scroll overscroll-contain"
      style={{ height: WHEEL_HEIGHT_PX, width, scrollbarWidth: "none", msOverflowStyle: "none" }}
    >
      <div style={{ height: PAD_PX }} aria-hidden="true" />
      {items.map((text, i) => (
        <div
          key={text}
          role="option"
          aria-selected={i === index}
          onClick={() => onIndex(i)}
          style={{ height: WHEEL_ITEM_PX }}
          className={`flex cursor-pointer snap-center items-center justify-center text-[20px] tabular-nums transition-colors ${
            i === index ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-muted)]"
          }`}
        >
          {text}
        </div>
      ))}
      <div style={{ height: PAD_PX }} aria-hidden="true" />
    </div>
  );
}

export default function TimeWheelInput({ value = "", onChange, className = "", placeholder = WHEEL_PLACEHOLDER, disabled = false, ...rest }) {
  const [open, setOpen] = useState(false);
  const idx = toIndices(value) || toIndices(WHEEL_DEFAULT_TIME);
  const emit = (patch) => onChange?.(fromIndices({ ...idx, ...patch }));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="dialog"
          className={`flex items-center justify-between gap-2 text-left disabled:opacity-50 ${className}`}
          {...rest}
        >
          <span className={value ? "" : "text-[var(--text-muted)]"}>{label12(value) || placeholder}</span>
          <Clock className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="z-[200] w-auto p-3" data-testid="time-wheel">
        <div className="relative flex items-stretch justify-center gap-1">
          {/* The band the chosen row sits in, behind the numbers. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 rounded-lg bg-[var(--bg-tertiary)]"
            style={{ top: PAD_PX, height: WHEEL_ITEM_PX }}
          />
          <div
            className="relative flex gap-1"
            style={{ WebkitMaskImage: "linear-gradient(transparent, #000 30%, #000 70%, transparent)", maskImage: "linear-gradient(transparent, #000 30%, #000 70%, transparent)" }}
          >
            <Wheel label="Hour" items={HOURS} index={idx.hour} onIndex={(i) => emit({ hour: i })} width={64} />
            <Wheel label="Minute" items={MINUTES} index={idx.minute} onIndex={(i) => emit({ minute: i })} width={64} />
            <Wheel label="AM or PM" items={PERIODS} index={idx.period} onIndex={(i) => emit({ period: i })} width={64} />
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              onChange?.("");
              setOpen(false);
            }}
            className="rounded px-2 py-1 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => {
              if (!value) emit({}); // "Done" on an untouched wheel keeps the time it was showing
              setOpen(false);
            }}
            className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
          >
            Done
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
