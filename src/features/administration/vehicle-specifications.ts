import { z } from 'zod';

export const standardVehicleSpecifications = [
  ['battery_capacity', 'Battery capacity'],
  ['fast_charging', 'Fast charging'],
  ['power', 'Power (include unit)'],
  ['range', 'Range / mileage (include unit)'],
  ['torque', 'Torque (include unit)'],
  ['warranty', 'Warranty'],
] as const;
export const vehicleSpecificationsSchema = z
  .record(z.string().trim().min(1).max(80), z.unknown())
  .superRefine((value, ctx) => {
    for (const [key, label] of standardVehicleSpecifications) {
      if (typeof value[key] !== 'string' || !value[key].trim())
        ctx.addIssue({
          code: 'custom',
          message: `${label}: enter a value or select Not available.`,
          path: [key],
        });
    }
    if (Object.keys(value).length > 50)
      ctx.addIssue({ code: 'custom', message: 'Use at most 50 specification fields.' });
  });
