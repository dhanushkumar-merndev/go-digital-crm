'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const EMPTY = '__empty';

/**
 * A shadcn Select for a nullable free-text field: offers the suggested choices
 * plus "not set". A stored value outside the suggestions stays selectable, so
 * opening an editor never silently drops it.
 */
export function OptionalSelect({
  id,
  value,
  options,
  placeholder,
  onChange,
  labelFor = (choice) => choice,
}: {
  id?: string;
  value: string | null;
  options: readonly string[];
  placeholder: string;
  onChange: (value: string | null) => void;
  /** Display text for a stored value, e.g. a vehicle name for its id. */
  labelFor?: (value: string) => string;
}) {
  const choices = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <Select value={value ?? EMPTY} onValueChange={(next) => onChange(next === EMPTY ? null : next)}>
      <SelectTrigger id={id} aria-label={placeholder}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={EMPTY}>{placeholder}: not set</SelectItem>
        {choices.map((choice) => (
          <SelectItem key={choice} value={choice}>
            {labelFor(choice)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Yes / No / not set, for nullable booleans. */
export function OptionalBooleanSelect({
  id,
  value,
  placeholder,
  onChange,
}: {
  id?: string;
  value: boolean | null;
  placeholder: string;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <OptionalSelect
      id={id}
      value={value == null ? null : value ? 'Yes' : 'No'}
      options={['Yes', 'No']}
      placeholder={placeholder}
      onChange={(next) => onChange(next == null ? null : next === 'Yes')}
    />
  );
}
