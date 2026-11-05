import { buttonIndex, type PadButton, type PadControl } from './pad.ts'
import { isPlayStation, type PadFamily, padLabel } from './padFamily.ts'
import type { PadState } from './padDriver.ts'
import {
  anchorOf,
  arrangementFor,
  BODY_PATH,
  BODY_TRANSFORM,
  type Callout,
  calloutsFor,
  calloutY,
  CLUSTER,
  COLUMN,
  placeX,
  placeY,
  STICK,
  VIEW,
} from './controllerLayout.ts'

/**
 * The controller, drawn: what every control does in one mode, and what the
 * pad in your hands is doing right now.
 *
 * Live, because a diagram that lights the button under your thumb answers
 * "which one is R1" faster than any label, and because the stick caps drawn at
 * their raw position beside a dot at the shaped one are the deadzone and the
 * curve made visible — the tuning sliders below change the dot and not the cap.
 *
 * Hairlines in the instrument's two families, and color only where state
 * changes meaning: a pressed control fills with the accent, the control under
 * discussion is outlined in it, and everything else is graphite. The
 * PlayStation shapes are drawn in the same ink as everything else; their four
 * colors are Sony's, and an interface with one accent has no room for them.
 *
 * A pointer can click a control to choose it, which is a shortcut and not the
 * only way: every control is also a row in the list beneath, which is where a
 * keyboard and a screen reader rebind it.
 */
export function ControllerDiagram({
  family,
  state,
  labels,
  highlight,
  listening,
  onPick,
}: {
  readonly family: PadFamily
  /** The pad as last read, or null with none attached. */
  readonly state: PadState | null
  /** What each callout says. Absent or null reads as unbound. */
  readonly labels: ReadonlyMap<Callout, string | null>
  /** The control under discussion: the hovered row, or the one being bound. */
  readonly highlight: Callout | null
  /** A row is waiting for a control, so every control is offered. */
  readonly listening: boolean
  readonly onPick?: (control: PadControl) => void
}) {
  const layout = arrangementFor(family)
  const columns = calloutsFor(family)
  const value = (button: PadButton): number =>
    state?.buttons[buttonIndex(button)] ?? 0
  const lit = (control: Callout): boolean =>
    highlight === control ||
    (highlight === 'ls' && control === 'l3') ||
    (highlight === 'rs' && control === 'r3')
  const stroke = (control: Callout, button?: PadButton): string =>
    button !== undefined && value(button) > 0.5
      ? 'fill-sky-500/40 stroke-sky-300'
      : lit(control)
        ? 'fill-sky-500/15 stroke-sky-300'
        : listening
          ? 'fill-slate-900/60 stroke-slate-400'
          : 'fill-slate-900/60 stroke-slate-500'
  const pick = (control: PadControl) => () => onPick?.(control)
  const pointer = onPick === undefined ? '' : 'cursor-pointer'
  const hairline = {
    vectorEffect: 'non-scaling-stroke' as const,
    strokeWidth: 1,
  }

  return (
    <svg
      viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
      className="w-full select-none"
      role="img"
      aria-label="The controller, with what each control does in the chosen mode"
    >
      <g transform={BODY_TRANSFORM}>
        {(['l2', 'r2'] as const).map((trigger) => {
          const x = trigger === 'l2' ? 110 : 450
          const pressed = value(trigger)
          return (
            <g key={trigger} className={pointer} onClick={pick(trigger)}>
              <rect
                x={x}
                y={24}
                width={80}
                height={36}
                rx={12}
                className={stroke(trigger)}
                {...hairline}
              />
              {/* The trigger's travel, filled from the bottom: an analog
                  control drawn as one, so a half-squeeze reads as half. */}
              {pressed > 0 && (
                <rect
                  x={x + 3}
                  y={24 + 33 - 30 * pressed}
                  width={74}
                  height={30 * pressed}
                  rx={9}
                  className="fill-sky-500/40"
                />
              )}
            </g>
          )
        })}
        {(['l1', 'r1'] as const).map((bumper) => (
          <rect
            key={bumper}
            x={bumper === 'l1' ? 95 : 435}
            y={66}
            width={110}
            height={18}
            rx={8}
            className={`${stroke(bumper, bumper)} ${pointer}`}
            onClick={pick(bumper)}
            {...hairline}
          />
        ))}

        <path
          d={BODY_PATH}
          className="fill-slate-950/80 stroke-slate-600"
          {...hairline}
        />

        <rect
          {...layout.touchpad}
          rx={isPlayStation(family) ? 12 : 6}
          className={`${stroke('touchpad', 'touchpad')} ${pointer}`}
          onClick={pick('touchpad')}
          {...hairline}
        />
        {(['select', 'start'] as const).map((button) => (
          <rect
            key={button}
            x={layout[button].x - 6}
            y={layout[button].y - 11}
            width={12}
            height={22}
            rx={6}
            className={`${stroke(button, button)} ${pointer}`}
            onClick={pick(button)}
            {...hairline}
          />
        ))}
        <circle
          cx={layout.home.x}
          cy={layout.home.y}
          r={9}
          className={stroke('home', 'home')}
          {...hairline}
        />

        {(
          [
            ['up', 0, -1],
            ['down', 0, 1],
            ['left', -1, 0],
            ['right', 1, 0],
          ] as const
        ).map(([arm, dx, dy]) => (
          <rect
            key={arm}
            x={layout.dpad.x + dx * 22 - (dx === 0 ? 11 : 13)}
            y={layout.dpad.y + dy * 22 - (dy === 0 ? 11 : 13)}
            width={dx === 0 ? 22 : 26}
            height={dy === 0 ? 22 : 26}
            rx={5}
            className={`${stroke(arm, arm)} ${pointer}`}
            onClick={pick(arm)}
            {...hairline}
          />
        ))}

        {(
          [
            ['north', 0, -1],
            ['south', 0, 1],
            ['west', -1, 0],
            ['east', 1, 0],
          ] as const
        ).map(([button, dx, dy]) => {
          const cx = layout.face.x + dx * CLUSTER
          const cy = layout.face.y + dy * CLUSTER
          return (
            <g key={button} className={pointer} onClick={pick(button)}>
              <circle
                cx={cx}
                cy={cy}
                r={15}
                className={stroke(button, button)}
                {...hairline}
              />
              <text
                x={cx}
                y={cy}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={15}
                className="fill-slate-300"
              >
                {padLabel(button, family)}
              </text>
            </g>
          )
        })}

        {(
          [
            ['ls', 'l3', layout.leftStick, state?.raw.left, state?.shaped.left],
            [
              'rs',
              'r3',
              layout.rightStick,
              state?.raw.right,
              state?.shaped.right,
            ],
          ] as const
        ).map(([stick, press, at, raw, shaped]) => (
          <g key={stick} className={pointer} onClick={pick(press)}>
            <circle
              cx={at.x}
              cy={at.y}
              r={STICK.gate}
              className={
                lit(stick)
                  ? 'fill-none stroke-sky-300'
                  : 'fill-none stroke-slate-600'
              }
              {...hairline}
            />
            <circle
              cx={at.x + (raw?.x ?? 0) * STICK.travel}
              cy={at.y + (raw?.y ?? 0) * STICK.travel}
              r={STICK.cap}
              className={stroke(stick, press)}
              {...hairline}
            />
            {/* Where the shaped stick is: inside the deadzone it sits at the
                center however far the cap has drifted. */}
            <circle
              cx={at.x + (shaped?.x ?? 0) * STICK.gate * 0.8}
              cy={at.y + (shaped?.y ?? 0) * STICK.gate * 0.8}
              r={3}
              className="fill-sky-300"
            />
          </g>
        ))}
      </g>

      {(['left', 'right'] as const).map((side) =>
        columns[side].map((callout, index, all) => {
          const y = calloutY(index, all.length)
          const anchor = anchorOf(
            callout === 'ls' ? 'ls.up' : callout === 'rs' ? 'rs.up' : callout,
            layout,
          )
          const column = COLUMN[side]
          const label = labels.get(callout) ?? null
          const glyph =
            callout === 'ls'
              ? 'L stick'
              : callout === 'rs'
                ? 'R stick'
                : padLabel(callout, family)
          const reach = side === 'left' ? column.x + 6 : column.x - 6
          return (
            <g key={callout}>
              <polyline
                points={`${placeX(anchor.x)},${placeY(anchor.y)} ${reach},${y}`}
                className={
                  lit(callout)
                    ? 'fill-none stroke-sky-300'
                    : 'fill-none stroke-slate-700'
                }
                strokeWidth={1}
              />
              <text
                x={column.x}
                y={y}
                textAnchor={column.anchor}
                dominantBaseline="central"
                fontSize={13}
                className="type-ui"
              >
                {side === 'right' && (
                  <tspan fontSize={11} className="fill-sky-400/80">
                    {glyph}{' '}
                  </tspan>
                )}
                <tspan
                  className={
                    lit(callout)
                      ? 'fill-sky-200'
                      : label === null
                        ? 'fill-slate-400'
                        : 'fill-slate-300'
                  }
                >
                  {label ?? '—'}
                </tspan>
                {side === 'left' && (
                  <tspan fontSize={11} className="fill-sky-400/80">
                    {' '}
                    {glyph}
                  </tspan>
                )}
              </text>
            </g>
          )
        }),
      )}
    </svg>
  )
}
