'use client';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { standardVehicleSpecifications } from './vehicle-specifications';

export function VehicleSpecificationsEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const reserved = new Set<string>([
    'fuel_type',
    'transmission',
    'ex_showroom_price',
    'insurance_amount',
    'registration_amount',
    'cost_price',
    'margin',
    'discount',
  ]);
  const standard = new Set<string>(standardVehicleSpecifications.map(([key]) => key));
  const fields = [
    ...standardVehicleSpecifications.map(([key, label]) => ({ key, label, required: true })),
    ...Object.keys(value)
      .filter((key) => !standard.has(key) && !reserved.has(key))
      .map((key) => ({ key, label: key.replaceAll('_', ' '), required: false })),
  ];
  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <h3 className="text-sm font-semibold">Comparison specifications</h3>
        <p className="text-xs text-muted-foreground">
          Complete each standard field, or choose Not available. Include units. Shared catalogs show
          these values to participating dealerships.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={'spec-' + field.key}>
              {field.label}
              {field.required ? ' *' : ''}
            </Label>
            <Input
              id={'spec-' + field.key}
              required={field.required}
              maxLength={500}
              value={String(value[field.key] ?? '')}
              onChange={(e) => onChange({ ...value, [field.key]: e.target.value })}
              placeholder="Value with unit"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange({ ...value, [field.key]: 'NOT_AVAILABLE' })}
              >
                Not available
              </Button>
              {!field.required ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const next = { ...value };
                    delete next[field.key];
                    onChange(next);
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label="Custom specification name"
          placeholder="Custom field, e.g. Sunroof"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const key = name.trim().toLowerCase().replace(/\s+/g, '_');
            if (
              !key ||
              Object.hasOwn(value, key) ||
              standard.has(key) ||
              reserved.has(key) ||
              ['__proto__', 'constructor', 'prototype'].includes(key) ||
              fields.length >= 48
            ) {
              setError('Enter a unique specification name (maximum 50 fields).');
              return;
            }
            onChange({ ...value, [key]: '' });
            setName('');
            setError('');
          }}
        >
          Add field
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
