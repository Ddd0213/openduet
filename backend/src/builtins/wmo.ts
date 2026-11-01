// WMO weather interpretation codes, model-facing words rather than UI phrases.
export const WMO: Readonly<Record<number, readonly [string, string]>> = {
  0: ["Clear sky", "晴"], 1: ["Mainly clear", "大部晴朗"], 2: ["Partly cloudy", "局部多云"], 3: ["Overcast", "阴"],
  45: ["Fog", "雾"], 48: ["Depositing rime fog", "雾凇"],
  51: ["Light drizzle", "小毛毛雨"], 53: ["Moderate drizzle", "中等毛毛雨"], 55: ["Dense drizzle", "浓毛毛雨"],
  56: ["Light freezing drizzle", "轻微冻毛毛雨"], 57: ["Dense freezing drizzle", "强冻毛毛雨"],
  61: ["Slight rain", "小雨"], 63: ["Moderate rain", "中雨"], 65: ["Heavy rain", "大雨"],
  66: ["Light freezing rain", "轻微冻雨"], 67: ["Heavy freezing rain", "强冻雨"],
  71: ["Slight snow", "小雪"], 73: ["Moderate snow", "中雪"], 75: ["Heavy snow", "大雪"], 77: ["Snow grains", "米雪"],
  80: ["Slight rain showers", "小阵雨"], 81: ["Moderate rain showers", "中等阵雨"], 82: ["Violent rain showers", "强阵雨"],
  85: ["Slight snow showers", "小阵雪"], 86: ["Heavy snow showers", "强阵雪"],
  95: ["Thunderstorm", "雷暴"], 96: ["Thunderstorm with slight hail", "雷暴伴小冰雹"], 99: ["Thunderstorm with heavy hail", "雷暴伴强冰雹"],
};
export function weatherWords(code: number | null, language: string): string {
  const index = language === "zh-Hans" ? 1 : 0;
  return (code === null ? undefined : WMO[code]?.[index]) ?? (index ? "天气状况未知" : "Unknown weather conditions");
}
