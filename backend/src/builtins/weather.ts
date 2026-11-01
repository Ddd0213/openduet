import { z } from "zod";
import { FAHRENHEIT_REGIONS, WEATHER_MAX_DAYS } from "../contract/m25.ts";
import { serviceJson, WebError, withDeadline, type HttpDeps } from "../web/http.ts";
import type { BuiltinConfig } from "./config.ts";
import { runBuiltin } from "./state.ts";
import { weatherWords } from "./wmo.ts";

export const WeatherInput = z.object({ place: z.string().trim().min(1).max(200), days: z.number().int().min(1).max(WEATHER_MAX_DAYS).default(3), unit: z.enum(["celsius", "fahrenheit"]).optional() }).strict();
const Place = z.object({ name: z.string(), admin1: z.string().optional().default(""), country: z.string().optional().default(""), country_code: z.string().optional().default(""), population: z.number().nullish(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), timezone: z.string().min(1) });
const Locations = z.object({ results: z.array(Place).optional().default([]) });
const num = z.number().nullable();
const Forecast = z.object({
  current: z.object({ time: z.string(), temperature_2m: num, apparent_temperature: num, weather_code: num, wind_speed_10m: num, precipitation: num }),
  daily: z.object({ time: z.array(z.string()), weather_code: z.array(num), temperature_2m_max: z.array(num), temperature_2m_min: z.array(num), precipitation_probability_max: z.array(num), precipitation_sum: z.array(num) }),
}).superRefine(({ daily }, ctx) => {
  if (Object.values(daily).some(a => a.length !== daily.time.length)) ctx.addIssue({ code: "custom", message: "Inconsistent forecast arrays" });
});
export const WEATHER_ATTRIBUTION = "Weather data by Open-Meteo.com";
/** A city (100,000+ people) 10x larger than every other same-name match is the one meant:
 * Hangzhou over a village of that name, London over London, Ontario. A missing population
 * counts as 0. A city of that name in the user's own country still gets the question
 * (a Canadian asking for London). */
const DOMINANT_RATIO = 10, CITY_POPULATION = 100_000;
function dominant(places: z.infer<typeof Place>[], region: string | undefined) {
  const pop = (p: z.infer<typeof Place>) => p.population ?? 0;
  const [top, ...rest] = [...places].sort((a, b) => pop(b) - pop(a));
  if (!top || pop(top) < CITY_POPULATION || rest.some(p => pop(p) * DOMINANT_RATIO > pop(top))) return undefined;
  const local = (p: z.infer<typeof Place>) => !!region && p.country_code.toUpperCase() === region;
  return !local(top) && rest.some(p => local(p) && pop(p) >= CITY_POPULATION) ? undefined : top;
}
const placeResult = (p: z.infer<typeof Place>) => ({ name: p.name, admin: p.admin1, country: p.country, latitude: p.latitude, longitude: p.longitude, timezone: p.timezone });

/** Config accepts a base host or a full endpoint (for a self-run Open-Meteo). */
function endpoint(value: string | undefined, host: string, path: string, key?: string): URL {
  const url = new URL(value || host);
  if (url.pathname === "/") url.pathname = path;
  if (key) url.searchParams.set("apikey", key);
  return url;
}

export async function weather(raw: unknown, profile: { language: string; region: string | null }, config: BuiltinConfig, deps: HttpDeps = {}) {
  const input = WeatherInput.safeParse(raw);
  if (!input.success) return { isError: true as const, error: "Invalid weather arguments" };
  return runBuiltin("weather", config, () => withDeadline(deps.signal, async signal => {
    const { place, days } = input.data;
    const region = profile.region?.toUpperCase();
    const unit = input.data.unit ?? (region && FAHRENHEIT_REGIONS.includes(region) ? "fahrenheit" : "celsius");
    const geo = endpoint(config.OPEN_METEO_GEOCODING_URL, "https://geocoding-api.open-meteo.com", "/v1/search", config.OPEN_METEO_API_KEY);
    geo.searchParams.set("name", place); geo.searchParams.set("count", "10"); geo.searchParams.set("language", profile.language === "zh-Hans" ? "zh" : "en");
    const matches = Locations.parse(await serviceJson(geo, deps, signal)).results.sort((a, b) => Number(b.country_code.toUpperCase() === region) - Number(a.country_code.toUpperCase() === region));
    const first = matches[0];
    if (!first) throw new WebError("No matching place found. Ask the user for a city and country.");
    const sameName = matches.filter(p => p.name.toLocaleLowerCase() === first.name.toLocaleLowerCase());
    const unique = sameName.filter((p, i) => sameName.findIndex(q => q.latitude === p.latitude && q.longitude === p.longitude) === i);
    const chosen = unique.length > 1 ? dominant(unique, region) : first;
    if (!chosen) return { ambiguous: true as const, places: unique.slice(0, 3).map(placeResult), note: "These are different places with the same name. Ask the user which place they mean before requesting a forecast." };
    const url = endpoint(config.OPEN_METEO_URL, "https://api.open-meteo.com", "/v1/forecast", config.OPEN_METEO_API_KEY);
    for (const [key, value] of Object.entries({ latitude: chosen.latitude, longitude: chosen.longitude, timezone: chosen.timezone, forecast_days: days, temperature_unit: unit, wind_speed_unit: unit === "fahrenheit" ? "mph" : "kmh", precipitation_unit: "mm", current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation", daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum" })) url.searchParams.set(key, String(value));
    const { current: c, daily: d } = Forecast.parse(await serviceJson(url, deps, signal));
    return {
      place: placeResult(chosen), unit,
      current: { time: c.time, temperature: c.temperature_2m, apparentTemperature: c.apparent_temperature, weather: weatherWords(c.weather_code, profile.language), windSpeed: c.wind_speed_10m, precipitation: c.precipitation },
      daily: d.time.slice(0, days).map((date, i) => ({ date, weather: weatherWords(d.weather_code[i]!, profile.language), high: d.temperature_2m_max[i]!, low: d.temperature_2m_min[i]!, precipitationChance: d.precipitation_probability_max[i]!, precipitation: d.precipitation_sum[i]! })),
      attribution: WEATHER_ATTRIBUTION,
    };
  }));
}
