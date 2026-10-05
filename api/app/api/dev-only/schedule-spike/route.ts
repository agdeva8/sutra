/**
 * POST /api/dev-only/schedule-spike — integration probe for or-tools-wasm.
 *
 * Gated entirely on `ALLOW_DEV_LOGIN=true`; returns 404 otherwise so it is
 * invisible in production. No DB, no auth — it exists only to prove the
 * CP-SAT WebAssembly runtime loads and solves inside a built/deployed Next
 * function (the one unknown in `memory/scheduling-design.md`).
 *
 * Body (optional): { days?, cap?, steps?: [{ name, h }] } — h in tenths.
 * Returns the assignment + solve metadata.
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (process.env.ALLOW_DEV_LOGIN !== 'true') {
    return NextResponse.json({ detail: 'Not found' }, { status: 404 })
  }

  let body: { days?: number; cap?: number; steps?: Array<{ name: string; h: number }> } = {}
  try {
    body = await req.json()
  } catch {
    /* default scenario below */
  }

  const DAYS = body.days ?? 5
  const CAP = body.cap ?? 20 // 2.0h in tenths
  const steps = body.steps ?? [
    { name: 'Read system-design intro', h: 15 },
    { name: 'Read caching chapter', h: 15 },
    { name: 'Implement a cache', h: 20 },
    { name: 'Read sharding chapter', h: 15 },
    { name: 'Implement sharding sketch', h: 15 },
  ]

  const t0 = Date.now()
  try {
    // Dynamic import of ONLY the CP-SAT subpath — importing the package root
    // (`or-tools-wasm`) pulls every solver (routing/mathopt/mp_solver…), which
    // drags ~300 MB of .wasm into the traced function. The subpath re-exports
    // setCloudNoticeEnabled, so we never touch the root.
    const cp: any = await import('or-tools-wasm/cp-sat')
    try {
      cp?.setCloudNoticeEnabled?.(false)
    } catch {
      /* notice is harmless */
    }

    const { CpModel } = cp
    const solve = cp.CpSat?.solve ?? cp.CpSolver?.solve?.bind(cp.CpSolver)
    const sum = cp.sum
    if (!CpModel || !solve) {
      return NextResponse.json({ ok: false, error: 'cp-sat exports missing', keys: Object.keys(cp) }, { status: 500 })
    }

    const m = new CpModel()
    const assign: any[][] = steps.map((_, t) =>
      Array.from({ length: DAYS }, (_, d) => m.newBoolVar(`a_${t}_${d}`)),
    )
    const dayOf = steps.map((_, t) => m.newIntVar(0, DAYS - 1, `day_${t}`))

    steps.forEach((_, t) => {
      m.addExactlyOne(assign[t])
      let expr: any = null
      assign[t].forEach((b: any, d: number) => {
        expr = expr === null ? b.times(d) : expr.plus(b.times(d))
      })
      m.addLinearConstraint(dayOf[t].minus(expr), 0, 0)
      if (t > 0) m.addLinearConstraint(dayOf[t].minus(dayOf[t - 1]), 0, DAYS - 1)
    })
    for (let d = 0; d < DAYS; d++) {
      let load: any = null
      steps.forEach((s, t) => {
        load = load === null ? assign[t][d].times(s.h) : load.plus(assign[t][d].times(s.h))
      })
      m.addLinearConstraint(load, 0, CAP)
    }
    m.minimize(sum(dayOf))

    const res = await solve(m, { numWorkers: 1 })
    const schedule = Array.from({ length: DAYS }, () => [] as string[])
    if (res.hasSolution) {
      steps.forEach((s, t) => {
        const d = Number(res.value(dayOf[t]))
        if (d >= 0 && d < DAYS) schedule[d].push(`${s.name} (${(s.h / 10).toFixed(1)}h)`)
      })
    }

    return NextResponse.json({
      ok: true,
      status: res.status,
      hasSolution: res.hasSolution,
      schedule,
      ms: Date.now() - t0,
    })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e), ms: Date.now() - t0 },
      { status: 500 },
    )
  }
}
