import { z } from "zod";

const key = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
const unit = z.enum(["kilometer", "mile"]);
const radius = z.number().finite().positive().max(1000);
const city = z
  .object({
    key,
    radius: radius.int().optional(),
    distance_unit: unit.optional(),
  })
  .strict()
  .refine(
    (v) => (v.radius === undefined) === (v.distance_unit === undefined),
    "radius_and_unit_required_together",
  );
const custom = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    radius,
    distance_unit: unit,
  })
  .strict();
// Radius eligibility and location-type combinations remain Meta validation decisions.
// Omitting a city radius sends the city key itself; no default radius is added here.
export const geoInput = z
  .object({
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(100)
      .optional(),
    cities: z.array(city).min(1).max(100).optional(),
    regions: z.array(z.object({ key }).strict()).min(1).max(100).optional(),
    custom_locations: z.array(custom).min(1).max(100).optional(),
    location_types: z
      .array(z.enum(["home", "recent", "travel_in", "frequently_in"]))
      .min(1)
      .max(4)
      .optional(),
  })
  .strict()
  .refine(
    (v) => !!(v.countries || v.cities || v.regions || v.custom_locations),
    "geography_required",
  );
export const automationInput = z
  .object({
    advantage_audience: z.union([z.literal(0), z.literal(1)]).optional(),
    individual_setting: z
      .object({ geo: z.union([z.literal(0), z.literal(1)]) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "automation_choice_required");
