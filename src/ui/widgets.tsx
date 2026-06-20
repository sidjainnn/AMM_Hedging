import { fmt } from './format';

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmtVal,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmtVal?: (v: number) => string;
}) {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        <b>{fmtVal ? fmtVal(value) : fmt(value, 2)}</b>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { v: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.v}
          className={value === o.v ? 'on' : ''}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Provenance({ kind }: { kind: 'sim' | 'deploy' }) {
  return (
    <span className={`tag ${kind}`}>
      {kind === 'sim' ? 'sim-ground-truth' : 'deployment-available'}
    </span>
  );
}
