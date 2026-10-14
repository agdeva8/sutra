import { useEffect, useState } from "react";
import { PENDING_DEFAULT, PENDING_REASSURANCE } from "../constants/progress";

/**
 * What the coach is doing while a reply is pending: the server's latest progress line, with a
 * reassuring second line once the wait gets long.
 */
export default function PendingStatus({ status }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timers = PENDING_REASSURANCE.map((r) => setTimeout(() => setElapsed(r.afterMs), r.afterMs));
    return () => timers.forEach(clearTimeout);
  }, []);
  const reassurance = [...PENDING_REASSURANCE].reverse().find((r) => elapsed >= r.afterMs);
  return (
    <span data-testid="pending-status" aria-live="polite">
      {status || PENDING_DEFAULT}
      {reassurance && <span className="block mt-1">{reassurance.text}</span>}
    </span>
  );
}
