/**
 * OpenAI LLM Provider — reference implementation of ILLMProvider.
 *
 * Token control strategy:
 * - Sends ONLY: current message, available capabilities, optional status summary.
 * - No conversation history.
 * - Requests JSON output.
 * - Uses gpt-4o-mini for cost efficiency.
 */

import OpenAI from 'openai';
import { ILLMProvider, LLMIntentResult, Capability } from '../core/types';
import { logger } from '../core/logger';

const COMPONENT = 'OpenAIProvider';

const SYSTEM_PROMPT = `Eres un clasificador de intenciones. Tu trabajo es analizar el mensaje del usuario y determinar qué acción quiere realizar.

REGLAS:
1. Responde SOLO con JSON válido.
2. Elige la acción más probable de la lista de capabilities disponibles.
3. Extrae parámetros del mensaje cuando sea posible.
4. Si no puedes determinar la acción con confianza, usa action: "unknown".
5. El campo "confidence" debe ser un número entre 0 y 1.
6. Sé conservador: es mejor decir "unknown" que elegir mal.

FORMATO DE RESPUESTA (JSON):
{
  "action": "nombre_de_la_accion",
  "params": { "clave": "valor" },
  "confidence": 0.85,
  "reasoning": "breve explicación"
}`;

export class OpenAIProvider implements ILLMProvider {
  readonly providerName = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = 'gpt-4o-mini') {
    if (!apiKey) {
      throw new Error('OpenAI API key is required.');
    }
    this.client = new OpenAI({ apiKey });
    this.model = model;
    logger.info(COMPONENT, `Initialized with model: ${this.model}`);
  }

  async classifyIntent(
    message: string,
    capabilities: Capability[],
    context?: string,
  ): Promise<LLMIntentResult> {
    // Build minimal capabilities description for the prompt
    const capList = capabilities.map(c => {
      const params = Object.entries(c.parameters)
        .map(([k, v]) => `${k}: ${v.type}${v.required ? ' (required)' : ''}`)
        .join(', ');
      return `- ${c.name}: ${c.description}${params ? ` | params: {${params}}` : ''}`;
    }).join('\n');

    const userPrompt = [
      `CAPABILITIES DISPONIBLES:\n${capList}`,
      context ? `\nCONTEXTO ACTUAL:\n${context}` : '',
      `\nMENSAJE DEL USUARIO:\n"${message}"`,
      '\nResponde con JSON:',
    ].filter(Boolean).join('\n');

    logger.debug(COMPONENT, 'Sending to LLM', {
      messageLength: message.length,
      capCount: capabilities.length,
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI.');
    }

    const parsed = JSON.parse(content) as LLMIntentResult;

    // Validate the parsed result
    if (!parsed.action || typeof parsed.confidence !== 'number') {
      throw new Error(`Invalid LLM response structure: ${content}`);
    }

    return {
      action: parsed.action,
      params: parsed.params ?? {},
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reasoning: parsed.reasoning,
    };
  }
}
