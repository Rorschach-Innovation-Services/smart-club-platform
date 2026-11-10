/**
 * Field helpers shared by the public forms (player registration, official self-registration):
 * the dark centred card, titled sections, labels with a required marker, text inputs and
 * pill checkboxes. Markup and classes are exactly what RegisterPage has always rendered.
 */
import type { ReactNode, ChangeEventHandler, InputHTMLAttributes } from 'react';

export function CenterCard({ children, wide }: { children?: ReactNode; wide?: boolean }) {
  return (
    <div className="ps-screen">
      <div className={`ps-cards ${wide ? 'reg-cards' : 'reg-cards-sm'}`}>
        <div className="ps-card reg-card">{children}</div>
      </div>
    </div>
  );
}

export function Section({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="reg-section">
      <div className="reg-section-title">{title}</div>
      <div className="reg-grid">{children}</div>
    </div>
  );
}

export function Label({ label, required }: { label: ReactNode; required?: boolean }) {
  return (
    <span className="reg-label">
      {label}
      {required && <span className="req">*</span>}
    </span>
  );
}

export interface FieldProps {
  label: ReactNode;
  type?: string;
  required?: boolean;
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  placeholder?: string;
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode'];
  span?: boolean;
  /** Optional; omitted attributes render nothing, so existing callers are unchanged. */
  maxLength?: number;
  autoComplete?: string;
  invalid?: boolean;
}
export function Field({
  label,
  type = 'text',
  required,
  value,
  onChange,
  placeholder,
  inputMode,
  span,
  maxLength,
  autoComplete,
  invalid,
}: FieldProps) {
  return (
    <label className={span ? 'reg-span' : undefined} style={{ display: 'block' }}>
      <Label label={label} required={required} />
      <input
        className="field-input"
        type={type}
        inputMode={inputMode}
        required={required}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        style={{ width: '100%', fontSize: 16 }}
      />
    </label>
  );
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="rp-check rp-pill" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
