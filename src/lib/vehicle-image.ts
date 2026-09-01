const GRAPHITE_FAMILY_SUV_IMAGE = '/demo/vehicles/graphite-family-suv.png';
const ELECTRIC_COUPE_SUV_IMAGE = '/demo/vehicles/electric-coupe-suv.png';

/**
 * Local vehicle artwork used when a stock unit has no uploaded inventory image.
 * Real, signed object-storage images always take precedence at the call site.
 */
export function fallbackVehicleImage(modelName: string) {
  const model = modelName.toLowerCase();
  if (model.includes('harrier') || model.includes('safari') || model.includes('demo suv')) {
    return GRAPHITE_FAMILY_SUV_IMAGE;
  }

  return ELECTRIC_COUPE_SUV_IMAGE;
}
