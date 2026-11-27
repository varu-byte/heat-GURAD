import { GoogleGenAI, Type } from '@google/genai';
import { AlertDirection, HeatTrend, RiskLevel } from '../src/types';

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return geminiClient;
}

export interface AiEscalationAnalysis {
  aiAvailable: boolean;
  riskRationale: string;
  safetyInstructions: string;
  adminRecommendation: string;
  model?: string;
  error?: string;
}

export interface EscalationContextInput {
  locationName: string;
  previousRisk: RiskLevel;
  currentRisk: RiskLevel;
  direction: AlertDirection;
  airTemp: number;
  humidity: number;
  heatIndex: number;
  forecastPeakHeatIndex: number;
  trend: HeatTrend;
}

/**
 * Generates rule-grounded life-safety instructions (non-AI deterministic protocol)
 * used as notification content when Gemini is disabled or offline.
 */
export function buildDeterministicSafetyProtocol(input: EscalationContextInput): string {
  const { locationName, previousRisk, currentRisk, direction, airTemp, humidity, heatIndex, trend } = input;

  if (direction === 'de-escalation' || direction === 'recovery') {
    if (currentRisk === 'low') {
      return `${locationName}: Verified thermal cooling observed (Feels Like ${heatIndex.toFixed(1)}°C, Air ${airTemp}°C, RH ${humidity}%, trend ${trend}; down from ${previousRisk.toUpperCase()}). Risk reduced below 32°C threshold. Continue regular hydration and monitor sun exposure.`;
    }
    return `${locationName}: Thermal strain easing from ${previousRisk.toUpperCase()} to ${currentRisk.toUpperCase()} (Feels Like ${heatIndex.toFixed(1)}°C, Air ${airTemp}°C, trend ${trend}). Conditions remain elevated — maintain shade breaks and ORS hydration.`;
  }

  switch (currentRisk) {
    case 'extreme':
      return `CRITICAL HEAT ALERT (${locationName}): Feels Like ${heatIndex.toFixed(1)}°C (Air ${airTemp}°C, RH ${humidity}%, trend ${trend}). Halt heavy outdoor work between 12:00–16:00, move to cooling shelter immediately, hydrate with ORS/water every 15 mins, and call 108 for heat stroke symptoms.`;
    case 'high':
      return `HIGH HEAT WARNING (${locationName}): Feels Like ${heatIndex.toFixed(1)}°C (Air ${airTemp}°C, RH ${humidity}%, trend ${trend}). Mandatory 15-min shaded rest every hour and electrolyte hydration every 20 mins.`;
    case 'moderate':
      return `MODERATE HEAT ADVISORY (${locationName}): Feels Like ${heatIndex.toFixed(1)}°C (Air ${airTemp}°C, RH ${humidity}%, trend ${trend}). Drink cool water every 30 mins and schedule shaded micro-breaks.`;
    default:
      return `${locationName}: Routine monitoring (Feels Like ${heatIndex.toFixed(1)}°C, Air ${airTemp}°C, RH ${humidity}%). Maintain regular hydration.`;
  }
}

/**
 * Calls server-side Gemini 4 Hydrogen model to analyze thermal escalation trends
 * and draft tailored worker/administrator guidance.
 */
export async function generateAiEscalationAnalysis(
  input: EscalationContextInput
): Promise<AiEscalationAnalysis> {
  const ai = getGeminiClient();
  const fallbackInstructions = buildDeterministicSafetyProtocol(input);

  if (!ai) {
    return {
      aiAvailable: false,
      riskRationale: `Measured Heat Index ${input.heatIndex.toFixed(1)}°C with ${input.trend} 3-hour forecast trend (peak ${input.forecastPeakHeatIndex.toFixed(1)}°C).`,
      safetyInstructions: fallbackInstructions,
      adminRecommendation: 'Configure GEMINI_API_KEY in server secrets for AI-generated situational briefings.',
      error: 'GEMINI_API_KEY is not configured in server environment.',
    };
  }

  const prompt = `Analyze this live heat-risk event for Greater Chennai Corporation / Tamil Nadu worker safety operations:
Location: ${input.locationName}
Transition: ${input.previousRisk.toUpperCase()} -> ${input.currentRisk.toUpperCase()} (${input.direction})
Current Air Temperature: ${input.airTemp}°C
Relative Humidity: ${input.humidity}%
Current Rothfusz Feels-Like Heat Index: ${input.heatIndex.toFixed(1)}°C
Next 3-Hour Forecast Peak Heat Index: ${input.forecastPeakHeatIndex.toFixed(1)}°C
Heat Risk Trend: ${input.trend}

Rules:
- Be concise, factual, and operational.
- If risk decreased (de-escalation or recovery), cite the observed Heat Index and temperature drop explicitly and NEVER describe conditions as "completely safe".
- Tailor safetyInstructions for outdoor manual workers (hydration, shade breaks, 108 emergency check if extreme).`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'You are an emergency occupational heat safety analyst. Respond strictly with valid JSON matching the requested schema.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            riskRationale: {
              type: Type.STRING,
              description: '1-2 sentence meteorological rationale referencing temperature, humidity, heat index, and forecast trend.',
            },
            safetyInstructions: {
              type: Type.STRING,
              description: 'Clear 2-3 sentence protective instructions suitable for SMS and push alert body.',
            },
            adminRecommendation: {
              type: Type.STRING,
              description: '1 sentence operational directive for municipal coordinators (cooling shelters, water tankers, midday pause).',
            },
          },
          required: ['riskRationale', 'safetyInstructions', 'adminRecommendation'],
        },
      },
    });

    const parsed = JSON.parse((response.text || '{}').trim());
    return {
      aiAvailable: true,
      model: 'gemini-4-hydrogen',
      riskRationale: parsed.riskRationale || `Heat Index ${input.heatIndex.toFixed(1)}°C (${input.trend} trend).`,
      safetyInstructions: parsed.safetyInstructions || fallbackInstructions,
      adminRecommendation: parsed.adminRecommendation || 'Monitor field relief stations and hydration logs.',
    };
  } catch (err: any) {
    console.warn('Gemini AI analysis call failed:', err?.message || err);
    return {
      aiAvailable: false,
      riskRationale: `Heat Index ${input.heatIndex.toFixed(1)}°C (${input.trend} trend).`,
      safetyInstructions: fallbackInstructions,
      adminRecommendation: 'AI briefing temporarily unavailable; deterministic heat-safety protocol active.',
      error: err?.message || 'Gemini API request failed',
    };
  }
}
